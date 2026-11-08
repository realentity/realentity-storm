import { type PrismaClient } from "@realentity/storm-db";
import { hostMatches } from "@realentity/storm-shared";
import { XMLParser } from "fast-xml-parser";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { type CredentialVault } from "../secrets/credential-vault";
import { valueAt } from "./data-steps";

type Item = Record<string, unknown>;

const MAX_REDIRECTS = 5;
const MAX_TEXT = 50_000;
const MAX_SUMMARY = 2_000;
export const USER_AGENT = "RealEntity-Storm/1.0 (personal automation; reads feeds and pages it was told to)";

/**
 * Where http.fetch never connects (M13-S1): this machine, private networks, the CGNAT range 100.64.0.0/10 (Tailscale
 * and similar private networks), link-local (cloud metadata), multicast and reserved ranges, IPv4 and IPv6.
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
  headers?: Record<string, string>;
  query?: Record<string, string>;
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

const CREDENTIAL = /\{\{\s*cred:([a-z0-9._-]+)\s*\}\}/g;

/**
 * http.fetch (docs/design.md §2.3, M13-T1): GET without a browser, cookies or credentials. Only hosts on the pipeline's
 * allowedDomains, and only public addresses: the name is resolved here and the connection goes to the address checked
 * (no second lookup to rebind); every redirect is checked again. Feeds become items, JSON stays data, HTML becomes text.
 * With an ETag or Last-Modified from the last read, an unchanged address (304) gives what was read then.
 *
 * M29-T5: `headers` and `query` may hold {{cred:name}} (an API key). The vault opens it only for the address's host,
 * and every redirect must stay on the credential's hosts; such a read is never cached, and the key is masked in what
 * the server sends back and in errors. Outputs and errors name the address as written, without `query`.
 */
export class HttpFetchStep implements StepExecutor {
  readonly type = "http.fetch";
  private readonly http: PublicHttp;

