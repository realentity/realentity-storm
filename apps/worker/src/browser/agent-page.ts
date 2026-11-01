import { type ElementTarget } from "@ai-me/steps";
import { type BrowserContext, type Page, type Request, type Route } from "playwright";
import { HONEYPOT, HUMAN_CHECK } from "./form-reader";

/** The outline the agent reads (characters). */
const MAX_OUTLINE = 15_000;
/** A typed value shorter than this is too common to look for in requests ("1", "no"). */
const MIN_TRACKED = 3;

/**
 * In-page helpers shared by the scripts below (strings: the worker has no DOM types): an element's role and
 * accessible name, as near to the browser's own as the agent needs, and a selector that finds it again.
 */
const HELPERS = `
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const esc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\\\]/g, "\\\\$&"));
  const HUMAN = new RegExp(${JSON.stringify(HUMAN_CHECK.source)}, "i");
  const HONEY = new RegExp(${JSON.stringify(HONEYPOT.source)}, "i");
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"], [contenteditable=""]';
  const TEXT_INPUTS = ["text", "email", "tel", "url", "number", "search", "date", "datetime-local", "month", "week", "time"];
  const typeOf = (el) => (el.getAttribute("type") || "text").toLowerCase();
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = typeOf(el);
      if (type === "checkbox" || type === "radio") return type;
      if (type === "file") return "file";
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  const labelled = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = clean(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
      if (text) return text;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (el.id) {
      const label = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (label) return clean(label.innerText || label.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) return clean(wrapping.innerText || wrapping.textContent);
    return "";
  };
  const nameOf = (el) => {
    const role = roleOf(el);
    const own = labelled(el);
    if (own) return own.slice(0, 300);
    if (role === "button" || role === "link" || role === "tab" || role === "menuitem" || role === "option") {
      const text = clean(el.innerText || el.textContent) || clean(el.getAttribute("value")) || clean(el.getAttribute("title")) ||
        clean(el.querySelector("img[alt]")?.getAttribute("alt"));
      if (text) return text.slice(0, 300);
    }
    const hint = clean(el.getAttribute("placeholder") || el.getAttribute("title"));
    if (hint) return hint.slice(0, 300);
    // A box whose text sits beside it (consent boxes): the nearest text up to three levels up.
    let node = el.parentElement;
    for (let level = 0; level < 3 && node && node !== document.body; level++, node = node.parentElement) {
      const text = clean(node.innerText || node.textContent);
      if (text) return text.length <= 300 ? text : text.slice(0, 300);
    }
    return clean(el.getAttribute("name")).slice(0, 300);
  };
  const submits = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return ["submit", "image"].includes(typeOf(el)) && !!el.form;
    return tag === "button" && (el.getAttribute("type") || "submit").toLowerCase() === "submit" && !!el.form;
  };
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const generated = (id) => /^:|\\d{4,}/.test(id);
  const cssOf = (el) => {
    if (el.id && !generated(el.id) && unique("#" + esc(el.id))) return "#" + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute("name");
    if (name) {
      let selector = tag + '[name="' + esc(name) + '"]';
      if (unique(selector)) return selector;
      if (el.value && ["radio", "checkbox"].includes(typeOf(el))) {
        selector += '[value="' + esc(el.value) + '"]';
        if (unique(selector)) return selector;
      }
    }
    for (const attr of ["data-testid", "data-test", "data-qa", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (value && unique(tag + "[" + attr + '="' + esc(value) + '"]')) return tag + "[" + attr + '="' + esc(value) + '"]';
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node !== el && node.id && !generated(node.id) && unique("#" + esc(node.id))) {
        parts.unshift("#" + esc(node.id));
        return parts.join(" > ");
      }
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === node.tagName) index++;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    parts.unshift("body");
    return parts.join(" > ");
  };
  const fileInputOf = (el) => {
    if (el.tagName === "INPUT" && typeOf(el) === "file") return el;
    const inside = el.querySelector('input[type="file"]');
    if (inside) return inside;
    const label = el.closest("label");
    if (label?.control?.type === "file") return label.control;
    return el.parentElement?.querySelector('input[type="file"]') || null;
  };
`;

