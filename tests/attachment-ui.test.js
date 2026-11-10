import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadAttachmentRendering() {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functions = ["escapeHtml", "formatTime", "attachmentItemsFor", "attachmentBlock"].map(name => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found, `${name} 页面函数必须存在`);
    return found[0];
  }).join("\n");
  const context = vm.createContext({ Intl, crypto: { randomUUID: () => "virtual-input" } });
  vm.runInContext(functions, context);
  return { source, context };
}

test("附件页面对长文件名转义并区分可写当前版本与只读锁定快照", () => {
  const { source, context } = loadAttachmentRendering();
  const current = {
    mode: "CURRENT",
    items: [{
      id: "attachment-1", targetType: "CUSTOMER", targetId: "customer-1", targetKey: "", currentVersionId: "version-2",
      currentVersion: { id: "version-2", revision: 2, originalName: "<脚本>" + "虚构长文件名".repeat(80) + ".pdf", sizeBytes: 2048, sha256: "a".repeat(64), uploadedBy: { displayName: "虚构售前" }, createdAt: "2026-10-13T08:00:00.000Z" },
      versions: [
        { id: "version-1", revision: 1, originalName: "历史.pdf", sizeBytes: 1024, sha256: "b".repeat(64), uploadedBy: { displayName: "虚构售前" }, createdAt: "2026-10-12T08:00:00.000Z" },
        { id: "version-2", revision: 2, originalName: "当前.pdf", sizeBytes: 2048, sha256: "a".repeat(64), uploadedBy: { displayName: "虚构售前" }, createdAt: "2026-10-13T08:00:00.000Z" }
      ]
    }]
  };
  context.current = current;
  const writable = vm.runInContext(`attachmentBlock({ title: "客户附件", data: current, targetType: "CUSTOMER", targetId: "customer-1", writable: true })`, context);
  assert.match(writable, /&lt;脚本&gt;/);
  assert.doesNotMatch(writable, /<脚本>/);
  assert.match(writable, /上传附件/);
  assert.match(writable, /在线查看/);
  assert.match(writable, /data-attachment-preview/);
  assert.match(writable, /替换/);
  assert.match(writable, /删除/);
  assert.match(writable, /历史版本（2）/);
  assert.match(writable, /单文件不超过 20 MB/);
  assert.match(writable, /未宣称已进行病毒查杀/);

  context.snapshot = { mode: "SNAPSHOT", items: [{ id: "snapshot-1", targetType: "QUOTE_VERSION", targetId: "quote-1", targetKey: null, originalName: "报价附件.docx", revision: 3, sizeBytes: 1024, sha256: "c".repeat(64), createdAt: "2026-10-13T08:00:00.000Z" }] };
  const locked = vm.runInContext(`attachmentBlock({ title: "报价快照", data: snapshot, targetType: "QUOTE_VERSION", targetId: "quote-1" })`, context);
  assert.match(locked, />下载</);
  assert.match(locked, /data-attachment-snapshot-preview/);
  assert.match(locked, /审批附件/);
  assert.match(locked, /仅支持 Word（DOCX）/);
  assert.doesNotMatch(locked, /Excel|XLSX/);
  assert.doesNotMatch(locked, /PDF/);
  assert.doesNotMatch(locked, /病毒查杀/);
  assert.doesNotMatch(locked, /data-attachment-replace/);
  assert.doesNotMatch(locked, /data-attachment-delete/);

  const quoteUpload = vm.runInContext(`attachmentBlock({ title: "报价原文件", data: { items: [] }, targetType: "QUOTE_VERSION", targetId: "quote-1", writable: true, uploadedSource: true })`, context);
  assert.match(quoteUpload, /accept="\.pdf"/);
  assert.doesNotMatch(quoteUpload, /\.xlsx|\.docx|Excel/);

  assert.match(source, /data-attachment-file/);
  assert.match(source, /form\.set\("requestKey", crypto\.randomUUID\(\)\)/);
  assert.match(source, /data-attachment-snapshot-download/);
  assert.match(source, /data-attachment-snapshot-preview/);
  assert.doesNotMatch(source, /title: "本题附件"/);
  assert.match(source, /FOLLOWUP/);
});
