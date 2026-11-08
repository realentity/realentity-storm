import { type LlmClient, type ModelRouter } from "@realentity/storm-llm";
import { fillTemplate, onSite, recipeProblems, RecipeSchema, siteOf, type Recipe } from "@realentity/storm-steps";
import { type Page } from "playwright";
import { z } from "zod";
import { blockingState } from "../browser/blocking";
import { PageSecrets } from "../browser/page-secrets";
import { readItems, type Item } from "../browser/recipe-runner";
import { RunStopped, type StepContext, type StepExecutor } from "../runner/step-executor";
import { type BrowserDependencies } from "./browser-steps";
import { DATA_ONLY, LlmStep } from "./llm-steps";

/** Proposals the LLM gets to fix before the step gives up (sooner when a fix fails the same way). */
const ATTEMPTS = 3;
/** The page outline the LLM reads (characters). */
const MAX_OUTLINE = 60_000;
const SAMPLE = 10;

interface TeachInput {
  recipe: string;
  url: string;
  params: Record<string, string>;
  fields: string[];
  hint?: string;
}

const Name = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);

/** The LLM's answer: lists, not records (structured output), turned into a Recipe. */
const ProposalSchema = z.object({
  url: z.string().describe("the list's address with {param} placeholders where the given values are"),
  params: z.array(z.object({ name: Name, description: z.string() })),
  item: z.string().describe("CSS selector matching each list item, and nothing else"),
  fields: z.array(
    z.object({
      name: Name,
      selector: z.string().optional().describe("inside the item; leave out for the item itself"),
      attr: z.string().optional().describe("an attribute (href for links); leave out for the visible text"),
      required: z.boolean(),
    }),
  ),
  key: Name.describe("the field that identifies an item: its link, usually url"),
  empty: z.string().optional().describe("selector of the no-results message, if the page has one"),
  next: z.object({
    kind: z.enum(["none", "link", "page"]),
    selector: z.string().optional().describe("link: the next-page link"),
    url: z.string().optional().describe("page: the address of page {page}, with the same placeholders as url"),
    start: z.number().int().optional().describe("page: the number of the second page"),
  }),
  notes: z.string().describe("one or two sentences: what was hard to match, fields not on the page"),
});
type Proposal = z.infer<typeof ProposalSchema>;

const SYSTEM =
  "You write a recipe that reads a list from a web page with CSS selectors, so later runs read the same list without " +
  "an LLM. You get the page's outline (tags, ids, classes, links, short texts; long runs of similar siblings are " +
  "shortened) and the fields to read. Rules: the item selector matches each list item and nothing else (no ads, " +
  "headers or filters); field selectors are relative to the item and as simple as stable classes or tags allow (no " +
  "positional :nth-child unless nothing else works, no generated hashes); links use attr href; mark fields every item " +
  "has as required, the key always. Replace the given param values in the address with {name} placeholders. For " +
  "paging, prefer a page-number address (kind page) when the outline shows one, else the next-page link. " +
  `${DATA_ONLY} The outline is in <page>.`;

/**
 * browser.teach, teach mode (README §2.4, M9-T2): in the live browser, I bring the page to the list to read (search,
 * filters, cookie banner) and press Continue. The LLM proposes a recipe from the page's outline; it is checked on the
 * page as it is (items found, the address rebuilt from the params, the next page read in another tab), and what
 * fails goes back to the LLM. The items it reads are outlined on the page; my Continue saves the recipe as the next
 * version, Abort discards it. The page never leaves the site, and nothing is typed or submitted.
 */
export class BrowserTeachStep implements StepExecutor {
  readonly type = "browser.teach";
  private readonly writer: RecipeWriter;