/**
 * Runs in the page: the agent's view of it (README §2.4: the accessibility outline). One line per interactive element
 * with a ref (data-aime-ref, kept across outlines) the tools take, its role, name and state; headings and text between
 * them. Passwords, hidden inputs and honeypots are left out; a person check is marked as mine. When the page is long,
 * text goes first, then the outline is cut.
 */
const OUTLINE = `(max) => {
  ${HELPERS}
  window.__aimeRef = window.__aimeRef || 0;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "HEAD"]);
  const shown = (el) => el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const lines = [];
  const line = (kind, text) => lines.push({ kind, text });
  const describe = (el) => {
    const role = roleOf(el);
    const name = nameOf(el);
    const ref = el.getAttribute("data-aime-ref") || "e" + ++window.__aimeRef;
    el.setAttribute("data-aime-ref", ref);
    const parts = ["[" + ref + "] " + role + ' "' + name.slice(0, 150) + '"'];
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && role === "textbox" && typeOf(el) !== "text") parts.push(typeOf(el));
    if (el.required || el.getAttribute("aria-required") === "true") parts.push("required");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (role === "checkbox" || role === "radio" || role === "switch") parts.push(el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked");
    if (role === "textbox" && (el.value || el.isContentEditable)) {
      const value = el.isContentEditable ? clean(el.textContent) : el.value;
      if (value) parts.push('value="' + value.slice(0, 80) + (value.length > 80 ? "…" : "") + '"');
    }
    if (tag === "select") {
      const options = [...el.options].filter((o) => o.value !== "" || clean(o.textContent)).map((o) => clean(o.textContent));
      const chosen = el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex]?.textContent) : "";
      if (chosen) parts.push('selected="' + chosen + '"');
      parts.push("options: " + options.slice(0, 30).join(" | ") + (options.length > 30 ? " | …" : ""));
    }
    if (role === "combobox" && el.getAttribute("aria-expanded")) parts.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (role === "link") {
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("javascript:")) parts.push("→ " + new URL(href, location.href).href.slice(0, 120));
    }
    if (role === "file") {
      const attached = el.getAttribute("data-aime-attach");
      parts.push(attached ? "attaches " + attached + " after I approve" : "a file");
    }
    if (submits(el)) parts.push("submits the form");
    if (HUMAN.test(name)) parts.push("person check: only I answer it");
    line("element", parts.join(", "));
  };
  const walk = (el) => {
    if (SKIP.has(el.tagName.toUpperCase()) || el.closest("[hidden], [aria-hidden='true'], [inert]") === el) return;
    if (el.matches(INTERACTIVE)) {
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? typeOf(el) : "";
      const isFile = type === "file";
      if (type === "hidden" || type === "password") return;
      if (!isFile && !shown(el)) return;
      if (HONEY.test(nameOf(el))) return;
      describe(el);
      if (tag !== "select" && !el.querySelector(INTERACTIVE)) return;
    } else if (!shown(el)) {
      // Hidden containers may still hold a file input behind a styled button.
      for (const input of el.querySelectorAll('input[type="file"]')) if (!input.closest("[hidden], [aria-hidden='true'], [inert]")) describe(input);
      return;
    } else if (/^H[1-6]$/.test(el.tagName) && !el.querySelector(INTERACTIVE)) {
      line("heading", "# " + clean(el.innerText).slice(0, 150));
      return;
    } else if (el.tagName === "FORM") {
      line("heading", "form:");
    } else if (el.tagName === "DIALOG" || el.getAttribute("role") === "dialog") {
      line("heading", "dialog " + clean(el.getAttribute("aria-label")) + ":");
    }
    if (el.tagName !== "LABEL") {
      const own = clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
      if (own.length > 1) line("text", own.slice(0, 300));
    }
    for (const child of el.children) walk(child);
  };
  walk(document.body);
  const size = () => lines.reduce((total, l) => total + l.text.length + 1, 0);
  if (size() > max) for (const l of lines) if (l.kind === "text" && l.text.length > 80) l.text = l.text.slice(0, 80) + "…";
  let kept = lines;
  if (size() > max) {
    kept = [];
    for (const l of lines) {
      if (l.kind !== "text") kept.push(l);
      else if (kept[kept.length - 1]?.text !== "…") kept.push({ kind: "text", text: "…" });
    }
  }
  let out = kept.map((l) => l.text).join("\\n");
  if (out.length > max) out = out.slice(0, max) + "\\n… (the page goes on)";
  return out;
}`;

