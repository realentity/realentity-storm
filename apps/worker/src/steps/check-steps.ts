import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, connect, isIP, type LookupFunction } from "node:net";
import { type TLSSocket } from "node:tls";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { USER_AGENT } from "./http-steps";

const MAX_REDIRECTS = 5;
const DAY_MS = 86_400_000;

/**
 * M47: never checked, even from a field of mine: this machine (loopback), link-local (169.254.169.254 is the cloud's
 * metadata service), "this network", multicast and reserved ranges, IPv4 and IPv6.
 */
export function neverAddresses(): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fe80::", 10],
    ["ff00::", 8],
    ["fd00:ec2::", 64],
  ] as const)
    list.addSubnet(net, prefix, "ipv6");
  return list;
}

/** M47: private networks, the LAN, Docker's, Tailscale's (CGNAT 100.64.0.0/10, fd7a:115c:a1e0::/48): only from a field of mine. */
export function privateNetworks(): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
  ] as const)
    list.addSubnet(net, prefix, "ipv4");
  list.addSubnet("fc00::", 7, "ipv6");
  return list;
}

/** Names that are the cloud's metadata service, whatever they resolve to. */
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);

export interface CheckOptions {
  /** Never connected to; tests narrow it to reach their local server. */
  never?: BlockList;
  /** Private networks: only from a field of mine. */
  private?: BlockList;
  /** DNS; tests map their hosts. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** One ICMP echo: the round trip in ms, or why not; by default the system's ping. */
  ping?: (address: string, timeoutSeconds: number) => Promise<number>;
}

interface CheckResult {
  state: "up" | "down";
  up: boolean;
  ms: number | null;
  error: string | null;
  refused: boolean;
  checkedAt: string;
  address: string | null;
}

class Refused extends Error {}

/** Where a check may connect: resolved here, each address vetted; the connection goes to the one vetted (no second lookup). */
class AddressGuard {
  private readonly never: BlockList;
  private readonly private: BlockList;
  private readonly resolver: (host: string) => Promise<{ address: string; family: number }[]>;

  constructor(options: CheckOptions) {
    this.never = options.never ?? neverAddresses();
    this.private = options.private ?? privateNetworks();
    this.resolver = options.resolve ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  }

  async address(host: string, mayBePrivate: boolean): Promise<{ address: string; family: number }> {
    const name = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (METADATA_NAMES.has(name)) throw new Refused(`${name} is the cloud's metadata service: never checked`);
    const addresses = isIP(name) ? [{ address: name, family: isIP(name) }] : await this.resolver(name);
    if (addresses.length === 0) throw new Error(`${name} doesn't resolve`);
    for (const { address } of addresses) {
      const what = name === address ? `${address} is` : `${name} is ${address},`;
      if (this.blocked(this.never, address)) throw new Refused(`${what} a loopback, link-local or metadata address: never checked`);
      if (!mayBePrivate && this.blocked(this.private, address)) {
        throw new Refused(`${what} a private address: only an address you typed in a field of mine (a Monitor's) may be private`);
      }
    }
    return addresses[0];
  }

  private blocked(list: BlockList, address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    if (mapped) return list.check(mapped, "ipv4");
    return list.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  }
}

function result(start: number, address: string | null, outcome: { up: boolean; error?: string | null; refused?: boolean; ms?: number | null }): CheckResult {
  return {
    state: outcome.up ? "up" : "down",
    up: outcome.up,
    ms: outcome.ms === undefined ? (outcome.up ? Date.now() - start : null) : outcome.ms,
    error: outcome.error ?? null,
    refused: outcome.refused ?? false,
    checkedAt: new Date(start).toISOString(),
    address,
  };
}

interface HttpCheckInput {
  url: string;
  method: "GET" | "HEAD";
  expect?: number | null;
  ignoreTlsErrors: boolean;
  timeoutSeconds: number;
}

/**
 * http.check (M47-T1): whether a web address answers, how fast, its certificate's expiry. Never fails the step and
 * never reads the page: the answer's headers are enough, the body is dropped. Redirects are followed (each address
 * vetted again), at most 5. A private address only when the compiler marked the address a field of mine.
 */
export class HttpCheckStep implements StepExecutor {
  readonly type = "http.check";
  private readonly guard: AddressGuard;

