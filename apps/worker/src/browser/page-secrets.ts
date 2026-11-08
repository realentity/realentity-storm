import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { type Locator, type Page } from "playwright";

export const MASK = "••••••";

/** Fields a secret may be typed into, besides those it was filled into: never shown in screenshots or snapshots. */
const SECRET_FIELDS = 'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"]';

/**
 * What a browser step must keep out of everything it produces (docs/design.md §7): the credential values it filled, and the
 * fields it filled them into. Text (page text, snapshots for the LLM, errors) is masked; screenshots cover the
 * fields; a trace that still contains a value is dropped rather than stored.
 */
export class PageSecrets {
  private readonly values = new Set<string>();
  private readonly fields: string[] = [];

  /** A value that was filled (`selector`: where). Short values aren't masked in text: they would mask ordinary words. */
  add(value: string, selector?: string): void {
    if (value.length >= 4) this.values.add(value);
    if (selector) this.fields.push(selector);
  }

  get isEmpty(): boolean {
    return this.values.size === 0;
  }

  /** Replaces every secret value in the text, also as it appears in URLs and JSON. */
  mask(text: string): string {
    let masked = text;
    for (const value of this.variants()) masked = masked.split(value).join(MASK);
    return masked;
  }

  /** True when the bytes contain a secret value in any of its encodings. */
  foundIn(content: Buffer | string): boolean {
    const text = typeof content === "string" ? content : content.toString("latin1");
    const utf8 = typeof content === "string" ? content : content.toString("utf8");
    return [...this.variants()].some((value) => text.includes(value) || utf8.includes(value));
  }

  /** Locators to cover in a screenshot: every secret-looking field, and every field a secret was filled into. */
  masks(page: Page): Locator[] {
    return [page.locator(SECRET_FIELDS), ...this.fields.map((selector) => page.locator(selector))];
  }

  /**
   * The page as the LLM may see it (docs/design.md §7; for browser.agent and form mapping): the accessibility snapshot with
   * secret values masked. Values of password fields never appear in it, and filled values are replaced.
   */
  async snapshot(page: Page): Promise<string> {
    return this.mask(await page.locator("body").ariaSnapshot());
  }

  /**
   * A trace archive (zip) to store: Playwright records typed text, DOM values and request headers (the session
   * cookie). Every text entry is masked and the archive rewritten; null when it can't be read, or a secret is still
   * in it afterwards (then no trace is kept).
   */
  redactTrace(zip: Buffer): Buffer | null {
    const entries = zipEntries(zip);
    if (!entries) return null;
    const redacted = entries.map(({ name, data }) => ({
      name,
      data: isBinary(name) ? data : Buffer.from(this.mask(data.toString("utf8")), "utf8"),
    }));
    if (redacted.some(({ data }) => this.foundIn(data))) return null;
    return writeZip(redacted);
  }

  private *variants(): Iterable<string> {
    for (const value of this.values) {
      yield value;
      yield encodeURIComponent(value);
      // As a submitted form encodes it (the sign-in post in a trace): "!" → %21, " " → +.
      yield new URLSearchParams({ v: value }).toString().slice(2);
      yield JSON.stringify(value).slice(1, -1);
    }
  }
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Images and fonts in a trace: masking text in them would corrupt them, and a value typed into a field isn't in them. */
function isBinary(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(name);
}

/**
 * The inflated contents of a zip's entries, read through its central directory (local headers of a streamed zip
 * carry no sizes); null when it isn't a zip this can read (no zip64, stored or deflated entries only).
 */
export function zipEntries(zip: Buffer): ZipEntry[] | null {
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
  const entries: ZipEntry[] = [];
  try {
    for (let n = 0; n < count; n++) {
      if (zip.readUInt32LE(offset) !== 0x02014b50) return null;
      const method = zip.readUInt16LE(offset + 10);
      const size = zip.readUInt32LE(offset + 20);
      const nameLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      const local = zip.readUInt32LE(offset + 42);
      if (size === 0xffffffff || local === 0xffffffff || zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 8) entries.push({ name, data: inflateRawSync(data) });
      else if (method === 0) entries.push({ name, data });
      else return null;
      offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
  } catch {
    return null;
  }
  return entries;
}

/** A zip of deflated entries (what `npx playwright show-trace` reads). */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
