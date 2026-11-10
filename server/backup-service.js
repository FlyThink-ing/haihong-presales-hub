import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { initializeBackupStatusStore, runBackupWithStatus, safeBackupErrorCode } from "./backup-status-service.js";

export const BACKUP_MANIFEST_SCHEMA_VERSION = 1;

const backupLocks = new Set();
const schedulers = new WeakMap();
const REFERENCE_TABLES = ["stored_files", "contract_templates", "contract_files"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function ensure(condition, code, message) {
  if (!condition) fail(code, message);
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  const suffix = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.resolve(base, ...suffix);
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isSameOrInside(left, right) || isSameOrInside(right, left);
}

function normalizeRelative(value, code = "BACKUP_STORAGE_KEY_INVALID") {
  const input = String(value || "").replaceAll("\\", "/");
  ensure(input && !input.startsWith("/") && !/^[a-zA-Z]:/.test(input), code, "备份文件路径必须是安全的相对路径");
  const segments = input.split("/");
  ensure(segments.every(segment => segment && segment !== "." && segment !== ".."), code, "备份文件路径包含非法目录段");
  return segments.join("/");
}

function ensureNotEnvironmentFile(relativePath) {
  const hasEnvironmentFile = normalizeRelative(relativePath).split("/").some(segment => /^\.env(?:\.|$)/i.test(segment));
  ensure(!hasEnvironmentFile, "BACKUP_ENV_FILE_FORBIDDEN", "备份内容禁止包含 .env 配置文件");
}

function safeJoin(root, relativePath) {
  const normalized = normalizeRelative(relativePath, "BACKUP_RELATIVE_PATH_INVALID");
  const absolute = path.resolve(root, ...normalized.split("/"));
  ensure(isSameOrInside(absolute, root) && absolute !== canonicalPath(root), "BACKUP_RELATIVE_PATH_INVALID", "备份相对路径越界");
  return absolute;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filename);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function backupBatchId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  return `backup-${stamp}-${randomUUID().slice(0, 8)}`;
}

function validateBackupLocation({ databasePath, storagePath, backupPath }) {
  const databaseDirectory = path.dirname(canonicalPath(databasePath));
  const storageRoot = canonicalPath(storagePath);
  const backupRoot = canonicalPath(backupPath);
  ensure(!pathsOverlap(backupRoot, databaseDirectory), "BACKUP_PATH_DATABASE_OVERLAP", "备份目录不得位于数据库目录内部，也不得包含数据库目录");
  ensure(!pathsOverlap(backupRoot, storageRoot), "BACKUP_PATH_STORAGE_OVERLAP", "备份目录不得位于 storage 目录内部，也不得包含 storage 目录");
  return backupRoot;
}

function openSnapshot(filename) {
  try {
    return new Database(filename, { readonly: true, fileMustExist: true });
  } catch (error) {
    fail("BACKUP_DATABASE_OPEN_FAILED", `备份数据库无法打开：${error.message}`);
  }
}

function verifyDatabase(filename) {
  const database = openSnapshot(filename);
  try {
    const quickCheck = database.pragma("quick_check");
    ensure(quickCheck.length > 0 && quickCheck.every(row => row.quick_check === "ok"), "BACKUP_DATABASE_INTEGRITY_FAILED", "备份数据库 quick_check 未通过");
    const foreignKeyErrors = database.pragma("foreign_key_check");
    ensure(foreignKeyErrors.length === 0, "BACKUP_DATABASE_FOREIGN_KEY_FAILED", "备份数据库存在外键异常");
    return { quickCheck: "ok", foreignKeyErrors: 0 };
  } finally {
    database.close();
  }
}

function finalizeSnapshotDatabase(filename) {
  const database = new Database(filename, { fileMustExist: true });
  try {
    database.pragma("journal_mode = DELETE");
  } finally {
    database.close();
  }
  fs.rmSync(`${filename}-wal`, { force: true });
  fs.rmSync(`${filename}-shm`, { force: true });
}

