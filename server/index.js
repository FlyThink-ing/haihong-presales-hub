import fs from "node:fs";
import { createApp } from "./app.js";
import { startDailyBackupScheduler } from "./backup-service.js";
import { initializeBackupStatusStore, safeBackupErrorCode } from "./backup-status-service.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { shutdownApplication } from "./lifecycle.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
fs.mkdirSync(config.storagePath, { recursive: true });
const db = createDatabase(config.databasePath);
try {
  initializeBackupStatusStore(db);
} catch (error) {
  console.error(`备份状态初始化失败 [${safeBackupErrorCode(error, "BACKUP_STATUS_WRITE_FAILED")}]；业务服务继续运行，备份状态不确定`);
}
const app = createApp({ db, config });
let backupScheduler = null;
const server = app.listen(config.port, config.host, () => {
  console.log(`Haihong Presales Hub 已启动：http://${config.host}:${config.port}`);
  try {
    backupScheduler = startDailyBackupScheduler({ db, config });
  } catch (error) {
    console.error(`每日备份调度启动失败 [${safeBackupErrorCode(error, "BACKUP_SCHEDULER_FAILED")}]；业务服务继续运行，备份状态不确定`);
  }
});

function shutdown(signal) {
  console.log(`${signal}：正在安全停止服务`);
  shutdownApplication({ backupScheduler, server, db });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