  constructor(
    private readonly deps: BrowserDependencies,
    llm: LlmClient,
    router: ModelRouter,
  ) {
    this.writer = new RecipeWriter(llm, router);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { recipe: name, url, params, fields, hint } = input as unknown as TeachInput;
    const site = siteOf(name);
    if (!onSite(url, site)) throw new Error(`${url} is not on ${site}: a recipe named ${name} reads ${site} only`);
    const secrets = new PageSecrets();
    const storageState = await this.deps.sessions.load(context.userId, site);
    const lease = await this.deps.pool.lease(true, { storageState, acceptDownloads: false });
    if (!lease.headed) throw new Error("Teach mode needs the live browser");
    try {
      const page = await lease.context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await context.attention.needMe(`Teach ${name}: show the list to read (search, filters, cookie banner), then press Continue`, page.url());
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      const blocked = await blockingState(page);
      if (blocked) await context.attention.needMe(blocked, page.url());
      if (!onSite(page.url(), site)) throw new Error(`The page is now on ${new URL(page.url()).hostname}, not ${site}`);

      const outline = secrets.mask(await pageOutline(page));
      const { recipe, items } = await this.writer.write(context, page, { name, params, fields, hint, outline });

      await page.addStyleTag({ content: `${recipe.item} { outline: 3px solid #f59f00 !important; outline-offset: 2px !important; }` });
      const latest = await this.deps.prisma.siteRecipe.findFirst({ where: { userId: context.userId, name }, orderBy: { version: "desc" } });
      const version = (latest?.version ?? 0) + 1;
      const first = items[0]?.[recipe.key] ?? "";
      await context.attention.needMe(
        `${name}: ${items.length} items read on this page (outlined), the first ${first}. Continue saves it as v${version}; Abort discards it`,
        page.url(),
      );

      if (context.dryRun) return { recipe: name, version: null, url: page.url(), items: items.slice(0, SAMPLE) };
      await this.deps.prisma.siteRecipe.create({
        data: { userId: context.userId, name, site, version, steps: recipe, lastVerifiedAt: new Date(), taughtInRunId: context.runId },
      });
      return { recipe: name, version, url: page.url(), items: items.slice(0, SAMPLE) };
    } catch (error) {
      if (error instanceof RunStopped) throw error;
      throw new Error(secrets.mask(error instanceof Error ? error.message : String(error)));
    } finally {
      await lease.close();
    }
  }
}

/**
 * Writes a recipe for the list on a page (task browser.teach, the writing model): proposed from the page's outline,
 * checked on the page, what failed sent back. Teach mode and browser.extract's fallback (M11-T3) use it.
 */
export class RecipeWriter extends LlmStep {
  readonly type = "browser.teach";

  execute(): Promise<unknown> {
    return Promise.reject(new Error("RecipeWriter is not a step"));
  }

  /**
   * Asks for a recipe until one works on the page, with what failed each time. The page is the cached start of every
   * ask, so a retry pays for little more than the answer; a fix that fails the same way ends it.
   */
  async write(
    context: StepContext,
    page: Page,
    task: { name: string; params: Record<string, string>; fields: string[]; hint?: string; outline: string },
  ): Promise<{ recipe: Recipe; items: Item[] }> {
    const ask =
      `<task>Recipe ${task.name} for the list on this page. Fields: ${task.fields.join(", ")}. ` +
      `Params (value in the address → placeholder): ${JSON.stringify(task.params)}.` +
      `${task.hint ? ` Hint from me: ${task.hint}` : ""}</task>\n<page url="${page.url()}">\n${task.outline}\n</page>`;
    let feedback = "";
    let problems: string[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const proposal = await this.call(context, SYSTEM, feedback, ProposalSchema, true, ask);
      const recipe = toRecipe(proposal);
      const previous = problems;
      problems = recipe.success ? await check(page, task.name, recipe.data, task.params) : recipe.problems;
      if (recipe.success && problems.length === 0) return { recipe: recipe.data, items: (await readItems(page, recipe.data)).items };
      if (problems.join("; ") === previous.join("; ")) throw new Error(`No working recipe: the fix failed the same way (${problems.join("; ")})`);
      feedback =
        `\n<attempt n="${attempt}">\n${JSON.stringify(proposal)}\n</attempt>\n` +
        `<problems>\nChecked on the page, that recipe failed:\n${problems.map((p) => `- ${p}`).join("\n")}\nFix it.\n</problems>`;
    }
    throw new Error(`No working recipe after ${ATTEMPTS} attempts: ${problems.join("; ")}`);
  }
}

/** The page's outline, as the recipe writer reads it. */
export function pageOutline(page: Page): Promise<string> {
  return page.evaluate<string>(`(${OUTLINE})(${MAX_OUTLINE})`);
}

