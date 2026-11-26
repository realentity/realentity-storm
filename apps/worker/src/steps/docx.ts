import { inflateRawSync } from "node:zlib";

/** A Word document's text at most this large, as XML (a CV is a few hundred KB): more is refused, not inflated. */
const MAX_XML_BYTES = 20 * 1_048_576;
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Is it a Word document (.docx) by its type or name, and a zip by its content? */
export function isDocx(mime: string, filename: string, content: Buffer): boolean {
  const named = mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(filename);
  return named && content.subarray(0, 4).equals(ZIP);
}

/**
 * M59-T4: a Word document's text (.docx): its body's paragraphs a line each, table cells apart by a tab; headers,
 * footers, comments and images left out. Only word/document.xml is inflated, at most 20 MB of it: a file from an
 * applicant is untrusted input.
 */
export function docxText(content: Buffer, filename: string): string {
  const xml = zipEntry(content, "word/document.xml", MAX_XML_BYTES);
  if (xml === null) throw new Error(`${filename} isn't a Word document Storm can read (.docx)`);
  return documentText(xml.toString("utf8"));
}

/** The text of WordprocessingML's body: w:t runs, w:tab, w:br and w:cr as they look, w:p a line, w:tc a cell, w:tr a row. */
export function documentText(xml: string): string {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  // A paragraph's properties (its tab stops are w:tab too) aren't text.
  const content = body.replace(/<w:pPr\b[^>]*\/>|<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/g, "");
  const parts: string[] = [];
  for (const [, run, tag] of content.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<(\/w:p|\/w:tc|\/w:tr|w:tab|w:br|w:cr)\b[^>]*>/g)) {
    if (run !== undefined) parts.push(decodeXml(run));
    else if (tag === "/w:tc") {
      // A cell's last paragraph ended the line: the next cell goes on it, a tab apart (one row on one line).
      if (parts.at(-1) === "\n") parts.pop();
      parts.push("\t");
    } else parts.push(tag === "w:tab" ? "\t" : "\n");
  }
  return parts
    .join("")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (named[name.toLowerCase()]) return named[name.toLowerCase()];
    const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/**
 * One entry of a zip, found through its central directory and inflated to at most `maxBytes`; null when the zip has
 * no such entry, or isn't one this reads (no zip64; stored or deflated), or the entry is larger.
 */
export function zipEntry(zip: Buffer, wanted: string, maxBytes: number): Buffer | null {
  try {
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
      if (zip.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    for (let n = 0; n < count; n++) {
      if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
      const method = zip.readUInt16LE(offset + 10);
      const compressed = zip.readUInt32LE(offset + 20);
      const size = zip.readUInt32LE(offset + 24);
      const nameLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      if (name === wanted) {
        const local = zip.readUInt32LE(offset + 42);
        if (compressed === 0xffffffff || local === 0xffffffff || size > maxBytes || zip.readUInt32LE(local) !== 0x04034b50) return null;
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + compressed);
        // The size the directory says is a claim: inflating stops at the limit whatever it says.
        if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
        return method === 0 ? data : null;
      }
      offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    return null;
  } catch {
    return null;
  }
}
