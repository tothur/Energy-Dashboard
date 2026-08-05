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

function uint32(view, offset) {
  return view.getUint32(offset, true);
}

function uint16(view, offset) {
  return view.getUint16(offset, true);
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

async function worksheetXmlFromXlsx(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (uint32(view, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  invariant(eocdOffset >= 0, "XLSX ZIP end record is missing");

  const entryCount = uint16(view, eocdOffset + 10);
  let offset = uint32(view, eocdOffset + 16);
  let sheetEntry;
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index += 1) {
    invariant(uint32(view, offset) === 0x02014b50, "Invalid XLSX ZIP directory");
    const method = uint16(view, offset + 10);
    const compressedSize = uint32(view, offset + 20);
    const fileNameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const localOffset = uint32(view, offset + 42);
    const fileName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + fileNameLength));

    if (fileName === "xl/worksheets/sheet1.xml") {
      sheetEntry = { method, compressedSize, localOffset };
      break;
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  invariant(sheetEntry, "XLSX worksheet is missing");
  invariant(uint32(view, sheetEntry.localOffset) === 0x04034b50, "Invalid XLSX worksheet entry");
  const localNameLength = uint16(view, sheetEntry.localOffset + 26);
  const localExtraLength = uint16(view, sheetEntry.localOffset + 28);
  const start = sheetEntry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.subarray(start, start + sheetEntry.compressedSize);

  if (sheetEntry.method === 0) return decoder.decode(compressed);
  invariant(sheetEntry.method === 8, `Unsupported XLSX compression method: ${sheetEntry.method}`);
  return inflateRaw(compressed);
}

export async function parseFirstWorksheet(arrayBuffer) {
  const xml = await worksheetXmlFromXlsx(arrayBuffer);
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
