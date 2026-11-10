import ExcelJS from "exceljs";
import { assert } from "./domain.js";

export async function readQuoteExcelWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  for (const sheet of workbook.worksheets) {
    assert(sheet.rowCount <= 500 && sheet.columnCount <= 40, 422, "QUOTE_EXCEL_ATTACHMENT_TOO_LARGE",
      `Excel 附件工作表“${sheet.name}”超过 500 行或 40 列，无法完整合并；请缩小表格后重新添加`);
  }
  return workbook;
}
