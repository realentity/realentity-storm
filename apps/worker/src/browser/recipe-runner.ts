import { fillTemplate, onSite, siteOf, type Recipe } from "@realentity/storm-steps";
import { type Page } from "playwright";
import { blockingState } from "./blocking";
import { type Attention } from "../runner/step-executor";

export type Item = Record<string, string>;

/** The page no longer matches the recipe (docs/design.md §2.4): the step fails and the recipe is marked broken (M9-T7). */
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

/** The fields as one item read from the whole page (an item's own page, for a recipe's `detail`). */
export async function readPage(page: Page, fields: Recipe["fields"]): Promise<Item> {
  const [item] = await page.evaluate<Item[]>(`(${READ_ITEMS})(${JSON.stringify({ item: "html", fields })})`);
  return item ?? {};
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

/** How long a press of "Load more" or a scroll may take to show more items before the list counts as ended. */
const MORE_WAIT_MS = 10_000;

/**
 * Every page of the list, up to the recipe's maxPages and `maxItems`: page one from `url`, then its next page, or more
 * items on the same page ("Load more", scrolling). Stops at the last page (no next link, no more button, nothing new).
 * Only pages on the recipe's site are opened, and a press that leaves the site fails the read.
 */
export async function readList(page: Page, name: string, recipe: Recipe, options: ReadListOptions): Promise<{ items: Item[]; pages: number }> {
  const site = siteOf(name);
  const delay = options.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inPage = recipe.next?.kind === "more" || recipe.next?.kind === "scroll";
  const seen = new Set<string>();
  const items: Item[] = [];
  let url: string | null = fillTemplate(recipe.url, options.values, recipe.params);
  let pages = 0;

  while (pages < recipe.maxPages && items.length < options.maxItems) {
    if (pages === 0 || !inPage) {
      if (!url) break;
      if (!onSite(url, site)) throw new Error(`${name} would open ${url}, which is not on ${site}`);
      if (pages > 0) await delay(recipe.delayMs);
      await openListPage(page, url, recipe, options);
    } else {
      await delay(recipe.delayMs);
      const more = await loadMore(page, recipe, Math.min(options.timeout, MORE_WAIT_MS));
      if (!onSite(page.url(), site)) throw new Error(`${name} left ${site} for ${page.url()} on "Load more"`);
      if (!more) break;
    }
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
    if (!inPage) url = await nextUrl(page, recipe, options.values, pages);
  }
  return { items: items.slice(0, options.maxItems), pages };
}

/** Opens a page of the list and waits for its items (or its "no results"); a CAPTCHA or a block waits for the user. */
async function openListPage(page: Page, url: string, recipe: Recipe, options: ReadListOptions): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout });
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  const blocked = await blockingState(page);
  if (blocked) await options.attention.needMe(blocked, page.url());
  await page
    .locator(recipe.empty ? `${recipe.item}, ${recipe.empty}` : recipe.item)
    .first()
    .waitFor({ state: "attached", timeout: options.timeout })
    .catch(() => undefined);
}

/**
 * More items on the same page: "Load more" pressed, or the page scrolled to its bottom; true when more items came.
 * No button (gone, hidden or disabled: the last of them shown) or nothing new in time: the list has ended.
 */
async function loadMore(page: Page, recipe: Recipe, wait: number): Promise<boolean> {
  const before = await page.locator(recipe.item).count();
  if (recipe.next?.kind === "more") {
    const button = page.locator(recipe.next.selector).first();
    const ready = (await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false));
    if (!ready) return false;
    const pressed = await button
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!pressed) return false;
  } else {
    await page
      .locator(recipe.item)
      .last()
      .scrollIntoViewIfNeeded({ timeout: 2_000 })
      .catch(() => undefined);
    await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)").catch(() => undefined);
  }
  return page
    .waitForFunction(`document.querySelectorAll(${JSON.stringify(recipe.item)}).length > ${before}`, undefined, { timeout: wait })
    .then(() => true)
    .catch(() => false);
}

async function nextUrl(page: Page, recipe: Recipe, values: Record<string, string>, pagesRead: number): Promise<string | null> {
  if (recipe.next?.kind === "page") {
    return fillTemplate(recipe.next.url, { ...values, page: String(recipe.next.start + pagesRead - 1) }, recipe.params);
  }
  if (recipe.next?.kind !== "link") return null;
  const href = await page
    .locator(recipe.next.selector)
    .first()
    .getAttribute("href", { timeout: 1_000 })
    .catch(() => null);
  return href ? new URL(href, page.url()).href : null;
}