/** What the agent's ref stands for, and how browser.submit finds it again. */
export interface ElementInfo extends ElementTarget {
  tag: string;
  submits: boolean;
  human: boolean;
  /** Its file input (the element itself, or the one its styled button stands for). */
  fileCss: string | null;
  href: string | null;
}

const LOCATE = `(el) => {
  ${HELPERS}
  const file = fileInputOf(el);
  const href = el.tagName === "A" && el.getAttribute("href") ? new URL(el.getAttribute("href"), location.href).href : null;
  return {
    css: cssOf(el).slice(0, 500),
    role: roleOf(el),
    name: nameOf(el),
    tag: el.tagName.toLowerCase(),
    submits: submits(el),
    human: HUMAN.test(nameOf(el)),
    fileCss: file ? cssOf(file).slice(0, 500) : null,
    href,
  };
}`;

/**
 * Runs in the page: the element a recorded action meant, by its selector if that still is the same role and name,
 * else the one visible element with that role and name. Marked with data-aime-found, so a locator can act on it.
 */
const FIND = `(target) => {
  ${HELPERS}
  const same = (el) => roleOf(el) === target.role && nameOf(el).toLowerCase() === target.name.toLowerCase();
  let found = null;
  try {
    const all = [...document.querySelectorAll(target.css)];
    if (all.length === 1 && same(all[0])) found = all[0];
  } catch {}
  if (!found) {
    const matches = [...document.querySelectorAll(INTERACTIVE)].filter((el) => same(el) && (typeOf(el) === "file" || el.getClientRects().length > 0));
    if (matches.length === 1) found = matches[0];
  }
  if (!found) return null;
  window.__aimeFound = (window.__aimeFound || 0) + 1;
  const mark = "f" + window.__aimeFound;
  found.setAttribute("data-aime-found", mark);
  return mark;
}`;

/** Runs in the page: the labels of the visible person checks ("104-43="), which only I answer. */
const PERSON_CHECKS = `() => {
  ${HELPERS}
  return [...document.querySelectorAll("input, textarea")].filter((el) => el.getClientRects().length > 0 && HUMAN.test(nameOf(el))).map(nameOf);
}`;

/** Runs in the page: the visible required fields still empty (files aside), by name. */
const EMPTY_REQUIRED = `() => {
  ${HELPERS}
  return [...document.querySelectorAll("input, select, textarea")]
    .filter((el) => (el.required || el.getAttribute("aria-required") === "true") && el.getClientRects().length > 0)
    .filter((el) => !["file", "hidden", "password", "submit", "button"].includes(typeOf(el)) && !HUMAN.test(nameOf(el)))
    .filter((el) => (["checkbox", "radio"].includes(typeOf(el)) ? !el.checked && !(el.name && document.querySelector('[name="' + esc(el.name) + '"]:checked')) : !el.value))
    .map(nameOf);
}`;

export async function outline(page: Page): Promise<string> {
  return page.evaluate<string>(`(${OUTLINE})(${MAX_OUTLINE})`);
}

/** The element behind an outline ref (e12), or null when the page no longer has it. */
export async function locateRef(page: Page, ref: string): Promise<ElementInfo | null> {
  if (!/^e\d{1,6}$/.test(ref)) return null;
  if ((await page.locator(`[data-aime-ref="${ref}"]`).count()) !== 1) return null;
  // LOCATE is source text (no DOM types here): page.evaluate runs it on the element found by its ref.
  return page.evaluate<ElementInfo>(`(${LOCATE})(document.querySelector('[data-aime-ref="${ref}"]'))`);
}

/** The element of a recorded action on the page as it is now (a locator), or null. */
export async function findTarget(page: Page, target: ElementTarget): Promise<ReturnType<Page["locator"]> | null> {
  const mark = await page.evaluate<string | null>(`(${FIND})(${JSON.stringify(target)})`).catch(() => null);
  return mark ? page.locator(`[data-aime-found="${mark}"]`) : null;
}

