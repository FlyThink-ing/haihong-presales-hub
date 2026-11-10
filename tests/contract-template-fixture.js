import JSZip from "jszip";
import { CONTRACT_ATTACHMENT_MARKER, CONTRACT_TEMPLATE_MARKERS, PRODUCTION_CONTRACT_SLOT_PATHS } from "../server/contract-template-service.js";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const pathsByParagraph = new Map();
for (const path of PRODUCTION_CONTRACT_SLOT_PATHS) {
  const entries = pathsByParagraph.get(path.paragraphIndex) || [];
  entries.push(path);
  pathsByParagraph.set(path.paragraphIndex, entries);
}

function markerForKey(key) {
  return key === "attachmentPriceTable" ? CONTRACT_ATTACHMENT_MARKER : CONTRACT_TEMPLATE_MARKERS[key];
}

function paragraphXml(index) {
  if (index === 146) return "<w:p><w:r><w:t>附件一：价格明细</w:t></w:r></w:p>";
  const paths = pathsByParagraph.get(index) || [];
  const maxTextIndex = Math.max(0, ...paths.map(path => path.textNodeIndex));
  const replacements = new Map(paths.map(path => [path.textNodeIndex, markerForKey(path.key)]));
  const runs = Array.from({ length: maxTextIndex + 1 }, (_, textNodeIndex) => {
    const text = replacements.get(textNodeIndex) || `虚构固定-${index}-${textNodeIndex}`;
    return `<w:r><w:t>${text}</w:t></w:r>`;
  }).join("");
  return `<w:p>${runs}</w:p>`;
}

function cellXml(paragraphIndexes) {
  return `<w:tc>${paragraphIndexes.map(paragraphXml).join("")}</w:tc>`;
}

function rowXml(cells) {
  return `<w:tr>${cells.map(cellXml).join("")}</w:tr>`;
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

export function syntheticProductionTemplateDocumentXml() {
  const beforeMainTable = range(0, 7).map(paragraphXml).join("");
  const mainTable = `<w:tbl>${[
    rowXml(range(8, 16).map(index => [index])),
    rowXml([range(17, 22), [23, 24], [25], [26], [27], [28], [29], [30], [31]]),
    rowXml([[32], [33], [34]]),
    rowXml([[35], [36], [37]]),
    rowXml([[38]])
  ].join("")}</w:tbl>`;
  const betweenTables = range(39, 108).map(paragraphXml).join("");
  const signatureTable = `<w:tbl>${rowXml([range(109, 114), [115]])}</w:tbl>`;
  const afterSignature = range(116, 147).map(paragraphXml).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NS}"><w:body>${beforeMainTable}${mainTable}${betweenTables}${signatureTable}${afterSignature}<w:sectPr/></w:body></w:document>`;
}

export async function syntheticProductionTemplateBuffer() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
  zip.file("word/document.xml", syntheticProductionTemplateDocumentXml());
  zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles xmlns:w="${WORD_NS}"/>`);
  zip.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering xmlns:w="${WORD_NS}"/>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
