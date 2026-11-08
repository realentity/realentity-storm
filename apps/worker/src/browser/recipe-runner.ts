import { fillTemplate, onSite, siteOf, type Recipe } from "@realentity/storm-steps";
import { type Page } from "playwright";
import { blockingState } from "./blocking";
import { type Attention } from "../runner/step-executor";

export type Item = Record<string, string>;

/** The page no longer matches the recipe (README §2.4): the step fails and the recipe is marked broken (M9-T7). */
export class RecipeBroken extends Error {}

/** Runs in the page (a string: the worker has no DOM types): each item's fields, text or attribute (links absolute). */
const READ_ITEMS = `(spec) => {
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim();
  return [...document.querySelectorAll(spec.item)].slice(0, 500).map((element) => {
    const out = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      const target = field.selector ? element.querySelector(field.selector) : element;
      if (!target) continue;
      let value;
      if (!field.attr) value = clean(target.innerText || target.textContent);
      else {
        const raw = target.getAttribute(field.attr);
        if (raw === null) continue;
        value = field.attr === "href" || field.attr === "src" ? new URL(raw, location.href).href : clean(raw);
      }
      if (value) out[name] = value.slice(0, 2000);
    }
    return out;
  });
}`;

/** The items the recipe sees on the page as it is now. Items without the key or a required field are left out. */
export async function readItems(page: Page, recipe: Recipe): Promise<{ items: Item[]; matched: number }> {
  const spec = { item: recipe.item, fields: recipe.fields };
  const all = await page.evaluate<Item[]>(`(${READ_ITEMS})(${JSON.stringify(spec)})`);
  const required = Object.entries(recipe.fields)
    .filter(([name, field]) => field.required || name === recipe.key)
    .map(([name]) => name);
  return { items: all.filter((item) => required.every((name) => item[name])), matched: all.length };
}

export interface ReadListOptions {
  /** Placeholder values (recipe params). */
  values: Record<string, string>;
  maxItems: number;
  timeout: number;
  attention: Attention;
  /** Between pages; tests make it short. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Every page of the list, up to the recipe's maxPages and `maxItems`: page one from `url`, then its next page. Stops
 * at the last page (no next link, an empty page, or nothing new). Only pages on the recipe's site are opened.
 */
export async function readList(page: Page, name: string, recipe: Recipe, options: ReadListOptions): Promise<{ items: Item[]; pages: number }> {
  const site = siteOf(name);
  const delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seen = new Set<string>();
  const items: Item[] = [];
  let url: string | null = fillTemplate(recipe.url, options.values, recipe.params);
  let pages = 0;

  while (url && pages < recipe.maxPages && items.length < options.maxItems) {
    if (!onSite(url, site)) throw new Error(`${name} would open ${url}, which is not on ${site}`);
    if (pages > 0) await delay(recipe.delayMs);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout });
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const blocked = await blockingState(page);
    if (blocked) await options.attention.needMe(blocked, page.url());
    await page
      .locator(recipe.empty ? `${recipe.item}, ${recipe.empty}` : recipe.item)
      .first()
      .waitFor({ state: "attached", timeout: options.timeout })
      .catch(() => undefined);
    pages++;

    const { items: found, matched } = await readItems(page, recipe);
    if (found.length === 0) {
      if (pages === 1 && !(recipe.empty && (await page.locator(recipe.empty).count()) > 0)) {
        throw new RecipeBroken(
          matched === 0
            ? `"${recipe.item}" matched nothing on ${page.url()}`
            : `none of the ${matched} items on ${page.url()} has every required field (${recipe.key} included)`,
        );
      }
      break;
    }
    const fresh = found.filter((item) => !seen.has(item[recipe.key]));
    if (fresh.length === 0) break;
    for (const item of fresh) seen.add(item[recipe.key]);
    items.push(...fresh);
    url = await nextUrl(page, recipe, options.values, pages);
  }
  return { items: items.slice(0, options.maxItems), pages };
}

async function nextUrl(page: Page, recipe: Recipe, values: Record<string, string>, pagesRead: number): Promise<string | null> {
  if (!recipe.next) return null;
  if (recipe.next.kind === "page") {
    return fillTemplate(recipe.next.url, { ...values, page: String(recipe.next.start + pagesRead - 1) }, recipe.params);
  }
  const href = await page
    .locator(recipe.next.selector)
    .first()
    .getAttribute("href", { timeout: 1_000 })
    .catch(() => null);
  return href ? new URL(href, page.url()).href : null;
}
