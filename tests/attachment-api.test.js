import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addCustomerAndProject, setupBase, startTestApi } from "./test-utils.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

function uploadForm({ targetType, targetId, targetKey = "", attachmentId = "", expectedCurrentVersionId = "", requestKey = crypto.randomUUID(), name = "虚构附件.pdf" }) {
  const form = new FormData();
  form.set("targetType", targetType);
  form.set("targetId", targetId);
  if (targetKey) form.set("targetKey", targetKey);
  if (attachmentId) form.set("attachmentId", attachmentId);
  if (expectedCurrentVersionId) form.set("expectedCurrentVersionId", expectedCurrentVersionId);
  form.set("requestKey", requestKey);
  form.set("file", new Blob([PDF], { type: "application/pdf" }), name);
  return form;
}

test("通用附件 HTTP 入口执行上传、权限化列表、版本下载和软删除", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-attachment-api-"));
  const { customer } = addCustomerAndProject(f.db, f.salesA, "接口");
  const api = await startTestApi(f.db, f.admin, [f.admin, f.manager, f.salesA, f.salesB, f.vp], { storagePath });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });

  const upload = await api.request(f.salesA, "/api/attachments/upload", "POST", uploadForm({ targetType: "CUSTOMER", targetId: customer.id, name: "超长但合法的虚构客户需求说明-用于接口与窄屏换行验证.pdf" }));
  assert.equal(upload.status, 201);
  assert.equal(upload.body.currentVersion.originalName, "超长但合法的虚构客户需求说明-用于接口与窄屏换行验证.pdf");
  assert.equal(Object.hasOwn(upload.body.currentVersion, "storageKey"), false);

  assert.equal((await api.request(f.salesA, `/api/attachments?targetType=CUSTOMER&targetId=${customer.id}`)).body.items.length, 1);
  assert.equal((await api.request(f.manager, `/api/attachments?targetType=CUSTOMER&targetId=${customer.id}`)).body.items.length, 1);
  assert.equal((await api.request(f.salesB, `/api/attachments?targetType=CUSTOMER&targetId=${customer.id}`)).status, 404);
  assert.equal((await api.request(f.vp, `/api/attachments?targetType=CUSTOMER&targetId=${customer.id}`)).status, 404);
  assert.deepEqual((await api.request(f.salesA, `/api/attachments/${upload.body.id}/preview`)).body, PDF);
  assert.equal((await api.request(f.salesB, `/api/attachments/${upload.body.id}/preview`)).status, 404);
  assert.deepEqual((await api.request(f.salesA, `/api/attachments/${upload.body.id}/download`)).body, PDF);
  assert.equal((await api.request(f.salesA, `/api/files/${upload.body.currentVersion.fileId}/download`)).status, 404);
  assert.equal((await api.request(f.manager, `/api/attachments/${upload.body.id}`, "DELETE", { reason: "负责人只读，不可删除" })).status, 403);
  assert.equal((await api.request(f.salesA, `/api/attachments/${upload.body.id}`, "DELETE", { reason: "虚构附件已失效" })).status, 204);
  assert.equal((await api.request(f.salesA, `/api/attachments/${upload.body.id}/download`)).status, 404);
});

test("通用附件 HTTP 入口拒绝执行类伪装文件且不留下归档", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-attachment-api-invalid-"));
  const { customer } = addCustomerAndProject(f.db, f.salesA, "格式");
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA], { storagePath });
  t.after(async () => { await api.close(); f.db.close(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const form = new FormData();
  form.set("targetType", "CUSTOMER");
  form.set("targetId", customer.id);
  form.set("requestKey", crypto.randomUUID());
  form.set("file", new Blob([Buffer.from("MZ-not-a-document")], { type: "application/octet-stream" }), "恶意伪装.exe");
  const response = await api.request(f.salesA, "/api/attachments/upload", "POST", form);
  assert.equal(response.status, 415);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM stored_files WHERE category = 'BUSINESS_ATTACHMENT'`).get().count, 0);
  assert.deepEqual(fs.readdirSync(storagePath), []);
});
