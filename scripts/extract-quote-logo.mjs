import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const outputIndex = args.indexOf("--output");
if (sourceIndex < 0 || outputIndex < 0 || !args[sourceIndex + 1] || !args[outputIndex + 1]) {
  throw new Error("用法: node scripts/extract-quote-logo.mjs --source <报价HTML> --output <Logo PNG>");
}

const sourcePath = path.resolve(args[sourceIndex + 1]);
const outputPath = path.resolve(args[outputIndex + 1]);
const html = fs.readFileSync(sourcePath, "utf8");
const match = html.match(/const\s+LOGO_B64\s*=\s*"data:image\/png;base64,([^"]+)"/);
if (!match) throw new Error("参考报价 HTML 中未找到 PNG Logo 数据");

const buffer = Buffer.from(match[1], "base64");
if (buffer.length < 8 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  throw new Error("参考报价 HTML 中的 Logo 不是有效 PNG");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, buffer);
console.log(`${outputPath} (${buffer.length} bytes)`);