function referencedStorageFiles(databaseFilename) {
  const database = openSnapshot(databaseFilename);
  try {
    const references = new Map();
    for (const table of REFERENCE_TABLES) {
      const rows = database.prepare(`SELECT storage_key, size_bytes, sha256 FROM ${table} WHERE storage_key IS NOT NULL AND TRIM(storage_key) <> ''`).all();
      for (const row of rows) {
        const storageKey = normalizeRelative(row.storage_key);
        ensureNotEnvironmentFile(storageKey);
        const existing = references.get(storageKey);
        if (existing) {
          if (existing.expectedSha256 && row.sha256 && existing.expectedSha256 !== row.sha256) fail("BACKUP_FILE_METADATA_CONFLICT", `归档文件 ${storageKey} 存在冲突的摘要记录`);
          if (existing.expectedSizeBytes > 0 && row.size_bytes > 0 && existing.expectedSizeBytes !== row.size_bytes) fail("BACKUP_FILE_METADATA_CONFLICT", `归档文件 ${storageKey} 存在冲突的大小记录`);
          existing.referenceTypes.add(table);
          continue;
        }
        references.set(storageKey, {
          storageKey,
          expectedSizeBytes: Number(row.size_bytes) || 0,
          expectedSha256: /^[a-f0-9]{64}$/i.test(String(row.sha256 || "")) ? String(row.sha256).toLowerCase() : null,
          referenceTypes: new Set([table])
        });
      }
    }
    return references;
  } finally {
    database.close();
  }
}

