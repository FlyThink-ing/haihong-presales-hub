import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUser } from "../server/auth-service.js";
import { createDatabase } from "../server/database.js";
import { publishContractTemplate, uploadContractTemplate } from "../server/contract-template-service.js";
import { seedDemoData } from "../scripts/seed-demo-data.js";
import { syntheticProductionTemplateBuffer } from "./contract-template-fixture.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("演示造数覆盖主要业务阶段，重复执行不产生重复记录", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hh-demo-seed-"));
  const storagePath = path.join(root, "storage");
  const db = createDatabase(path.join(root, "demo.db"));
  try {
    const admin = createUser(db, { username: "admin", displayName: "测试管理员", role: "ADMIN", password: "Test-Admin-Only-2026!" });
    const uploaded = await uploadContractTemplate(db, { storagePath }, admin, {
      originalname: "虚构合同模板.docx",
      mimetype: DOCX_MIME,
      buffer: await syntheticProductionTemplateBuffer()
    }, "DEMO-TEST-1.0");
    await publishContractTemplate(db, { storagePath }, admin, uploaded.id);

    const first = await seedDemoData({ db, config: { storagePath }, admin });
    assert.equal(first.alreadySeeded, false);
    assert.equal(first.accounts, 8);
    assert.equal(first.customers, 10);
    assert.equal(first.contacts, 10);
    assert.equal(first.followups, 10);
    assert.equal(first.surveys, 1);
    assert.equal(first.quotes, 7);
    assert.equal(first.contracts, 3);
    assert.equal(first.reminders, 4);

    assert.deepEqual(db.prepare(`SELECT status, COUNT(*) AS count FROM contracts GROUP BY status ORDER BY status`).all(), [
      { status: "DRAFT", count: 1 },
      { status: "GENERATED", count: 1 },
      { status: "SIGNED", count: 1 }
    ]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM quote_versions WHERE status = 'PENDING_MANAGER'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM quote_versions WHERE status = 'PENDING_VP'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'MANAGER' AND position_code = 'GENERAL_MANAGER' AND is_active = 1`).get().count, 1);
    assert.equal(db.prepare(`SELECT approval_stage FROM quote_versions WHERE status = 'PENDING_VP'`).get().approval_stage, "VP");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM quote_versions WHERE status = 'APPROVED'`).get().count, 3);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM quote_versions WHERE status = 'MANAGER_RETURNED'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM reminders WHERE status = 'UNABLE_PENDING'`).get().count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM reminders WHERE status = 'COMPLETED'`).get().count, 1);
    assert.equal(db.prepare(`SELECT status FROM customers WHERE full_name = '【演示】中州新材料有限公司'`).get().status, "合同签订完成");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM contract_files WHERE category = 'SYSTEM_GENERATED'`).get().count, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM contract_files WHERE category = 'FINAL_SIGNED'`).get().count, 1);

    const second = await seedDemoData({ db, config: { storagePath }, admin });
    assert.equal(second.alreadySeeded, true);
    assert.equal(second.customers, 10);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM customers`).get().count, 10);
    assert.equal(db.pragma("foreign_key_check").length, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
