import fs from "node:fs";
import { restoreBackup } from "../server/backup-service.js";
import { loadConfig } from "../server/config.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const batchPath = option("--batch");
const targetPath = option("--target");
if (!batchPath || !targetPath) {
  console.error("用法：npm.cmd run backup:restore-drill -- --batch <已完成批次目录> --target <全新隔离目标目录>");
  process.exit(1);
}

const config = loadConfig();
try {
  const result = await restoreBackup({
    batchPath,
    targetPath,
    databasePath: config.databasePath,
    storagePath: config.storagePath,
    backupPath: config.backupPath
  });
  console.log(`恢复演练完成：批次 ${result.batchId}`);
  console.log(`恢复后校验：数据库 ${result.validation.quickCheck}，文件 ${result.validation.filesVerified} 个`);
} catch (error) {
  console.error(`恢复演练失败 [${error.code || "RESTORE_FAILED"}]：${error.message}`);
  process.exitCode = 1;
}
