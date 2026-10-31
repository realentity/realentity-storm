import { deflateRawSync } from "node:zlib";
import { MASK, PageSecrets, writeZip, zipEntries } from "./page-secrets";

describe("PageSecrets", () => {
  const secrets = new PageSecrets();
  secrets.add("hunter2-Secret!");
  secrets.add("abc"); // too short to mask in text

  it("masks a secret in text, also URL- and JSON-encoded", () => {
    expect(secrets.mask("pw=hunter2-Secret! url=hunter2-Secret%21 json=hunter2-Secret!")).toBe(`pw=${MASK} url=${MASK} json=${MASK}`);
    expect(secrets.mask("abc stays")).toBe("abc stays");
  });

  it("redacts a trace: text entries masked, images kept, the archive readable again", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const trace = writeZip([
      { name: "trace.trace", data: Buffer.from('{"type":"action","params":{"value":"hunter2-Secret!"}}\n') },
      { name: "trace.network", data: Buffer.from('{"request":{"headers":[{"name":"Cookie","value":"sid=hunter2-Secret!"}]}}\n') },
      { name: "resources/page@1.png", data: png },
    ]);
    // Deflated, the value isn't visible in the raw bytes: only reading the entries finds it.
    expect(trace.includes("hunter2-Secret!")).toBe(false);

    const redacted = secrets.redactTrace(trace)!;
    const entries = zipEntries(redacted)!;
    expect(entries.map((e) => e.name)).toEqual(["trace.trace", "trace.network", "resources/page@1.png"]);
    expect(entries.some((e) => e.data.includes("hunter2-Secret!"))).toBe(false);
    expect(entries[0].data.toString()).toContain(MASK);
    expect(entries[2].data.equals(png)).toBe(true);
  });

  it("keeps no trace it can't read, or that still has a secret after masking", () => {
    expect(secrets.redactTrace(Buffer.from("not a zip"))).toBeNull();
    // A secret inside an image entry isn't masked (that would corrupt it): the trace is dropped instead.
    const leaky = writeZip([{ name: "shot.png", data: Buffer.from("....hunter2-Secret!....") }]);
    expect(secrets.redactTrace(leaky)).toBeNull();
    // Another compression method than deflate: unreadable, so not kept.
    const zip = writeZip([{ name: "a.txt", data: Buffer.from("x") }]);
    zip.writeUInt16LE(12, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(zipEntries(zip)).toBeNull();
    expect(deflateRawSync(Buffer.from("x")).length).toBeGreaterThan(0);
  });
});
