import { sha256 } from "./security.js";

export const WEEKLY_REPORT_SHEET = "周汇报";
export const WEEKLY_REPORT_HEADER_ROW = 4;

function rawText(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value ?? "");
}

function valueType(value, formula) {
  if (formula) return "FORMULA";
  if (value instanceof Date) return "DATE";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  return "TEXT";
}

function strictStandaloneDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const raw = String(value ?? "").trim().replace(/[年/.]/g, "-").replace(/月/g, "-").replace(/日/g, "");
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === normalized ? normalized : null;
}

export function weeklyReportSourceIdentity({ sourceSha256, sheetName, rowNumber }) {
  return sha256(JSON.stringify([String(sourceSha256).toLowerCase(), sheetName, Number(rowNumber)]));
}

export function parseWeeklyReportRow({ rowNumber, cells, headerCells = [] }) {
  const headers = new Map(headerCells.map(cell => [cell.columnNumber, rawText(cell.value).trim()]));
  const warnings = [];
  const sourceCells = cells.map(cell => {
    const formula = cell.formula ? String(cell.formula) : null;
    const text = formula ? `=${formula}` : rawText(cell.value);
    if (formula) warnings.push(`FORMULA_REVIEW_REQUIRED:${cell.cellReference}`);
    if (text.length > 32_767) warnings.push(`LONG_CELL_REVIEW_REQUIRED:${cell.cellReference}`);
    return {
      cellReference: cell.cellReference,
      columnNumber: cell.columnNumber,
      headerText: headers.get(cell.columnNumber) || null,
      rawText: text,
      valueType: valueType(cell.value, formula),
      formulaResult: formula ? rawText(cell.formulaResult) : null
    };
  });
  const isHeaderRow = rowNumber === WEEKLY_REPORT_HEADER_ROW;
  const dateCandidates = isHeaderRow ? [] : sourceCells.filter(cell => {
    const original = cells.find(item => item.cellReference === cell.cellReference)?.value;
    return strictStandaloneDate(original) || /日期|时间/.test(cell.headerText || "") || /\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}/.test(cell.rawText);
  }).map(cell => {
    const original = cells.find(item => item.cellReference === cell.cellReference)?.value;
    return { cellReference: cell.cellReference, rawText: cell.rawText, normalizedDate: strictStandaloneDate(original) };
  });
  const amountCandidates = isHeaderRow ? [] : sourceCells.filter(cell => /金额/.test(cell.headerText || "") && /未税/.test(cell.headerText || ""))
    .map(cell => ({ cellReference: cell.cellReference, rawText: cell.rawText, headerText: cell.headerText }));
  return {
    rowNumber,
    sourceCells,
    candidates: {
      headerRow: isHeaderRow,
      dateCells: dateCandidates,
      amountCells: amountCandidates
    },
    warnings: [...new Set(warnings)]
  };
}