export async function personChecks(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(${PERSON_CHECKS})()`).catch(() => []);
}

export async function emptyRequired(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(${EMPTY_REQUIRED})()`).catch(() => []);
}

/** The file input a ref stands for, marked as getting `document` after approval (the outline shows it). */
export async function markAttached(page: Page, fileCss: string, document: string): Promise<void> {
  await page
    .locator(fileCss)
    .first()
    .evaluate((el: { setAttribute(name: string, value: string): void }, name: string) => el.setAttribute("data-aime-attach", name), document)
    .catch(() => undefined);
}

/**
 * What a browser.agent page may send and where it may go (README §2.4, M11-S1/S3). Exploring, the page goes only to
 * allowed sites, posts no form, and no request carries a value the agent typed (in the address or the body, plain or
 * encoded): what it types is for the gate, and only browser.submit sends it. WebSockets are closed. Acting
 * (browser.submit), only the allowed sites hold: the approved values are meant to go. A redirect isn't routed again,
 * so a page's request is sent from here without following redirects, and where one leads is checked before the
 * browser goes on.
 */
export class SendGuard {
  private readonly typed = new Set<string>();
  private events: string[] = [];
  /** The first site a page was kept from (shop.product's error names it). */
  refusedHost: string | null = null;

  constructor(
    private readonly allowed: (host: string) => boolean,
    private readonly mode: "explore" | "act",
  ) {}

  async install(context: BrowserContext): Promise<void> {
    await context.route("**/*", (route, request) => this.handle(route, request));
    if (this.mode === "explore") {
      await context.routeWebSocket(/.*/, (ws) => {
        this.events.push(`the page opened a WebSocket to ${hostOf(ws.url()) || ws.url()}: closed, nothing is sent while exploring`);
        void ws.close().catch(() => undefined);
      });
    }
  }

  /** A value the agent typed: no request may carry it until the gate. */
  remember(value: string): void {
    if (value.trim().length >= MIN_TRACKED) this.typed.add(value);
  }

  /** What was blocked since the last call. */
  drain(): string[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private async handle(route: Route, request: Request): Promise<void> {
    const url = request.url();
    const host = hostOf(url);
    const navigation = request.isNavigationRequest();
    const page = navigation && mainFrame(request);
    if (page && host && !this.allowed(host)) {
      this.refusedHost ??= host;
      this.events.push(`blocked: ${host} is not one of the allowed sites`);
      return route.abort("blockedbyclient");
    }
    if (this.mode === "explore") {
      if (navigation && !["GET", "HEAD"].includes(request.method())) {
        this.events.push("blocked: the page tried to send a form; sending happens only after I approve");
        return route.abort("blockedbyclient");
      }
      const body = request.postData() ?? "";
      for (const value of this.typed) {
        if (carries(url, body, value)) {
          this.events.push(`blocked: the page tried to send what you typed to ${host || "the site"}; sending happens only after I approve`);
          return route.abort("blockedbyclient");
        }
      }
    }
    if (!page) return route.continue().catch(() => undefined);
    const response = await route.fetch({ maxRedirects: 0 }).catch(() => null);
    if (!response) return route.abort("failed").catch(() => undefined);
    const location = response.headers().location;
    if (location && response.status() >= 300 && response.status() < 400) {
      const next = new URL(location, url).href;
      const nextHost = hostOf(next);
      if (!nextHost || !this.allowed(nextHost)) {
        this.refusedHost ??= nextHost || next;
        this.events.push(`blocked: ${host} redirected to ${nextHost || next}, which is not one of the allowed sites`);
        return route.abort("blockedbyclient").catch(() => undefined);
      }
    }
    return route.fulfill({ response }).catch(() => undefined);
  }
}

function mainFrame(request: Request): boolean {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // Service workers' requests have no frame.
    return false;
  }
}

function carries(url: string, body: string, value: string): boolean {
  const encoded = encodeURIComponent(value);
  const variants = [value, encoded, encoded.replace(/%20/g, "+"), JSON.stringify(value).slice(1, -1)];
  return variants.some((variant) => url.includes(variant) || body.includes(variant));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
