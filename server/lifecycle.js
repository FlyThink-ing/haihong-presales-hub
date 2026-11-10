export function shutdownApplication({ backupScheduler, server, db, exit = code => process.exit(code) }) {
  backupScheduler?.stop();
  server.close(() => {
    db.close();
    exit(0);
  });
}
