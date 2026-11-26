import { writeZip } from "../browser/page-secrets";
import { docxText, documentText, isDocx, zipEntry } from "./docx";
import { textOf } from "./file-steps";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A Word document as Word writes one: [Content_Types].xml, its body in word/document.xml, a header apart. */
function docx(body: string, extra: { name: string; data: Buffer }[] = []): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(xml) },
    { name: "word/header1.xml", data: Buffer.from('<w:hdr><w:p><w:r><w:t>Page header</w:t></w:r></w:p></w:hdr>') },
    ...extra,
  ]);
}
const p = (...runs: string[]) => `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs.join("")}</w:p>`;
const r = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

// M59-T4: file.read reads Word documents (.docx)
describe("a Word document's text", () => {
  it("its paragraphs a line each, runs joined, tabs and breaks as they look, entities decoded", () => {
    const cv = docx(
      p(r("Maria "), r("Ivanova")) +
        p(r("Senior engineer &amp; team lead"), "<w:r><w:tab/></w:r>", r("Sofia")) +
        p() +
        p(r("Skills: C#, &lt;.NET&gt;, SQL"), "<w:r><w:br/></w:r>", r("Languages: Bulgarian, English &#8212; fluent")),
    );
    expect(docxText(cv, "cv.docx")).toBe("Maria Ivanova\nSenior engineer & team lead\tSofia\n\nSkills: C#, <.NET>, SQL\nLanguages: Bulgarian, English — fluent");
  });

  it("a table a row a line, its cells apart by a tab; the header left out", () => {
    const cell = (text: string) => `<w:tc><w:tcPr/>${p(r(text))}</w:tc>`;
    const table = `<w:tbl><w:tr>${cell("2020–2024")}${cell("Contoso")}</w:tr><w:tr>${cell("2016–2020")}${cell("Fabrikam")}</w:tr></w:tbl>`;
    expect(docxText(docx(p(r("Experience")) + table + p(r("References on request"))), "cv.docx")).toBe(
      "Experience\n2020–2024\tContoso\n2016–2020\tFabrikam\nReferences on request",
    );
    expect(documentText("<w:body><w:p><w:r><w:t>Plain</w:t></w:r></w:p></w:body>")).toBe("Plain");
  });

  it("is read by file.read's textOf by its type or its name, when its content is a zip", async () => {
    const cv = docx(p(r("Maria Ivanova")));
    expect(isDocx(DOCX, "cv", cv)).toBe(true);
    expect(isDocx("application/octet-stream", "CV.DOCX", cv)).toBe(true);
    expect(isDocx(DOCX, "cv.docx", Buffer.from("not a zip"))).toBe(false);
    await expect(textOf(DOCX, cv, "cv.docx")).resolves.toBe("Maria Ivanova");
    await expect(textOf("application/msword", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), "cv.doc")).rejects.toThrow(
      "cv.doc is a application/msword file: only text files, PDFs and Word documents (.docx) can be read",
    );
  });

  it("refuses what isn't one it can read: no body, not a zip, a body inflating past its limit", () => {
    const noBody = writeZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }]);
    expect(() => docxText(noBody, "empty.docx")).toThrow("empty.docx isn't a Word document Storm can read (.docx)");
    expect(() => docxText(Buffer.from("PK\u0003\u0004 broken"), "broken.docx")).toThrow("isn't a Word document Storm can read");
    // A bomb: 64 KB of zeros deflate to a few hundred bytes; read with a 1 KB limit, it isn't inflated past it.
    const bomb = writeZip([{ name: "word/document.xml", data: Buffer.alloc(65_536) }]);
    expect(bomb.length).toBeLessThan(2_000);
    expect(zipEntry(bomb, "word/document.xml", 1024)).toBeNull();
    // Its directory lying about the size: inflating still stops at the limit.
    const lying = Buffer.from(bomb);
    lying.writeUInt32LE(10, lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(zipEntry(lying, "word/document.xml", 1024)).toBeNull();
    expect(zipEntry(bomb, "word/document.xml", 70_000)?.length).toBe(65_536);
  });
});
