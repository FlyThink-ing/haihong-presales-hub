import { createUser } from "../server/auth-service.js";
import { loadConfig } from "../server/config.js";
import { createDatabase } from "../server/database.js";
import fs from "node:fs";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const USAGE = `首次管理员初始化

用法：
  npm.cmd run init-admin -- --username admin --display-name "系统管理员"

密码会在终端中隐式输入两次，不写入 .env、命令参数或日志。
无人值守初始化仍兼容单进程环境变量 HH_BOOTSTRAP_USERNAME、HH_BOOTSTRAP_DISPLAY_NAME、HH_BOOTSTRAP_PASSWORD；不要把真实密码保存到 .env。`;

export function parseInitAdminArgs(argv = []) {
  const result = { username: "", displayName: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const match = /^(--username|--display-name)=(.*)$/.exec(argument);
    const option = match?.[1] || argument;
    if (!["--username", "--display-name"].includes(option)) throw new Error(`未知参数：${argument}`);
    const value = match ? match[2] : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数值`);
    if (option === "--username") result.username = value.trim();
    if (option === "--display-name") result.displayName = value.trim();
  }
  return result;
}

export function validateInteractivePassword(password, confirmation) {
  if (typeof password !== "string" || password.length < 12) throw new Error("密码长度至少为 12 位");
  if (password !== confirmation) throw new Error("两次输入的密码不一致");
  return password;
}

async function visibleQuestions(input, output, current) {
  if (current.username && current.displayName) return current;
  if (!input.isTTY || !output.isTTY) throw new Error("非交互终端必须通过 --username 和 --display-name 提供账号信息");
  const terminal = readline.createInterface({ input, output, terminal: true });
  try {
    const username = current.username || String(await terminal.question("管理员用户名：")).trim();
    const displayName = current.displayName || String(await terminal.question("管理员显示名称：")).trim();
    return { ...current, username, displayName };
  } finally {
    terminal.close();
  }
}

async function hiddenQuestion(input, output, prompt) {
  if (!input.isTTY || !output.isTTY) throw new Error("非交互终端必须通过单进程环境变量 HH_BOOTSTRAP_PASSWORD 提供密码");
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = readline.createInterface({ input, output: silentOutput, terminal: true });
  output.write(prompt);
  try {
    return await terminal.question("");
  } finally {
    terminal.close();
    output.write("\n");
  }
}

export async function collectInitAdminInput({ argv = process.argv.slice(2), env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const parsed = parseInitAdminArgs(argv);
  if (parsed.help) return { help: true };
  const identity = await visibleQuestions(input, output, {
    username: parsed.username || String(env.HH_BOOTSTRAP_USERNAME || "").trim(),
    displayName: parsed.displayName || String(env.HH_BOOTSTRAP_DISPLAY_NAME || "").trim()
  });
  if (!identity.username) throw new Error("管理员用户名不能为空");
  if (!identity.displayName) throw new Error("管理员显示名称不能为空");
  const environmentPassword = env.HH_BOOTSTRAP_PASSWORD;
  const password = environmentPassword && environmentPassword !== "YOUR_PASSWORD_HERE"
    ? environmentPassword
    : validateInteractivePassword(
      await hiddenQuestion(input, output, "管理员密码（至少 12 位，输入不显示）："),
      await hiddenQuestion(input, output, "再次输入管理员密码：")
    );
  return { username: identity.username, displayName: identity.displayName, password };
}

export async function main() {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const input = await collectInitAdminInput();
  if (input.help) {
    console.log(USAGE);
    return;
  }
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  try {
    const user = createUser(db, { ...input, role: "ADMIN" });
    console.log(`管理员账号已创建：${user.username}（密码未写入配置或日志）`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`管理员初始化失败：${error.message}`);
    process.exitCode = 1;
  });
}