  constructor(options: CheckOptions = {}) {
    this.guard = new AddressGuard(options);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, method, expect, ignoreTlsErrors, timeoutSeconds } = input as unknown as HttpCheckInput;
    const start = Date.now();
    let address: string | null = null;
    let cert: Date | null = null;
    try {
      let target = new URL(url);
      for (let hop = 0; ; hop++) {
        const vetted = await this.guard.address(target.hostname, context.privateHosts === true);
        address = vetted.address;
        const response = await this.ask(target, vetted, method, ignoreTlsErrors, timeoutSeconds * 1000 - (Date.now() - start));
        const status = response.statusCode ?? 0;
        if (target.protocol === "https:") cert = certExpiry(response) ?? cert;
        response.destroy();
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && expect !== status && hop < MAX_REDIRECTS) {
          target = new URL(location, target);
          if (target.protocol !== "http:" && target.protocol !== "https:") return this.outcome(start, address, cert, status, false, `redirected to ${target.protocol}`);
          continue;
        }
        const up = expect === undefined || expect === null ? status >= 200 && status < 400 : status === expect;
        return this.outcome(start, address, cert, status, up, up ? null : `status ${status}${expect === undefined || expect === null ? "" : `, not ${expect}`}`);
      }
    } catch (error) {
      const refused = error instanceof Refused;
      return { ...result(start, address, { up: false, error: (error as Error).message, refused }), status: null, ...certFields(cert) };
    }
  }

  private outcome(start: number, address: string | null, cert: Date | null, status: number, up: boolean, error: string | null) {
    return { ...result(start, address, { up, error }), status, ...certFields(cert) };
  }

  private ask(url: URL, vetted: { address: string; family: number }, method: string, insecure: boolean, timeout: number): Promise<IncomingMessage> {
    if (timeout <= 0) return Promise.reject(new Error("no answer in time"));
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [vetted]);
      else callback(null, vetted.address, vetted.family);
    };
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        { method, lookup, timeout, agent: false, headers: { "user-agent": USER_AGENT, accept: "*/*" }, ...(url.protocol === "https:" ? { rejectUnauthorized: !insecure } : {}) },
        resolve,
      );
      req.on("timeout", () => req.destroy(new Error(`no answer within ${Math.round(timeout / 1000)} s`)));
      req.on("error", reject);
      req.end();
    });
  }
}

function certExpiry(response: IncomingMessage): Date | null {
  const socket = response.socket as TLSSocket | null;
  const validTo = socket?.getPeerCertificate?.()?.valid_to;
  const date = validTo ? new Date(validTo) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function certFields(cert: Date | null): { certExpires: string | null; certDays: number | null } {
  return cert ? { certExpires: cert.toISOString().slice(0, 10), certDays: Math.floor((cert.getTime() - Date.now()) / DAY_MS) } : { certExpires: null, certDays: null };
}

interface NetCheckInput {
  host: string;
  kind: "tcp" | "ping";
  port?: number | null;
  timeoutSeconds: number;
}

/** net.check (M47-T2): a TCP connection to a port, or one ping. Never fails the step; the same address rules as http.check. */
export class NetCheckStep implements StepExecutor {
  readonly type = "net.check";
  private readonly guard: AddressGuard;
  private readonly ping: (address: string, timeoutSeconds: number) => Promise<number>;

  constructor(options: CheckOptions = {}) {
    this.guard = new AddressGuard(options);
    this.ping = options.ping ?? systemPing;
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { host, kind, port, timeoutSeconds } = input as unknown as NetCheckInput;
    const start = Date.now();
    if (kind === "tcp" && (port === undefined || port === null)) return result(start, null, { up: false, error: "a tcp check needs a port" });
    let address: string | null = null;
    try {
      const vetted = await this.guard.address(host, context.privateHosts === true);
      address = vetted.address;
      if (kind === "ping") return result(start, address, { up: true, ms: Math.round(await this.ping(vetted.address, timeoutSeconds)) });
      await tcpConnect(vetted.address, port!, timeoutSeconds * 1000);
      return result(start, address, { up: true });
    } catch (error) {
      return result(start, address, { up: false, error: (error as Error).message, refused: error instanceof Refused });
    }
  }
}

function tcpConnect(address: string, port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, timeout });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => socket.destroy(new Error(`no answer on port ${port} within ${Math.round(timeout / 1000)} s`)));
    socket.once("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "ECONNREFUSED" ? `port ${port} refused the connection` : error.message)));
  });
}

/** One echo with the system's ping (Linux's iputils, or Windows' in development); its round trip in ms. */
function systemPing(address: string, timeoutSeconds: number): Promise<number> {
  const windows = process.platform === "win32";
  const v6 = isIP(address) === 6;
  const args = windows ? ["-n", "1", "-w", String(timeoutSeconds * 1000), address] : [...(v6 ? ["-6"] : []), "-c", "1", "-W", String(timeoutSeconds), address];
  return new Promise((resolve, reject) => {
    execFile("ping", args, { timeout: (timeoutSeconds + 2) * 1000 }, (error, stdout, stderr) => {
      const time = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout)?.[1];
      if (!error && time) return resolve(Number(time));
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return reject(new Error("ping isn't available here: check a port with kind: tcp"));
      if (/permission|operation not permitted/i.test(`${stderr}${stdout}`)) return reject(new Error("ping isn't allowed here (ICMP): check a port with kind: tcp"));
      reject(new Error(`no answer to ping within ${timeoutSeconds} s`));
    });
  });
}
