import fs from "node:fs";
import { createBackup } from "../server/backup-service.js";
import { loadConfig } from "../server/config.js";
import { createDatabase } from "../server/database.js";
import { initializeBackupStatusStore, runBackupWithStatus, safeBackupErrorCode } from "../server/backup-status-service.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const reason = option("--reason") || "手工备份";
let db;

try {
  const config = loadConfig();
  db = createDatabase(config.databasePath);
  initializeBackupStatusStore(db);
  const result = await runBackupWithStatus({
    db, kind: "MANUAL",
    backup: () => createBackup({
      db, databasePath: config.databasePath, storagePath: config.storagePath,
      backupPath: config.backupPath, reason
    })
  });
  console.log(`备份完成：批次 ${result.batchId}`);
  console.log(`校验结果：数据库 ${result.manifest.validation.quickCheck}，文件 ${result.manifest.validation.filesVerified} 个`);
} catch (error) {
  console.error(`备份未确认成功 [${safeBackupErrorCode(error)}]；请联系运维核验`);
  process.exitCode = 1;
} finally {
  db?.close();
}
