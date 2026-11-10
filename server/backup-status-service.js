import { randomUUID } from "node:crypto";
import { AppError, assert, ROLES } from "./domain.js";

const runtimeId = randomUUID();
const stores = new WeakMap();
const RUN_KINDS = ["MANUAL", "AUTOMATIC"];
const SCHEDULER_STATES = ["SCHEDULED", "RUNNING", "STOPPED", "FAILED"];
const SAFE_ERROR_CODES = new Set([
  "BACKUP_FAILED", "BACKUP_SCHEDULER_FAILED", "BACKUP_STATUS_WRITE_FAILED", "BACKUP_STATUS_READ_FAILED", "BACKUP_STATUS_UNAVAILABLE",
  "BACKUP_RESULT_INVALID", "BACKUP_RUN_STATE_INVALID", "BACKUP_DATABASE_CLOSED", "BACKUP_DATABASE_OPEN_FAILED",
  "BACKUP_DATABASE_INTEGRITY_FAILED", "BACKUP_DATABASE_FOREIGN_KEY_FAILED", "BACKUP_FILE_METADATA_CONFLICT",
  "BACKUP_STORAGE_KEY_INVALID", "BACKUP_ENV_FILE_FORBIDDEN", "BACKUP_RELATIVE_PATH_INVALID",
  "BACKUP_PATH_DATABASE_OVERLAP", "BACKUP_PATH_STORAGE_OVERLAP", "BACKUP_SOURCE_SYMLINK_FORBIDDEN",
  "BACKUP_REFERENCED_FILE_MISSING", "BACKUP_REFERENCED_FILE_INVALID", "BACKUP_REFERENCED_FILE_SIZE_MISMATCH",
  "BACKUP_REFERENCED_FILE_SHA_MISMATCH", "BACKUP_REFERENCED_FILE_NOT_LISTED", "BACKUP_MANIFEST_MISSING",
  "BACKUP_MANIFEST_INVALID", "BACKUP_MANIFEST_SCHEMA_UNSUPPORTED", "BACKUP_BATCH_INCOMPLETE",
  "BACKUP_DATABASE_MISSING", "BACKUP_DATABASE_SIZE_MISMATCH", "BACKUP_DATABASE_SHA_MISMATCH",
  "BACKUP_MANIFEST_FILE_INVALID", "BACKUP_MANIFEST_FILE_DUPLICATE", "BACKUP_FILE_MISSING",
  "BACKUP_FILE_SIZE_MISMATCH", "BACKUP_FILE_SHA_MISMATCH", "BACKUP_UNMANIFESTED_FILE", "BACKUP_BATCH_NOT_FOUND",
  "BACKUP_REASON_INVALID", "BACKUP_REASON_SENSITIVE", "BACKUP_IN_PROGRESS", "BACKUP_BATCH_EXISTS",
  "BACKUP_STORAGE_FULL", "BACKUP_STORAGE_DENIED", "BACKUP_STORAGE_BUSY", "BACKUP_STORAGE_MISSING"
]);
const SYSTEM_ERROR_CODES = Object.freeze({
  ENOSPC: "BACKUP_STORAGE_FULL", EACCES: "BACKUP_STORAGE_DENIED", EPERM: "BACKUP_STORAGE_DENIED",
  EBUSY: "BACKUP_STORAGE_BUSY", ENOENT: "BACKUP_STORAGE_MISSING"
});

export function safeBackupErrorCode(error, fallback = "BACKUP_FAILED") {
  const code = typeof error?.code === "string" ? error.code : "";
  if (SAFE_ERROR_CODES.has(code)) return code;
  if (Object.hasOwn(SYSTEM_ERROR_CODES, code)) return SYSTEM_ERROR_CODES[code];
  return SAFE_ERROR_CODES.has(fallback) ? fallback : "BACKUP_FAILED";
}

function statusError(code) {
  return new AppError(503, code, "备份运行状态无法确认，请联系运维核验；此状态不表示备份成功");
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  assert(!Number.isNaN(date.getTime()), 400, "BACKUP_STATUS_TIME_INVALID", "备份状态时间无效");
  return date.toISOString();
}