  constructor(
    private readonly prisma: PrismaClient,
    options: HttpFetchOptions = {},
    private readonly vault?: CredentialVault,
  ) {
    this.http = new PublicHttp(options);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, urls, headers = {}, query = {}, itemsAt, maxItems, maxKb, timeoutSeconds } = input as unknown as FetchInput;
    if (!url === !urls) throw new Error("http.fetch reads `url` or `urls`: give one of them");
    const allowed = context.allowedDomains ?? [];
    const documents: Document[] = [];
    for (const address of urls ?? [url!]) {
      const keyed = await withCredentials(this.vault, this.type, address, headers, query, context.userId);
      try {
        documents.push(await this.read(address, keyed, context.userId, allowed, { itemsAt, maxBytes: maxKb * 1024, timeout: timeoutSeconds * 1000 }));
      } catch (error) {
        if (!keyed.secrets.length) throw error;
        const masked = keyed.mask(error instanceof Error ? error.message : String(error));
        throw error instanceof FetchRefused ? new FetchRefused(masked) : new Error(masked);
      }
    }
    return {
      items: documents.flatMap((d) => d.items).slice(0, maxItems),
      json: documents[0]?.json ?? null,
      text: documents[0]?.text ?? "",
      documents: documents.map(({ url: u, status, notModified, contentType, title, truncated }) => ({ url: u, status, notModified, contentType, title, truncated })),
    };
  }

  private async read(url: string, keyed: Keyed, userId: string, allowed: readonly string[], options: { itemsAt?: string; maxBytes: number; timeout: number }): Promise<Document> {
    const keys = keyed.secrets.length > 0;
    // A read with a key isn't cached: what it got belongs to that key.
    const cached = keys ? null : await this.prisma.httpCache.findUnique({ where: { userId_url: { userId, url: keyed.target } } });
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/json, text/html;q=0.9, */*;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      ...(cached?.lastModified ? { "if-modified-since": cached.lastModified } : {}),
      ...keyed.headers,
    };
    // Every hop of a read with a key stays on the hosts each of its credentials allows.
    const onHop = keys
      ? async (hop: URL) => {
          for (const name of keyed.names) await this.vault!.revealFor(userId, name, hop.hostname.toLowerCase());
        }
      : undefined;
    const response = await this.http.get(keyed.target, headers, allowed, { ...options, onHop });
    let body = keys ? Buffer.from(keyed.mask(response.body.toString("utf8"))) : response.body;
    let contentType = response.contentType;
    const notModified = response.status === 304 && cached !== null;
    if (notModified) {
      body = Buffer.from(cached.body);
      contentType = cached.contentType;
    } else if (response.status < 200 || response.status > 299) {
      throw new Error(`${url} answered ${response.status}`);
    } else if (!keys && !response.truncated && (response.etag || response.lastModified)) {
      const data = { etag: response.etag, lastModified: response.lastModified, contentType, body: new Uint8Array(body), fetchedAt: new Date() };
      await this.prisma.httpCache.upsert({ where: { userId_url: { userId, url: keyed.target } }, create: { userId, url: keyed.target, ...data }, update: data });
    }
    return { url, status: response.status, notModified, contentType, truncated: response.truncated, ...parse(url, body, contentType, response.truncated, options.itemsAt) };
  }
}

/** A read's address with its `query`, and its headers with their credentials opened (M29-T5). */
interface Keyed {
  target: string;
  headers: Record<string, string>;
  /** The credentials used: each hop is checked against them. */
  names: string[];
  secrets: string[];
  mask(text: string): string;
}

/** The address with `query`, and the headers, their {{cred:…}} opened by the vault for the address's host. */
async function withCredentials(
  vault: CredentialVault | undefined,
  type: string,
  address: string,
  headers: Record<string, string>,
  query: Record<string, string>,
  userId: string,
): Promise<Keyed> {
  const host = new URL(address).hostname.toLowerCase();
  const names = new Set<string>();
  const secrets: string[] = [];
  const open = async (text: string): Promise<string> => {
    let out = text;
    for (const [reference, name] of text.matchAll(CREDENTIAL)) {
      if (!vault) throw new Error(`${type} can't use credentials here ("${name}")`);
      const { secret } = await vault.revealFor(userId, name, host);
      names.add(name);
      secrets.push(secret);
      out = out.replace(reference, secret);
    }
    return out;
  };
  const target = new URL(address);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, await open(value));
  const opened: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) opened[name.toLowerCase()] = await open(value);
  const mask = (text: string) => secrets.reduce((masked, secret) => masked.split(secret).join("•••"), text);
  return { target: target.href, headers: opened, names: [...names], secrets, mask };
}

interface RequestInput {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  timeoutSeconds: number;
}

/**
 * http.request (M29-T6): one POST, PUT, PATCH or DELETE to an API, after the user approved its payload at the gate. Its host
 * was checked by the policy (a domain target); here it must still be a public address, and a redirect isn't followed
 * (a 3xx comes back as an answer that didn't succeed). A body is sent as JSON. Keys as in http.fetch: opened for the
 * address's host, masked in the answer and in errors. An answer other than 2xx fails the step with its status.
 */
export class HttpRequestStep implements StepExecutor {
  readonly type = "http.request";
  private readonly http: PublicHttp;

