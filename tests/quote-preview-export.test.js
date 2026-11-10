import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { loadConfig } from "../server/config.js";
import { createQuote, decideQuote, submitQuote } from "../server/quote-service.js";
import { uploadAttachment } from "../server/attachment-service.js";
import { addCustomerAndProject, sampleQuoteInput, setupBase, startTestApi } from "./test-utils.js";

test("未审批 Word 预览导出在测试和生产环境均关闭，即使旧开关开启也不可用", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-preview-"));
  const actors = [f.admin, f.salesA, f.salesB, f.manager];
  let api;
  t.after(async () => {
    if (api) await api.close();
    f.db.close();
    assert.ok(path.resolve(storagePath).startsWith(path.join(path.resolve(os.tmpdir()), "hh-quote-preview-")));
    fs.rmSync(storagePath, { recursive: true, force: true });
  });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "预览");
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id));
  const route = `/api/quote-versions/${quote.id}/preview-docx`;
  api = await startTestApi(f.db, f.admin, actors, { storagePath, launchProfile: "CORE", dataMode: "TEST" });
  assert.equal((await api.request(f.salesA, route, "POST")).status, 404);
  assert.equal((await api.request(f.salesA, "/api/runtime")).body.allowUnapprovedQuoteExport, undefined);
  await api.close(); api = null;

  api = await startTestApi(f.db, f.admin, actors, { storagePath, launchProfile: "CORE", dataMode: "TEST", allowUnapprovedQuoteExport: true });
  assert.equal((await api.request(f.salesA, "/api/runtime")).body.allowUnapprovedQuoteExport, undefined);
  const before = f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n;
  for (const actor of actors) {
    const result = await api.request(actor, route, "POST");
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "QUOTE_PREVIEW_DISABLED");
  }
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n, before);
  const state = f.db.prepare(`SELECT status, snapshot_json FROM quote_versions WHERE id = ?`).get(quote.id);
  assert.equal(state.status, "DRAFT");
  assert.equal(state.snapshot_json, null);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM quote_approvals WHERE quote_version_id = ?`).get(quote.id).n, 0);
  assert.notEqual((await api.request(f.salesA, `/api/quote-versions/${quote.id}/export-docx`, "POST")).status, 201);
  await api.close(); api = null;

  api = await startTestApi(f.db, f.admin, actors, { storagePath, launchProfile: "CORE", dataMode: "PRODUCTION", allowUnapprovedQuoteExport: true });
  assert.equal((await api.request(f.salesA, route, "POST")).status, 404);
  assert.equal((await api.request(f.salesA, "/api/runtime")).body.allowUnapprovedQuoteExport, undefined);
  assert.equal(loadConfig({ HH_DATA_MODE: "TEST", HH_ALLOW_UNAPPROVED_QUOTE_EXPORT: "true" }).allowUnapprovedQuoteExport, true);
  assert.equal(loadConfig({ HH_DATA_MODE: "PRODUCTION", HH_ALLOW_UNAPPROVED_QUOTE_EXPORT: "true" }).allowUnapprovedQuoteExport, false);
  assert.equal(loadConfig({ HH_DATA_MODE: "TEST" }).allowUnapprovedQuoteExport, false);
});

test("已审批的旧网页报价也不能通过接口导出 Word，既有快照保持不变", async t => {
  const f = setupBase();
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hh-quote-export-disabled-"));
  const api = await startTestApi(f.db, f.admin, [f.admin, f.salesA, f.manager, f.generalManager, f.vp], { storagePath, launchProfile: "CORE", dataMode: "TEST" });
  t.after(async () => {
    await api.close(); f.db.close();
    assert.ok(path.resolve(storagePath).startsWith(path.join(path.resolve(os.tmpdir()), "hh-quote-export-disabled-")));
    fs.rmSync(storagePath, { recursive: true, force: true });
  });
  const { customer, project } = addCustomerAndProject(f.db, f.salesA, "报价导出关闭");
  const quote = createQuote(f.db, f.salesA, sampleQuoteInput(customer.id, project.id));
  submitQuote(f.db, f.salesA, quote.id);
  for (const actor of [f.manager, f.generalManager, f.vp]) decideQuote(f.db, actor, quote.id, { decision: "APPROVED", comment: "虚构审核通过" });
  const before = f.db.prepare(`SELECT status, snapshot_json, snapshot_hash FROM quote_versions WHERE id = ?`).get(quote.id);
  const fileCount = f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n;
  for (const actor of [f.salesA, f.admin]) {
    const result = await api.request(actor, `/api/quote-versions/${quote.id}/export-docx`, "POST");
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "QUOTE_EXPORT_DISABLED");
  }
  assert.deepEqual(f.db.prepare(`SELECT status, snapshot_json, snapshot_hash FROM quote_versions WHERE id = ?`).get(quote.id), before);
  assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM stored_files`).get().n, fileCount);
});