function successFields(result) {
  const manifest = result?.manifest;
  const validation = manifest?.validation;
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  assert(typeof result?.batchId === "string" && /^backup-\d{8}T\d{9}Z-[a-f0-9]{8}$/.test(result.batchId)
    && manifest?.batchId === result.batchId && manifest.status === "COMPLETE"
    && validation?.completed === true && validation.databaseReadable === true && validation.quickCheck === "ok"
    && validation.foreignKeyErrors === 0 && validCount(validation.referencedFiles)
    && validCount(validation.filesVerified) && validation.filesVerified >= validation.referencedFiles,
  500, "BACKUP_RESULT_INVALID", "备份完成结果未通过状态记录校验");
  return {
    batchId: result.batchId,
    validation: {
      completed: true, databaseReadable: true, quickCheck: "ok", foreignKeyErrors: 0,
      referencedFiles: validation.referencedFiles, filesVerified: validation.filesVerified
    }
  };
}

export function createBackupStatusStore(db, { processId = runtimeId, clock = () => new Date() } = {}) {
  const activeRuns = new Set();
  let storageFailure = null;
  function write(operation) {
    try { return operation(); } catch (error) {
      if (error instanceof AppError) throw error;
      storageFailure = { code: "BACKUP_STATUS_WRITE_FAILED", failedAt: isoTime(clock()) };
      throw statusError(storageFailure.code);
    }
  }
  write(() => db.exec(`
    CREATE TABLE IF NOT EXISTS backup_run_status (
      id TEXT PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('MANUAL','AUTOMATIC')),
      status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      batch_id TEXT,
      validation_json TEXT,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS backup_run_status_result_idx ON backup_run_status(status, finished_at);
    CREATE TABLE IF NOT EXISTS backup_scheduler_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      runtime_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('SCHEDULED','RUNNING','STOPPED','FAILED')),
      next_run_at TEXT,
      updated_at TEXT NOT NULL,
      last_failure_at TEXT,
      last_error_code TEXT
    );
  `));

  function startRun(kind) {
    assert(RUN_KINDS.includes(kind), 400, "BACKUP_RUN_KIND_INVALID", "备份运行类型无效");
    const id = randomUUID();
    write(() => db.prepare(`INSERT INTO backup_run_status (id, runtime_id, kind, status, started_at)
      VALUES (?, ?, ?, 'RUNNING', ?)`).run(id, processId, kind, isoTime(clock())));
    activeRuns.add(id);
    return id;
  }

  function finishRun(id, fields) {
    try {
      write(() => {
        const updated = db.prepare(`UPDATE backup_run_status
          SET status = ?, finished_at = ?, batch_id = ?, validation_json = ?, error_code = ?
          WHERE id = ? AND runtime_id = ? AND status = 'RUNNING'`)
          .run(fields.status, isoTime(clock()), fields.batchId || null,
            fields.validation ? JSON.stringify(fields.validation) : null, fields.errorCode || null, id, processId);
        assert(updated.changes === 1, 409, "BACKUP_RUN_STATE_INVALID", "备份运行不存在、已结束或属于其他进程");
      });
    } finally {
      activeRuns.delete(id);
    }
  }

  function completeRun(id, result) {
    finishRun(id, { status: "SUCCEEDED", ...successFields(result) });
  }

  function failRun(id, error) {
    finishRun(id, { status: "FAILED", errorCode: safeBackupErrorCode(error) });
  }

  function setScheduler({ status, nextRunAt = null, error = null }) {
    assert(SCHEDULER_STATES.includes(status), 400, "BACKUP_SCHEDULER_STATE_INVALID", "备份调度状态无效");
    assert(status !== "SCHEDULED" || nextRunAt !== null, 400, "BACKUP_SCHEDULER_TIME_REQUIRED", "启用调度需要下次计划时间");
    const updatedAt = isoTime(clock());
    const scheduledAt = status === "SCHEDULED" ? isoTime(nextRunAt) : null;
    const failureAt = status === "FAILED" ? updatedAt : null;
    const errorCode = status === "FAILED" ? safeBackupErrorCode(error, "BACKUP_SCHEDULER_FAILED") : null;
    write(() => db.prepare(`INSERT INTO backup_scheduler_status
      (id, runtime_id, status, next_run_at, updated_at, last_failure_at, last_error_code)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET runtime_id = excluded.runtime_id, status = excluded.status,
        next_run_at = excluded.next_run_at, updated_at = excluded.updated_at,
        last_failure_at = COALESCE(excluded.last_failure_at, backup_scheduler_status.last_failure_at),
        last_error_code = COALESCE(excluded.last_error_code, backup_scheduler_status.last_error_code)`)
      .run(processId, status, scheduledAt, updatedAt, failureAt, errorCode));
  }

  function getStatus(actor) {
    assert(actor?.role === ROLES.ADMIN && actor.active !== false, 403, "BACKUP_STATUS_FORBIDDEN", "仅系统管理员可查看备份运行状态");
    assert(!actor.mustChangePassword, 403, "PASSWORD_CHANGE_REQUIRED", "请先修改本人密码再查看备份运行状态");
    try {
      const now = isoTime(clock());
      const lastSuccess = db.prepare(`SELECT * FROM backup_run_status WHERE status = 'SUCCEEDED' ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get();
      const lastFailedRun = db.prepare(`SELECT * FROM backup_run_status WHERE status = 'FAILED' ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get();
      const scheduler = db.prepare(`SELECT * FROM backup_scheduler_status WHERE id = 1`).get();
      const incompleteCount = db.prepare(`SELECT COUNT(*) AS total FROM backup_run_status WHERE status = 'RUNNING'`).get().total;
      const incompleteRuns = db.prepare(`SELECT id, runtime_id, kind, started_at FROM backup_run_status
        WHERE status = 'RUNNING' ORDER BY started_at DESC, rowid DESC LIMIT 20`).all();
      let schedulerState = scheduler?.status || "NOT_STARTED";
      if (scheduler && ["SCHEDULED", "RUNNING"].includes(scheduler.status)) {
        if (scheduler.runtime_id !== processId) schedulerState = "UNCONFIRMED";
        else if (scheduler.status === "SCHEDULED" && scheduler.next_run_at <= now) schedulerState = "OVERDUE";
      }
      let lastFailure = lastFailedRun ? { kind: lastFailedRun.kind, failedAt: lastFailedRun.finished_at, code: safeBackupErrorCode({ code: lastFailedRun.error_code }) } : null;
      if (scheduler?.last_failure_at && (!lastFailure || scheduler.last_failure_at >= lastFailure.failedAt)) {
        lastFailure = { kind: "SCHEDULER", failedAt: scheduler.last_failure_at, code: safeBackupErrorCode({ code: scheduler.last_error_code }, "BACKUP_SCHEDULER_FAILED") };
      }
      const succeeded = lastSuccess ? successFields({ batchId: lastSuccess.batch_id, manifest: {
        batchId: lastSuccess.batch_id, status: "COMPLETE", validation: JSON.parse(lastSuccess.validation_json)
      } }) : null;
      return {
        checkedAt: now,
        lastSuccess: succeeded ? { ...succeeded, kind: lastSuccess.kind, completedAt: lastSuccess.finished_at } : null,
        lastFailure,
        scheduler: { status: schedulerState, nextRunAt: scheduler?.next_run_at || null, updatedAt: scheduler?.updated_at || null },
        freshness: !lastSuccess ? "NO_SUCCESS" : Date.parse(now) - Date.parse(lastSuccess.finished_at) > 24 * 60 * 60 * 1000 ? "OVERDUE" : "CURRENT",
        incompleteCount,
        // 只投影未确认状态，不改写其他进程的 RUNNING；手工 CLI 仍可按自己的运行 ID 完成记录。
        incompleteRuns: incompleteRuns.map(row => ({
          kind: row.kind, startedAt: row.started_at,
          status: row.runtime_id === processId && activeRuns.has(row.id) ? "RUNNING" : "UNCONFIRMED"
        })),
        storageFailure
      };
    } catch {
      throw statusError("BACKUP_STATUS_READ_FAILED");
    }
  }

  return { startRun, completeRun, failRun, setScheduler, getStatus };
}

export function initializeBackupStatusStore(db, options) {
  if (!stores.has(db)) stores.set(db, createBackupStatusStore(db, options));
  return stores.get(db);
}

export function getBackupStatusStore(db) {
  if (!stores.has(db)) throw statusError("BACKUP_STATUS_UNAVAILABLE");
  return stores.get(db);
}

export async function runBackupWithStatus({ db, kind = "MANUAL", backup, statusStore = getBackupStatusStore(db) }) {
  const id = statusStore.startRun(kind);
  try {
    const result = await backup();
    statusStore.completeRun(id, result);
    return result;
  } catch (error) {
    statusStore.failRun(id, error);
    const code = safeBackupErrorCode(error);
    throw new AppError(500, code, "本次备份未确认成功，请查看管理员备份状态并联系运维核验");
  }
}
