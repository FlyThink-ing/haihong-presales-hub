import path from "node:path";

function integer(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function hour(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) throw new Error(`${name} 必须是 0 至 23 的整数`);
  return parsed;
}

function choice(value, fallback, name, allowed) {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (!allowed.includes(normalized)) throw new Error(`${name} 必须是 ${allowed.join(" 或 ")}`);
  return normalized;
}

function trustProxy(value) {
  if (value === undefined || value === "") return false;
  if (String(value).trim().toLowerCase() === "loopback") return "loopback";
  throw new Error("HH_TRUST_PROXY 仅允许设置为 loopback");
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const dataMode = choice(env.HH_DATA_MODE, "TEST", "HH_DATA_MODE", ["TEST", "PRODUCTION"]);
  const quoteTemplate = String(env.HH_QUOTE_STANDARD_TEMPLATE_PATH || "").trim();
  if (quoteTemplate && path.extname(quoteTemplate).toLowerCase() !== ".docx") {
    throw new Error("HH_QUOTE_STANDARD_TEMPLATE_PATH 必须指向 DOCX 文件");
  }
  return {
    host: env.HH_HOST || "127.0.0.1",
    port: integer(env.HH_PORT, 4173, "HH_PORT"),
    databasePath: path.resolve(cwd, env.HH_DATABASE_PATH || "./data/presales-hub.db"),
    storagePath: path.resolve(cwd, env.HH_STORAGE_PATH || "./storage"),
    backupPath: path.resolve(cwd, env.HH_BACKUP_PATH || "./backups"),
    quoteStandardTemplatePath: quoteTemplate ? path.resolve(cwd, quoteTemplate) : null,
    backupHour: hour(env.HH_BACKUP_HOUR, 2, "HH_BACKUP_HOUR"),
    sessionHours: integer(env.HH_SESSION_HOURS, 12, "HH_SESSION_HOURS"),
    secureCookie: env.HH_SECURE_COOKIE === "true",
    launchProfile: choice(env.HH_LAUNCH_PROFILE, "FULL", "HH_LAUNCH_PROFILE", ["CORE", "FULL"]),
    dataMode,
    allowUnapprovedQuoteExport: dataMode === "TEST" && env.HH_ALLOW_UNAPPROVED_QUOTE_EXPORT === "true",
    trustProxy: trustProxy(env.HH_TRUST_PROXY)
  };
}
