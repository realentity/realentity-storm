import { type PrismaClient } from "@ai-me/db";
import { hostMatches } from "@ai-me/shared";
import { XMLParser } from "fast-xml-parser";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { valueAt } from "./data-steps";

type Item = Record<string, unknown>;

const MAX_REDIRECTS = 5;
const MAX_TEXT = 50_000;
const MAX_SUMMARY = 2_000;
const USER_AGENT = "AI-ME/1.0 (personal automation; reads feeds and pages it was told to)";

/**
 * Where http.fetch never connects (M13-S1): this machine, private networks, Tailscale's 100.64.0.0/10 (the tailnet:
 * the server's apps), link-local (cloud metadata), multicast and reserved ranges, IPv4 and IPv6.
 */
export function privateAddresses(): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["fd7a:115c:a1e0::", 48],
  ] as const)
    list.addSubnet(net, prefix, "ipv6");
  return list;
}

export interface HttpFetchOptions {
  /** Addresses never connected to; tests narrow it to reach their local server. */
  blocked?: BlockList;
  /** DNS; tests map their hosts to 127.0.0.1. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

interface FetchInput {
  url?: string;
  urls?: string[];
  itemsAt?: string;
  maxItems: number;
  maxKb: number;
  timeoutSeconds: number;
}

interface Document {
  url: string;
  status: number;
  notModified: boolean;
  contentType: string;
  title: string | null;
  truncated: boolean;
  items: Item[];
  json: unknown;
  text: string;
}

/** Refused before anything was sent: the step fails with this, the reason in plain words. */
export class FetchRefused extends Error {}

/**
 * http.fetch (README §2.3, M13-T1): GET without a browser, cookies or credentials. Only hosts on the pipeline's
 * allowedDomains, and only public addresses: the name is resolved here and the connection goes to the address checked
 * (no second lookup to rebind); every redirect is checked again. Feeds become items, JSON stays data, HTML becomes text.
 * With an ETag or Last-Modified from the last read, an unchanged address (304) gives what was read then.
 */
export class HttpFetchStep implements StepExecutor {
  readonly type = "http.fetch";
  private readonly blocked: BlockList;
  private readonly resolve: NonNullable<HttpFetchOptions["resolve"]>;

  constructor(
    private readonly prisma: PrismaClient,
    options: HttpFetchOptions = {},
  ) {
    this.blocked = options.blocked ?? privateAddresses();
    this.resolve = options.resolve ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, urls, itemsAt, maxItems, maxKb, timeoutSeconds } = input as unknown as FetchInput;
    if (!url === !urls) throw new Error("http.fetch reads `url` or `urls`: give one of them");
    const allowed = context.allowedDomains ?? [];
    const documents: Document[] = [];
    for (const address of urls ?? [url!]) {
      documents.push(await this.read(address, context.userId, allowed, { itemsAt, maxBytes: maxKb * 1024, timeout: timeoutSeconds * 1000 }));
    }
    return {
      items: documents.flatMap((d) => d.items).slice(0, maxItems),
      json: documents[0]?.json ?? null,
      text: documents[0]?.text ?? "",
      documents: documents.map(({ url: u, status, notModified, contentType, title, truncated }) => ({ url: u, status, notModified, contentType, title, truncated })),
    };
  }

  private async read(url: string, userId: string, allowed: readonly string[], options: { itemsAt?: string; maxBytes: number; timeout: number }): Promise<Document> {
    const cached = await this.prisma.httpCache.findUnique({ where: { userId_url: { userId, url } } });
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/json, text/html;q=0.9, */*;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      ...(cached?.lastModified ? { "if-modified-since": cached.lastModified } : {}),
    };
    const response = await this.get(url, headers, allowed, options);
    let body = response.body;
    let contentType = response.contentType;
    const notModified = response.status === 304 && cached !== null;
    if (notModified) {
      body = Buffer.from(cached.body);
      contentType = cached.contentType;
    } else if (response.status < 200 || response.status > 299) {
      throw new Error(`${url} answered ${response.status}`);
    } else if (!response.truncated && (response.etag || response.lastModified)) {
      const data = { etag: response.etag, lastModified: response.lastModified, contentType, body: new Uint8Array(body), fetchedAt: new Date() };
      await this.prisma.httpCache.upsert({ where: { userId_url: { userId, url } }, create: { userId, url, ...data }, update: data });
    }
    return { url, status: response.status, notModified, contentType, truncated: response.truncated, ...parse(url, body, contentType, response.truncated, options.itemsAt) };
  }

  /** A GET, following redirects, each address checked; the body up to maxBytes (decompressed). */
  private async get(
    start: string,
    headers: Record<string, string>,
    allowed: readonly string[],
    { maxBytes, timeout }: { maxBytes: number; timeout: number },
  ): Promise<{ status: number; contentType: string; etag: string | null; lastModified: string | null; body: Buffer; truncated: boolean }> {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      this.check(url, allowed);
      const response = await this.send(url, headers, timeout);
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && location) {
        response.resume();
        if (hop >= MAX_REDIRECTS) throw new Error(`${start}: more than ${MAX_REDIRECTS} redirects`);
        url = new URL(location, url);
        continue;
      }
      const { body, truncated } = await readBody(response, maxBytes);
      const header = (name: string) => {
        const value = response.headers[name];
        return typeof value === "string" ? value : null;
      };
      return {
        status: response.statusCode ?? 0,
        contentType: (header("content-type") ?? "").split(";")[0].trim().toLowerCase(),
        etag: header("etag"),
        lastModified: header("last-modified"),
        body,
        truncated,
      };
    }
  }

  private check(url: URL, allowed: readonly string[]): void {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchRefused(`Refused: ${url.protocol} isn't http(s)`);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostMatches(host, allowed)) throw new FetchRefused(`Refused: ${host} isn't in the pipeline's allowedDomains`);
    if (isIP(host) && this.isBlocked(host)) throw new FetchRefused(`Refused: ${host} is a private or local address`);
  }

  private isBlocked(address: string): boolean {
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    return this.blocked.check(address, family) || (mapped !== undefined && this.blocked.check(mapped, "ipv4"));
  }

  private send(url: URL, headers: Record<string, string>, timeout: number): Promise<IncomingMessage> {
    // Resolved here and checked; the socket connects to the address checked (no lookup of its own).
    const lookup: LookupFunction = (hostname, options, callback) => {
      this.resolve(hostname).then(
        (addresses) => {
          const refused = addresses.find((a) => this.isBlocked(a.address));
          if (addresses.length === 0 || refused) {
            const error = new FetchRefused(`Refused: ${hostname} resolves to a private or local address (${refused?.address ?? "none"})`);
            return callback(error, "", 0);
          }
          if (options.all) return callback(null, addresses);
          callback(null, addresses[0].address, addresses[0].family);
        },
        (error: NodeJS.ErrnoException) => callback(error, "", 0),
      );
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(url, { method: "GET", headers, lookup, timeout, agent: false }, resolve);
      req.on("timeout", () => req.destroy(new Error(`${url.origin} didn't answer within ${timeout / 1000} s`)));
      req.on("error", (error) => reject(error instanceof FetchRefused ? error : new Error(`${url.origin}: ${error.message}`)));
      req.end();
    });
  }
}