  constructor(options: HttpFetchOptions = {}, private readonly vault?: CredentialVault) {
    this.http = new PublicHttp(options);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { method, url, headers = {}, query = {}, body, timeoutSeconds } = input as unknown as RequestInput;
    const keyed = await withCredentials(this.vault, this.type, url, headers, query, context.userId);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const sent: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/json, */*;q=0.8",
      ...(data ? { "content-type": "application/json" } : {}),
      ...keyed.headers,
    };
    let response: HttpResponse;
    try {
      response = await this.http.request(keyed.target, method, sent, data, context.allowedDomains ?? [], { maxBytes: 1024 * 1024, timeout: timeoutSeconds * 1000 });
    } catch (error) {
      const masked = keyed.mask(error instanceof Error ? error.message : String(error));
      throw error instanceof FetchRefused ? new FetchRefused(masked) : new Error(masked);
    }
    const text = keyed.mask(response.body.toString("utf8"));
    if (response.status < 200 || response.status > 299) throw new Error(`${method} ${url} answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    let json: unknown = null;
    if (/json/.test(response.contentType) && text.trim()) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, text: text.slice(0, MAX_TEXT) };
  }
}

export interface HttpResponse {
  status: number;
  /** Where the last redirect led. */
  url: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  body: Buffer;
  truncated: boolean;
}

/**
 * GETs to public addresses only (http.fetch, shop.product): the host must be on the allowed list, its name is resolved
 * here and the connection goes to the address checked (no second lookup to rebind); every redirect is checked again.
 */
export class PublicHttp {
  private readonly blocked: BlockList;
  private readonly resolve: NonNullable<HttpFetchOptions["resolve"]>;

  constructor(options: HttpFetchOptions = {}) {
    this.blocked = options.blocked ?? privateAddresses();
    this.resolve = options.resolve ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  }

  /** Refuses (FetchRefused) an address a GET here would refuse, without sending anything: for the browser's first page. */
  async assertPublic(address: string, allowed: readonly string[]): Promise<void> {
    const url = new URL(address);
    this.check(url, allowed);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return;
    const addresses = await this.resolve(host);
    const refused = addresses.find((a) => this.isBlocked(a.address));
    if (addresses.length === 0 || refused) throw new FetchRefused(`Refused: ${host} resolves to a private or local address (${refused?.address ?? "none"})`);
  }

  /** A GET, following redirects, each address checked; the body up to maxBytes (decompressed). */
  async get(
    start: string,
    headers: Record<string, string>,
    allowed: readonly string[],
    { maxBytes, timeout, onHop }: { maxBytes: number; timeout: number; onHop?: (url: URL) => Promise<void> },
  ): Promise<HttpResponse> {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      this.check(url, allowed);
      if (onHop) await onHop(url);
      const response = await this.send(url, headers, timeout);
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && location) {
        response.resume();
        if (hop >= MAX_REDIRECTS) throw new Error(`${start}: more than ${MAX_REDIRECTS} redirects`);
        url = new URL(location, url);
        continue;
      }
      return answer(url, response, await readBody(response, maxBytes));
    }
  }

  /** One request with any method and a body, no redirect followed (http.request): a 3xx comes back as it is. */
  async request(
    address: string,
    method: string,
    headers: Record<string, string>,
    body: Buffer | null,
    allowed: readonly string[],
    { maxBytes, timeout }: { maxBytes: number; timeout: number },
  ): Promise<HttpResponse> {
    const url = new URL(address);
    this.check(url, allowed);
    const response = await this.send(url, body ? { ...headers, "content-length": String(body.length) } : headers, timeout, method, body);
    return answer(url, response, await readBody(response, maxBytes));
  }

  check(url: URL, allowed: readonly string[]): void {
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

  private send(url: URL, headers: Record<string, string>, timeout: number, method = "GET", body: Buffer | null = null): Promise<IncomingMessage> {
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
      const req = request(url, { method, headers, lookup, timeout, agent: false }, resolve);
      req.on("timeout", () => req.destroy(new Error(`${url.origin} didn't answer within ${timeout / 1000} s`)));
      req.on("error", (error) => reject(error instanceof FetchRefused ? error : new Error(`${url.origin}: ${error.message}`)));
      req.end(body ?? undefined);
    });
  }
}

function answer(url: URL, response: IncomingMessage, { body, truncated }: { body: Buffer; truncated: boolean }): HttpResponse {
  const header = (name: string) => {
    const value = response.headers[name];
    return typeof value === "string" ? value : null;
  };
  return {
    status: response.statusCode ?? 0,
    url: url.href,
    contentType: (header("content-type") ?? "").split(";")[0].trim().toLowerCase(),
    etag: header("etag"),
    lastModified: header("last-modified"),
    body,
    truncated,
  };
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
