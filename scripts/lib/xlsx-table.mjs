import { inflateRawSync } from "node:zlib";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function worksheetXmlFromXlsx(buffer) {
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  invariant(eocdOffset >= 0, "XLSX ZIP end record is missing");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  let sheetEntry;

  for (let index = 0; index < entryCount; index += 1) {
    invariant(buffer.readUInt32LE(offset) === 0x02014b50, "Invalid XLSX ZIP directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");

    if (fileName === "xl/worksheets/sheet1.xml") {
      sheetEntry = { method, compressedSize, localOffset };
      break;
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  invariant(sheetEntry, "XLSX worksheet is missing");
  invariant(buffer.readUInt32LE(sheetEntry.localOffset) === 0x04034b50, "Invalid XLSX worksheet entry");
  const localNameLength = buffer.readUInt16LE(sheetEntry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(sheetEntry.localOffset + 28);
  const start = sheetEntry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(start, start + sheetEntry.compressedSize);

  if (sheetEntry.method === 0) return compressed.toString("utf8");
  invariant(sheetEntry.method === 8, `Unsupported XLSX compression method: ${sheetEntry.method}`);
  return inflateRawSync(compressed).toString("utf8");
}

export function parseFirstWorksheet(buffer) {
  const xml = worksheetXmlFromXlsx(buffer);
  const rows = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const reference = /\br="([A-Z]+)\d+"/.exec(cellMatch[1])?.[1];
      if (!reference) continue;
      const body = cellMatch[2];
      const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      const numeric = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (inline !== undefined) cells[reference] = decodeXml(inline);
      else if (numeric !== undefined) cells[reference] = Number(numeric);
    }
    rows.push(cells);
  }

  invariant(rows.length >= 2, "XLSX worksheet has no data rows");
  return rows;
}
