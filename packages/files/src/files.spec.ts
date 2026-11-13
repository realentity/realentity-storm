import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { detectFile, FileProblem, forVision, insideRoot, readStored, removeStored, safeName, storeFile } from "./index";

const PDF = Buffer.from("%PDF-1.4\n% made up\n%%EOF\n");

// M46-U1: files checked by content, stored with a thumbnail, made small for the LLM
describe("App files", () => {
  let root: string;
  let photo: Buffer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "storm-files-"));
    photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 90, b: 160 } } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "made up" } } })
      .toBuffer();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("tells a file by its content, never by its name", () => {
    expect(detectFile(photo, "receipt.pdf", "image")).toEqual({ mime: "image/jpeg", extension: ".jpg", image: true });
    expect(detectFile(PDF, "receipt.pdf", "file")).toEqual({ mime: "application/pdf", extension: ".pdf", image: false });
    expect(detectFile(PDF, "receipt.pdf", "image")).toEqual({ problem: "Only a PNG, JPEG, WebP or GIF image" });
    expect(detectFile(Buffer.from("<svg><script>alert(1)</script></svg>"), "a.svg", "file")).toHaveProperty("problem");
    expect(detectFile(Buffer.from("MZ\u0090\u0000"), "a.pdf", "file")).toHaveProperty("problem");
    expect(detectFile(Buffer.from("a,b\n1,2\n"), "a.csv", "file")).toEqual({ mime: "text/csv", extension: ".csv", image: false });
    expect(detectFile(Buffer.from([0x61, 0x00]), "a.txt", "file")).toHaveProperty("problem");
  });

  it("stores an image with a small thumbnail without its metadata, and removes both", async () => {
    const stored = await storeFile(root, photo, "C:\\scans\\warranty.jpg", "image");
    expect(stored).toMatchObject({ filename: "warranty.jpg", mime: "image/jpeg", size: photo.length, path: `app-files/${stored.appFileId}.jpg` });
    expect((await readStored(root, stored.path)).equals(photo)).toBe(true);
    const thumb = await sharp(await readStored(root, stored.thumbPath!)).metadata();
    expect(thumb).toMatchObject({ format: "webp", width: 480, height: 360 });
    expect(thumb.exif).toBeUndefined();
    await removeStored(root, [stored.path, stored.thumbPath]);
    expect(await readdir(join(root, "app-files"))).toEqual([]);
    await expect(storeFile(root, Buffer.alloc(0), "a.pdf", "file")).rejects.toThrow(FileProblem);
  });

  it("makes an image small enough for the LLM, a PNG staying a PNG", async () => {
    const jpeg = await forVision(photo, "image/jpeg");
    expect(jpeg.mime).toBe("image/jpeg");
    expect(await sharp(jpeg.data).metadata()).toMatchObject({ width: 1568, height: 1176 });
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
    const small = await forVision(png, "image/png");
    expect(small.mime).toBe("image/png");
    expect(await sharp(small.data).metadata()).toMatchObject({ width: 200, height: 100 });
  });

  it("never reaches outside the folder", () => {
    expect(() => insideRoot(root, "../secret")).toThrow(FileProblem);
    expect(() => insideRoot(root, "/etc/passwd")).toThrow(FileProblem);
    expect(insideRoot(root, "app-files/a.pdf")).toBe(join(root, "app-files", "a.pdf"));
    expect(safeName('../../a<b>"c".pdf')).toBe("abc.pdf");
  });
});