async function readBody(response: IncomingMessage, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
  const stream =
    encoding === "gzip" ? response.pipe(createGunzip()) : encoding === "deflate" ? response.pipe(createInflate()) : encoding === "br" ? response.pipe(createBrotliDecompress()) : response;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      return { body: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true };
    }
  }
  return { body: Buffer.concat(chunks), truncated: false };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", processEntities: true });

/** A body as items, JSON and text. Feeds and JSON cut off at maxKb can't be read. */
function parse(url: string, body: Buffer, contentType: string, truncated: boolean, itemsAt?: string): Pick<Document, "items" | "json" | "text" | "title"> {
  const raw = body.toString("utf8");
  const start = raw.trimStart().slice(0, 200).toLowerCase();
  if (/json/.test(contentType) || (!/html|xml/.test(contentType) && /^[[{]/.test(start))) {
    if (truncated) throw new Error(`${url}: the JSON is larger than maxKb`);
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${url}: not valid JSON`);
    }
    const list = itemsAt ? valueAt(json as Item, itemsAt) : json;
    const items = Array.isArray(list) ? (list as unknown[]).map((entry) => ({ ...(isObject(entry) ? entry : { value: entry }), source: url })) : [];
    return { items, json, text: raw.slice(0, MAX_TEXT), title: null };
  }
  if (/rss|atom|xml/.test(contentType) || /^(<\?xml|<rss|<feed)/.test(start)) {
    if (truncated) throw new Error(`${url}: the feed is larger than maxKb`);
    const feed = feedOf(url, xml.parse(raw) as Item);
    if (feed) return { ...feed, json: null, text: "" };
  }
  return { items: [], json: null, text: pageText(raw).slice(0, MAX_TEXT), title: titleOf(raw) };
}

/** RSS 2.0 (channel.item) or Atom (feed.entry) as items; null when it is neither. */
function feedOf(url: string, doc: Item): { items: Item[]; title: string | null } | null {
  const rss = valueAt(doc, "rss.channel") as Item | undefined;
  if (rss) {
    return {
      title: textOf(rss.title),
      items: list(rss.item).map((entry) => ({
        title: textOf(entry.title) ?? "",
        url: textOf(entry.link) ?? "",
        published: textOf(entry.pubDate) ?? textOf(entry["dc:date"]),
        summary: summaryOf(entry.description),
        id: textOf(entry.guid) ?? textOf(entry.link),
        source: url,
      })),
    };
  }
  const atom = doc.feed as Item | undefined;
  if (atom) {
    return {
      title: textOf(atom.title),
      items: list(atom.entry).map((entry) => {
        const links = list(entry.link);
        const link = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
        return {
          title: textOf(entry.title) ?? "",
          url: (link?.["@href"] as string | undefined) ?? "",
          published: textOf(entry.published) ?? textOf(entry.updated),
          summary: summaryOf(entry.summary ?? entry.content),
          id: textOf(entry.id),
          source: url,
        };
      }),
    };
  }
  return null;
}

function list(value: unknown): Item[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? (value as unknown[]) : [value]).map((v) => (isObject(v) ? v : { "#text": v }));
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (isObject(value)) return textOf(value["#text"]);
  return null;
}

function summaryOf(value: unknown): string | null {
  const text = textOf(value);
  return text ? pageText(text).slice(0, MAX_SUMMARY) : null;
}

function isObject(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML as plain text: no scripts, styles or tags; entities decoded; whitespace collapsed. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity: string) => {
      if (entity.startsWith("#")) {
        const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function titleOf(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return title ? pageText(title) || null : null;
}
