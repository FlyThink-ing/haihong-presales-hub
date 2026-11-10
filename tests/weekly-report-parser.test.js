import assert from "node:assert/strict";
import test from "node:test";
import { parseWeeklyReportRow, weeklyReportSourceIdentity } from "../server/weekly-report-parser.js";

test("周汇报源行逐单元格保留位置、类型和原文，来源键不依赖任务", () => {
  const parsed = parseWeeklyReportRow({
    rowNumber: 5,
    headerCells: [{ columnNumber: 2, value: "日期" }, { columnNumber: 5, value: "金额（未税）" }],
    cells: [
      { cellReference: "B5", columnNumber: 2, value: new Date("2026-08-01T00:00:00Z") },
      { cellReference: "C5", columnNumber: 3, value: "虚构客户有限公司" },
      { cellReference: "E5", columnNumber: 5, value: 12345.67 }
    ]
  });
  assert.deepEqual(parsed.sourceCells.map(cell => [cell.cellReference, cell.valueType, cell.rawText]), [
    ["B5", "DATE", "2026-08-01T00:00:00.000Z"], ["C5", "TEXT", "虚构客户有限公司"], ["E5", "NUMBER", "12345.67"]
  ]);
  assert.deepEqual(parsed.candidates.dateCells, [{ cellReference: "B5", rawText: "2026-08-01T00:00:00.000Z", normalizedDate: "2026-08-01" }]);
  assert.deepEqual(parsed.candidates.amountCells, [{ cellReference: "E5", rawText: "12345.67", headerText: "金额（未税）" }]);
  assert.equal(weeklyReportSourceIdentity({ sourceSha256: "A".repeat(64), sheetName: "周汇报", rowNumber: 5 }), weeklyReportSourceIdentity({ sourceSha256: "a".repeat(64), sheetName: "周汇报", rowNumber: 5 }));
});

test("跨列日期文本只成为候选，公式和长文本完整保留且不产生业务映射", () => {
  const longText = "虚构长文本".repeat(2_000);
  const parsed = parseWeeklyReportRow({
    rowNumber: 9,
    headerCells: [{ columnNumber: 4, value: "备注" }],
    cells: [
      { cellReference: "A9", columnNumber: 1, value: "2026-08-02 虚构周报说明" },
      { cellReference: "D9", columnNumber: 4, value: longText },
      { cellReference: "F9", columnNumber: 6, value: null, formula: "SUM(1,2)", formulaResult: 3 }
    ]
  });
  assert.equal(parsed.sourceCells[1].rawText, longText);
  assert.deepEqual(parsed.candidates.dateCells, [{ cellReference: "A9", rawText: "2026-08-02 虚构周报说明", normalizedDate: null }]);
  assert.deepEqual(parsed.candidates.amountCells, []);
  assert.equal(parsed.sourceCells[2].rawText, "=SUM(1,2)");
  assert.equal(parsed.sourceCells[2].formulaResult, "3");
  assert.ok(parsed.warnings.includes("FORMULA_REVIEW_REQUIRED:F9"));
});

test("第4行只标记为表头来源，不把表头或邻接单元格推断为客户、日期或金额业务值", () => {
  const parsed = parseWeeklyReportRow({
    rowNumber: 4,
    headerCells: [{ columnNumber: 1, value: "客户名称" }, { columnNumber: 2, value: "日期" }, { columnNumber: 3, value: "金额（未税）" }],
    cells: [{ cellReference: "A4", columnNumber: 1, value: "客户名称" }, { cellReference: "B4", columnNumber: 2, value: "日期" }, { cellReference: "C4", columnNumber: 3, value: "金额（未税）" }]
  });
  assert.equal(parsed.candidates.headerRow, true);
  assert.deepEqual(parsed.candidates.dateCells, []);
  assert.deepEqual(parsed.candidates.amountCells, []);
});