function walkFiles(root, relativePrefix = "") {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    ensure(!entry.isSymbolicLink(), "BACKUP_SOURCE_SYMLINK_FORBIDDEN", `备份源不允许符号链接：${relative}`);
    if (entry.isDirectory()) result.push(...walkFiles(absolute, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

async function copySnapshotFiles({ databaseFilename, storagePath, destinationRoot }) {
  const references = referencedStorageFiles(databaseFilename);
  const sources = new Map();
  for (const reference of references.values()) {
    sources.set(reference.storageKey, {
      relativePath: reference.storageKey,
      expectedSizeBytes: reference.expectedSizeBytes,
      expectedSha256: reference.expectedSha256,
      referenceTypes: [...reference.referenceTypes].sort()
    });
  }
  const mapRoot = path.resolve(storagePath, "maps");
  for (const mapRelative of walkFiles(mapRoot, "maps")) {
    ensureNotEnvironmentFile(mapRelative);
    const existing = sources.get(mapRelative);
    if (existing) existing.referenceTypes = [...new Set([...existing.referenceTypes, "storage/maps"])].sort();
    else sources.set(mapRelative, { relativePath: mapRelative, expectedSizeBytes: 0, expectedSha256: null, referenceTypes: ["storage/maps"] });
  }

  const files = [];
  for (const source of [...sources.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const sourcePath = safeJoin(storagePath, source.relativePath);
    ensure(fs.existsSync(sourcePath), "BACKUP_REFERENCED_FILE_MISSING", `数据库引用的归档文件缺失：${source.relativePath}`);
    const stat = fs.lstatSync(sourcePath);
    ensure(stat.isFile() && !stat.isSymbolicLink(), "BACKUP_REFERENCED_FILE_INVALID", `归档路径不是普通文件：${source.relativePath}`);
    const manifestPath = `storage/${source.relativePath}`;
    const destination = safeJoin(destinationRoot, manifestPath);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(sourcePath, destination, fs.constants.COPYFILE_EXCL);
    const copiedStat = await fsp.stat(destination);
    const copiedSha256 = await sha256File(destination);
    if (source.expectedSizeBytes > 0) ensure(copiedStat.size === source.expectedSizeBytes, "BACKUP_REFERENCED_FILE_SIZE_MISMATCH", `归档文件大小与数据库记录不一致：${source.relativePath}`);
    if (source.expectedSha256) ensure(copiedSha256 === source.expectedSha256, "BACKUP_REFERENCED_FILE_SHA_MISMATCH", `归档文件摘要与数据库记录不一致：${source.relativePath}`);
    files.push({ path: manifestPath, sizeBytes: copiedStat.size, sha256: copiedSha256, referenceTypes: source.referenceTypes });
  }
  return { files, referencedFileCount: references.size };
}

function parseManifest(batchPath) {
  const manifestPath = path.join(batchPath, "manifest.json");
  ensure(fs.existsSync(manifestPath), "BACKUP_MANIFEST_MISSING", "备份批次缺少 manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail("BACKUP_MANIFEST_INVALID", "备份 manifest.json 不是有效 JSON");
  }
}

function validateManifestShape(manifest) {
  ensure(manifest?.schemaVersion === BACKUP_MANIFEST_SCHEMA_VERSION, "BACKUP_MANIFEST_SCHEMA_UNSUPPORTED", "备份清单版本不受支持");
  ensure(/^backup-[A-Za-z0-9-]+$/.test(String(manifest.batchId || "")), "BACKUP_MANIFEST_INVALID", "备份批次号无效");
  ensure(manifest.status === "COMPLETE" && manifest.validation?.completed === true, "BACKUP_BATCH_INCOMPLETE", "备份批次未完成验证");
  ensure(typeof manifest.generatedAt === "string" && !Number.isNaN(Date.parse(manifest.generatedAt)), "BACKUP_MANIFEST_INVALID", "备份生成时间无效");
  ensure(typeof manifest.reason === "string" && manifest.reason.trim(), "BACKUP_MANIFEST_INVALID", "备份原因缺失");
  ensure(manifest.database?.path === "database.sqlite3", "BACKUP_MANIFEST_INVALID", "备份数据库相对路径无效");
  ensure(Number.isSafeInteger(manifest.database?.sizeBytes) && manifest.database.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(manifest.database.sha256), "BACKUP_MANIFEST_INVALID", "备份数据库摘要信息无效");
  ensure(Array.isArray(manifest.files), "BACKUP_MANIFEST_INVALID", "备份文件清单无效");
}

async function verifyManifestFiles(batchPath, manifest) {
  const expectedPaths = new Set(["manifest.json", manifest.database.path]);
  const databasePath = safeJoin(batchPath, manifest.database.path);
  ensure(fs.existsSync(databasePath), "BACKUP_DATABASE_MISSING", "备份数据库文件缺失");
  const databaseStat = await fsp.stat(databasePath);
  ensure(databaseStat.isFile() && databaseStat.size === manifest.database.sizeBytes, "BACKUP_DATABASE_SIZE_MISMATCH", "备份数据库文件大小与清单不一致");
  ensure(await sha256File(databasePath) === manifest.database.sha256, "BACKUP_DATABASE_SHA_MISMATCH", "备份数据库摘要与清单不一致");

  for (const item of manifest.files) {
    const relative = normalizeRelative(item?.path, "BACKUP_MANIFEST_FILE_INVALID");
    ensure(relative.startsWith("storage/"), "BACKUP_MANIFEST_FILE_INVALID", "备份业务文件必须位于 storage 相对目录");
    ensureNotEnvironmentFile(relative);
    ensure(!expectedPaths.has(relative), "BACKUP_MANIFEST_FILE_DUPLICATE", `备份清单存在重复文件：${relative}`);
    ensure(Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 && /^[a-f0-9]{64}$/.test(String(item.sha256 || "")), "BACKUP_MANIFEST_FILE_INVALID", `备份文件摘要信息无效：${relative}`);
    expectedPaths.add(relative);
    const absolute = safeJoin(batchPath, relative);
    ensure(fs.existsSync(absolute), "BACKUP_FILE_MISSING", `备份文件缺失：${relative}`);
    const stat = await fsp.stat(absolute);
    ensure(stat.isFile() && stat.size === item.sizeBytes, "BACKUP_FILE_SIZE_MISMATCH", `备份文件大小与清单不一致：${relative}`);
    ensure(await sha256File(absolute) === item.sha256, "BACKUP_FILE_SHA_MISMATCH", `备份文件摘要与清单不一致：${relative}`);
  }

  const actualPaths = walkFiles(batchPath).map(item => normalizeRelative(item)).sort();
  const expected = [...expectedPaths].sort();
  ensure(actualPaths.length === expected.length && actualPaths.every((item, index) => item === expected[index]), "BACKUP_UNMANIFESTED_FILE", "备份批次包含未登记文件或清单登记不完整");
  return databasePath;
}

export async function verifyBackupBatch(batchPath, options = {}) {
  const absoluteBatchPath = canonicalPath(batchPath);
  ensure(fs.existsSync(absoluteBatchPath) && fs.statSync(absoluteBatchPath).isDirectory(), "BACKUP_BATCH_NOT_FOUND", "备份批次目录不存在");
  if (!options.allowPartial) ensure(!path.basename(absoluteBatchPath).startsWith(".partial-"), "BACKUP_BATCH_INCOMPLETE", "临时备份目录不能用于恢复");
  const manifest = parseManifest(absoluteBatchPath);
  validateManifestShape(manifest);
  const databasePath = await verifyManifestFiles(absoluteBatchPath, manifest);
  const databaseValidation = verifyDatabase(databasePath);
  const referenced = referencedStorageFiles(databasePath);
  const manifestFiles = new Map(manifest.files.map(item => [normalizeRelative(item.path).slice("storage/".length), item]));
  for (const reference of referenced.values()) {
    const item = manifestFiles.get(reference.storageKey);
    ensure(item, "BACKUP_REFERENCED_FILE_NOT_LISTED", `备份清单遗漏数据库引用文件：${reference.storageKey}`);
    if (reference.expectedSizeBytes > 0) ensure(item.sizeBytes === reference.expectedSizeBytes, "BACKUP_REFERENCED_FILE_SIZE_MISMATCH", `备份清单大小与数据库记录不一致：${reference.storageKey}`);
    if (reference.expectedSha256) ensure(item.sha256 === reference.expectedSha256, "BACKUP_REFERENCED_FILE_SHA_MISMATCH", `备份清单摘要与数据库记录不一致：${reference.storageKey}`);
  }
  return {
    batchId: manifest.batchId,
    manifest,
    validation: { ...databaseValidation, filesVerified: manifest.files.length, referencedFiles: referenced.size }
  };
}

export async function createBackup({ db, databasePath, storagePath, backupPath, reason = "手工备份", now = new Date() }) {
  ensure(db?.open, "BACKUP_DATABASE_CLOSED", "数据库未打开，无法执行在线备份");
  const backupRoot = validateBackupLocation({ databasePath, storagePath, backupPath });
  const normalizedReason = String(reason || "").trim();
  ensure(normalizedReason && normalizedReason.length <= 200 && !/[\r\n]/.test(normalizedReason), "BACKUP_REASON_INVALID", "备份原因必须为 1 至 200 字且不能换行");
  ensure(!/(?:password|token|api[_-]?key|secret|\.env)/i.test(normalizedReason) && !/(?:[a-zA-Z]:[\\/]|\\\\)/.test(normalizedReason), "BACKUP_REASON_SENSITIVE", "备份原因不得包含密钥字段或服务器绝对路径");
  const lockKey = `${canonicalPath(databasePath)}|${backupRoot}`.toLowerCase();
  ensure(!backupLocks.has(lockKey), "BACKUP_IN_PROGRESS", "当前进程已有备份任务正在执行");
  backupLocks.add(lockKey);

  const batchId = backupBatchId(now);
  const partialPath = path.join(backupRoot, `.partial-${randomUUID()}`);
  const finalPath = path.join(backupRoot, batchId);
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.mkdirSync(partialPath, { recursive: false });
    const databaseBackupPath = path.join(partialPath, "database.sqlite3");
    await db.backup(databaseBackupPath);
    finalizeSnapshotDatabase(databaseBackupPath);
    const databaseValidation = verifyDatabase(databaseBackupPath);
    const databaseStat = fs.statSync(databaseBackupPath);
    const databaseSha256 = await sha256File(databaseBackupPath);
    const copied = await copySnapshotFiles({ databaseFilename: databaseBackupPath, storagePath, destinationRoot: partialPath });
    const generatedAt = now.toISOString();
    const manifest = {
      schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      batchId,
      status: "COMPLETE",
      generatedAt,
      reason: normalizedReason,
      database: { path: "database.sqlite3", sizeBytes: databaseStat.size, sha256: databaseSha256 },
      files: copied.files,
      validation: {
        databaseReadable: true,
        quickCheck: databaseValidation.quickCheck,
        foreignKeyErrors: databaseValidation.foreignKeyErrors,
        referencedFiles: copied.referencedFileCount,
        filesVerified: copied.files.length,
        completed: true
      }
    };
    fs.writeFileSync(path.join(partialPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await verifyBackupBatch(partialPath, { allowPartial: true });
    ensure(!fs.existsSync(finalPath), "BACKUP_BATCH_EXISTS", "同名备份批次已存在");
    fs.renameSync(partialPath, finalPath);
    return { batchId, batchPath: finalPath, manifest };
  } catch (error) {
    fs.rmSync(partialPath, { recursive: true, force: true });
    throw error;
  } finally {
    backupLocks.delete(lockKey);
  }
}

function validateRestoreTarget({ targetPath, databasePath, storagePath, backupPath, batchPath }) {
  const target = canonicalPath(targetPath);
  ensure(target !== path.parse(target).root, "RESTORE_TARGET_DANGEROUS", "恢复目标不能是磁盘根目录");
  const forbidden = [path.dirname(canonicalPath(databasePath)), canonicalPath(storagePath), canonicalPath(backupPath), canonicalPath(batchPath)];
  ensure(forbidden.every(item => !pathsOverlap(target, item)), "RESTORE_TARGET_DANGEROUS", "恢复目标与正式数据库、正式 storage 或备份源存在路径重叠");
  if (fs.existsSync(target)) {
    ensure(fs.statSync(target).isDirectory(), "RESTORE_TARGET_NOT_DIRECTORY", "恢复目标必须是目录");
    ensure(fs.readdirSync(target).length === 0, "RESTORE_TARGET_NOT_EMPTY", "恢复目标已存在且非空，禁止覆盖");
  }
  return target;
}

async function copyRestoredFiles(batchPath, stagingPath, manifest) {
  const restoredDatabasePath = path.join(stagingPath, "data", "presales-hub.db");
  await fsp.mkdir(path.dirname(restoredDatabasePath), { recursive: true });
  await fsp.copyFile(safeJoin(batchPath, manifest.database.path), restoredDatabasePath, fs.constants.COPYFILE_EXCL);
  for (const item of manifest.files) {
    const source = safeJoin(batchPath, item.path);
    const storageRelative = normalizeRelative(item.path).slice("storage/".length);
    const destination = safeJoin(path.join(stagingPath, "storage"), storageRelative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
  return restoredDatabasePath;
}

async function verifyRestoredTarget(targetPath, manifest) {
  const databasePath = path.join(targetPath, "data", "presales-hub.db");
  const databaseStat = await fsp.stat(databasePath);
  ensure(databaseStat.size === manifest.database.sizeBytes && await sha256File(databasePath) === manifest.database.sha256, "RESTORE_DATABASE_VERIFY_FAILED", "恢复后的数据库摘要校验失败");
  const databaseValidation = verifyDatabase(databasePath);
  for (const item of manifest.files) {
    const storageRelative = normalizeRelative(item.path).slice("storage/".length);
    const absolute = safeJoin(path.join(targetPath, "storage"), storageRelative);
    ensure(fs.existsSync(absolute), "RESTORE_FILE_MISSING", `恢复后的归档文件缺失：${storageRelative}`);
    const stat = await fsp.stat(absolute);
    ensure(stat.size === item.sizeBytes && await sha256File(absolute) === item.sha256, "RESTORE_FILE_VERIFY_FAILED", `恢复后的归档文件校验失败：${storageRelative}`);
  }
  return { ...databaseValidation, filesVerified: manifest.files.length };
}

export async function restoreBackup({ batchPath, targetPath, databasePath, storagePath, backupPath }) {
  const absoluteBatchPath = canonicalPath(batchPath);
  const target = validateRestoreTarget({ targetPath, databasePath, storagePath, backupPath, batchPath: absoluteBatchPath });
  const verified = await verifyBackupBatch(absoluteBatchPath);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const stagingPath = path.join(parent, `.restore-partial-${randomUUID()}`);
  let published = false;
  try {
    fs.mkdirSync(stagingPath, { recursive: false });
    await copyRestoredFiles(absoluteBatchPath, stagingPath, verified.manifest);
    await verifyRestoredTarget(stagingPath, verified.manifest);
    if (fs.existsSync(target)) {
      ensure(fs.readdirSync(target).length === 0, "RESTORE_TARGET_NOT_EMPTY", "恢复目标在执行期间变为非空，禁止覆盖");
      fs.rmdirSync(target);
    }
    fs.renameSync(stagingPath, target);
    published = true;
    const validation = await verifyRestoredTarget(target, verified.manifest);
    return {
      batchId: verified.batchId,
      targetPath: target,
      databasePath: path.join(target, "data", "presales-hub.db"),
      storagePath: path.join(target, "storage"),
      validation
    };
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    if (published) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function nextLocalRun(now, hour) {
  const runAt = new Date(now.getTime());
  runAt.setHours(hour, 0, 0, 0);
  if (runAt <= now) runAt.setDate(runAt.getDate() + 1);
  return runAt;
}

export function startDailyBackupScheduler({
  db,
  config,
  logger = console,
  clock = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  backupRunner = createBackup,
  statusStore = null
}) {
  const existing = schedulers.get(db);
  if (existing) return existing;
  let timer = null;
  let stopped = false;
  const store = () => statusStore || initializeBackupStatusStore(db, { clock });
  const recordScheduler = value => {
    try { store().setScheduler(value); } catch (error) {
      logger.error(`备份调度状态记录失败 [${safeBackupErrorCode(error, "BACKUP_STATUS_WRITE_FAILED")}]；状态不确定，请联系运维核验`);
    }
  };
  const controller = {
    nextRunAt: null,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      controller.nextRunAt = null;
      recordScheduler({ status: "STOPPED" });
      if (schedulers.get(db) === controller) schedulers.delete(db);
    }
  };
  const schedule = () => {
    if (stopped) return;
    const now = clock();
    const next = nextLocalRun(now, config.backupHour);
    controller.nextRunAt = next.toISOString();
    const run = async () => {
      if (stopped) return;
      controller.nextRunAt = null;
      recordScheduler({ status: "RUNNING" });
      try {
        const result = await runBackupWithStatus({
          db, kind: "AUTOMATIC", statusStore: store(),
          backup: () => backupRunner({
            db, databasePath: config.databasePath, storagePath: config.storagePath,
            backupPath: config.backupPath, reason: "每日自动备份"
          })
        });
        logger.log(`每日备份完成：批次 ${result.batchId}`);
      } catch (error) {
        logger.error(`每日备份未确认成功 [${safeBackupErrorCode(error)}]；业务服务继续运行，请联系运维核验`);
      } finally {
        if (!stopped) schedule();
      }
    };
    try {
      timer = setTimer(run, Math.max(1, next.getTime() - now.getTime()));
      timer.unref?.();
      recordScheduler({ status: "SCHEDULED", nextRunAt: controller.nextRunAt });
    } catch (error) {
      controller.nextRunAt = null;
      recordScheduler({ status: "FAILED", error });
      logger.error(`每日备份调度失败 [${safeBackupErrorCode(error, "BACKUP_SCHEDULER_FAILED")}]；业务服务继续运行`);
      try {
        timer = setTimer(schedule, 60_000);
        timer.unref?.();
      } catch (retryError) {
        logger.error(`每日备份调度重试未能安排 [${safeBackupErrorCode(retryError, "BACKUP_SCHEDULER_FAILED")}]；请联系运维核验`);
      }
    }
  };
  schedulers.set(db, controller);
  schedule();
  return controller;
}
