import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildPdfLayout } from "./quote-pdf-layout.js";

const input = await new Promise(resolve => process.once("message", resolve));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/pdfjs-dist").replace(/\\/g, "/");
const task = pdfjs.getDocument({
  data: new Uint8Array(input.buffer), stopAtErrors: true, isEvalSupported: false,
  useWasm: false, enableXfa: false, disableFontFace: true, useSystemFonts: false,
  cMapUrl: `${packageRoot}/cmaps/`, cMapPacked: true,
  standardFontDataUrl: `${packageRoot}/standard_fonts/`, verbosity: 0
});

try {
  const pdf = await task.promise;
  if (!pdf.numPages || pdf.numPages > 100) throw Object.assign(new Error("too many pages"), { safeCode: "QUOTE_PDF_TOO_COMPLEX" });
  const pages = [];
  let itemCount = 0, textCount = 0, result;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.filter(item => typeof item.str === "string" && item.str.trim()).map(item => ({
      text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height,
      rotated: Math.abs(item.transform[1]) > 0.1 || Math.abs(item.transform[2]) > 0.1
    }));
    itemCount += items.length;
    textCount += items.reduce((count, item) => count + item.text.length, 0);
    if (itemCount > 40000 || textCount > 2000000) throw Object.assign(new Error("content too large"), { safeCode: "QUOTE_PDF_TOO_COMPLEX" });
    pages.push({ page: pageNumber, rotation: page.rotate || 0, items });
    page.cleanup();
    result = buildPdfLayout(pages);
    if (result.emailEnd !== null) break;
  }
  if (!result?.units.length) throw Object.assign(new Error("no text layer"), { safeCode: "QUOTE_PDF_NO_TEXT" });
  process.send({ ok: true, result });
} catch (error) {
  const code = error.safeCode || (error.name === "PasswordException" ? "QUOTE_PDF_PASSWORD_REQUIRED" : "QUOTE_PDF_INVALID");
  process.send({ ok: false, code });
} finally {
  await task.destroy().catch(() => {});
  process.disconnect();
}
