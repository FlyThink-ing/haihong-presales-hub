import { fork } from "node:child_process";
import { AppError, assert } from "./domain.js";

const messages = {
  QUOTE_PDF_INVALID: "PDF 文件无法解析，请检查文件后重新上传",
  QUOTE_PDF_PASSWORD_REQUIRED: "PDF 文件受密码保护，请先解除密码后上传",
  QUOTE_PDF_NO_TEXT: "PDF 中未识别到文字，请使用 Word 或 WPS 直接导出 PDF 后上传",
  QUOTE_PDF_TOO_COMPLEX: "PDF 页数或内容过多，暂时无法完整检查，请联系管理员",
  QUOTE_PDF_TIMEOUT: "PDF 检查超时，请检查文件后重试"
};

export async function parseQuotePdf(buffer) {
  assert(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= 20 * 1024 * 1024,
    422, "QUOTE_PDF_INVALID", messages.QUOTE_PDF_INVALID);
  // A native PDF/font dependency can fail independently; keep it outside the web server process.
  const worker = fork(new URL("./quote-pdf-worker.js", import.meta.url), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    execArgv: ["--max-old-space-size=256"], windowsHide: true
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) { worker.kill(); reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new AppError(422, "QUOTE_PDF_TIMEOUT", messages.QUOTE_PDF_TIMEOUT)), 30000);
    worker.once("message", message => {
      if (message?.ok) return finish(null, message.result);
      const code = messages[message?.code] ? message.code : "QUOTE_PDF_INVALID";
      finish(new AppError(422, code, messages[code]));
    });
    worker.once("error", () => finish(new AppError(422, "QUOTE_PDF_INVALID", messages.QUOTE_PDF_INVALID)));
    worker.once("exit", () => finish(new AppError(422, "QUOTE_PDF_INVALID", messages.QUOTE_PDF_INVALID)));
    worker.send({ buffer }, error => { if (error) finish(new AppError(422, "QUOTE_PDF_INVALID", messages.QUOTE_PDF_INVALID)); });
  });
}