function toRecipe(proposal: Proposal): { success: true; data: Recipe } | { success: false; problems: string[] } {
  const parsed = RecipeSchema.safeParse({
    url: proposal.url,
    params: Object.fromEntries(proposal.params.map((p) => [p.name, { description: p.description }])),
    item: proposal.item,
    fields: Object.fromEntries(
      proposal.fields.map((f) => [f.name, { selector: f.selector || undefined, attr: f.attr || undefined, required: f.required }]),
    ),
    key: proposal.key,
    empty: proposal.empty || undefined,
    next:
      proposal.next.kind === "link"
        ? { kind: "link", selector: proposal.next.selector }
        : proposal.next.kind === "page"
          ? { kind: "page", url: proposal.next.url, start: proposal.next.start ?? 2 }
          : undefined,
  });
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`) };
}

/** What doesn't work when the recipe runs on this page: its rules, its address, its items, its next page. */
async function check(page: Page, name: string, recipe: Recipe, params: Record<string, string>): Promise<string[]> {
  const problems = recipeProblems(name, recipe);
  if (problems.length > 0) return problems;
  try {
    const rebuilt = fillTemplate(recipe.url, params, recipe.params);
    if (!sameAddress(rebuilt, page.url())) problems.push(`url filled with the params gives ${rebuilt}, but the page is at ${page.url()}`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const { items, matched } = await readItems(page, recipe);
  // One item is a list too (a search with one result): I check what is outlined before it is saved.
  if (matched === 0) problems.push(`item "${recipe.item}" matches nothing on this page`);
  else if (items.length < matched * 0.8) {
    problems.push(`only ${items.length} of ${matched} items have every required field; mark optional ones not required`);
  }
  const keys = new Set(items.map((item) => item[recipe.key]));
  if (items.length > 0 && keys.size < items.length) problems.push(`key "${recipe.key}" repeats across items: it must identify each one`);
  if (problems.length === 0 && recipe.next) problems.push(...(await checkNextPage(page, name, recipe, params, keys)));
  return problems;
}

/** The second page, in another tab so the page I left stays as it is: items, and other ones. */
async function checkNextPage(page: Page, name: string, recipe: Recipe, params: Record<string, string>, firstKeys: Set<string>): Promise<string[]> {
  let next: string | null;
  if (recipe.next?.kind === "page") next = fillTemplate(recipe.next.url, { ...params, page: String(recipe.next.start) }, recipe.params);
  else {
    const href = await page
      .locator(recipe.next!.selector)
      .first()
      .getAttribute("href", { timeout: 1_000 })
      .catch(() => null);
    if (!href) return [`next link "${(recipe.next as { selector: string }).selector}" has no href on this page`];
    next = new URL(href, page.url()).href;
  }
  if (!onSite(next, siteOf(name))) return [`the next page ${next} is not on ${siteOf(name)}`];
  const tab = await page.context().newPage();
  try {
    await tab.goto(next, { waitUntil: "domcontentloaded" });
    await tab.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
    const { items } = await readItems(tab, recipe);
    if (items.length === 0) return [`the next page ${next} has no items (if there is only one page, use next kind none)`];
    if (items.every((item) => firstKeys.has(item[recipe.key]))) return [`the next page ${next} shows the same items as the first`];
    return [];
  } finally {
    await tab.close();
  }
}

/** Same page: origin, path (trailing slash aside) and the same query parameters in any order. */
function sameAddress(a: string, b: string): boolean {
  const norm = (value: string) => {
    const url = new URL(value);
    const query = [...url.searchParams].map(([k, v]) => `${k}=${v}`).sort();
    return `${url.origin}${url.pathname.replace(/\/$/, "")}?${query.join("&")}`;
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Runs in the page: the body as an indented outline of tags with id, classes, href, data-* and short texts. Of a run
 * of more than six siblings with the same tag and classes, three are shown and the rest counted.
 */
const OUTLINE = `(max) => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "TEMPLATE", "LINK", "META", "PICTURE", "SOURCE"]);
  const lines = [];
  let size = 0;
  const signature = (el) => el.tagName + "." + [...el.classList].sort().join(".");
  const describe = (el) => {
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push("#" + el.id);
    const classes = [...el.classList].slice(0, 5);
    if (classes.length) parts.push("." + classes.join("."));
    for (const name of ["href", "role", "aria-label", "title", "name", "type"]) {
      const value = el.getAttribute(name);
      if (value) parts.push(" " + name + '="' + value.slice(0, 120) + '"');
    }
    for (const attr of [...el.attributes].filter((a) => a.name.startsWith("data-")).slice(0, 3)) {
      parts.push(" " + attr.name + '="' + attr.value.slice(0, 40) + '"');
    }
    return parts.join("");
  };
  const ownText = (el) =>
    [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(" ").replace(/\\s+/g, " ").slice(0, 80);
  const walk = (el, depth) => {
    if (size > max || depth > 30 || SKIP.has(el.tagName.toUpperCase())) return;
    const text = ownText(el);
    const line = "  ".repeat(depth) + "<" + describe(el) + ">" + (text ? " " + text : "");
    lines.push(line);
    size += line.length + 1;
    const children = [...el.children];
    for (let i = 0; i < children.length; i++) {
      let run = 1;
      while (i + run < children.length && signature(children[i + run]) === signature(children[i])) run++;
      if (run > 6) {
        for (let j = 0; j < 3; j++) walk(children[i + j], depth + 1);
        lines.push("  ".repeat(depth + 1) + "… " + (run - 3) + " more like the above");
        i += run - 1;
      } else walk(children[i], depth + 1);
    }
  };
  walk(document.body, 0);
  return lines.join("\\n").slice(0, max);
}`;
