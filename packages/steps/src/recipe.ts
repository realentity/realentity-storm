import { z } from "zod";

/**
 * A site recipe (docs/design.md §2.4): how to read a list from a site, as saved selectors, so `browser.extract` runs the same
 * way every time without an LLM. Versioned per name (`SiteRecipe`); runs use the latest version. Recipes only read:
 * they open pages on their own site and follow its "next page", nothing else.
 */

/** "<site>/<what>", e.g. "jobs.example.com/search": the site is the host the recipe may open. */
export const RECIPE_NAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[a-z0-9][a-z0-9-]{0,39}$/;
export const RecipeNameSchema = z.string().regex(RECIPE_NAME, 'a recipe name, e.g. "jobs.example.com/search"');

const Name = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, "a camelCase name");
const Selector = z.string().min(1).max(500);
/** A URL with {param} placeholders, filled URL-encoded. */
const Template = z.string().min(1).max(2000);

const FieldSchema = z
  .object({
    /** Inside the item; left out: the item itself. */
    selector: Selector.optional(),
    /** An attribute (href: resolved to an absolute URL); left out: the visible text. */
    attr: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional(),
    /** An item without it means the recipe no longer matches the page. */
    required: z.boolean().default(false),
  })
  .strict();

export const RecipeSchema = z
  .object({
    /** The list's first page, e.g. "https://jobs.example.com/jobs/{category}/?seniority={seniority}". */
    url: Template,
    /** The placeholders of `url`; a default makes one optional. */
    params: z.record(Name, z.object({ description: z.string().max(200).optional(), default: z.string().max(200).optional() }).strict()).default({}),
    /** One element per list item. */
    item: Selector,
    fields: z.record(Name, FieldSchema).refine((fields) => Object.keys(fields).length > 0, "at least one field"),
    /** The field that identifies an item (deduplication, JobPosting.url). */
    key: Name.default("url"),
    /** Shown instead of items when the search has no results: an empty list, not a broken recipe. */
    empty: Selector.optional(),
    /** The next page: a link to follow, or a URL with {page} (from `start`). */
    next: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("link"), selector: Selector }).strict(),
        z.object({ kind: z.literal("page"), url: Template, start: z.number().int().min(0).max(100).default(2) }).strict(),
      ])
      .optional(),
    maxPages: z.number().int().min(1).max(20).default(5),
    /** Between pages: a person's pace, not a crawler's. */
    delayMs: z.number().int().min(500).max(10_000).default(1_500),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;

export function siteOf(name: string): string {
  return name.split("/")[0];
}

/** The site itself or its www. host: a recipe never leaves it. */
export function onSite(url: string, site: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && (host === site || host === `www.${site}`);
  } catch {
    return false;
  }
}

/** The placeholders in a template, in order. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]);
}

/** Fills {name} placeholders, URL-encoded; a missing value without a default is an error. */
export function fillTemplate(template: string, values: Record<string, string>, params: Recipe["params"] = {}): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name: string) => {
    const value = values[name] ?? params[name]?.default;
    if (value === undefined) throw new Error(`The recipe needs "${name}" (params.${name})`);
    return encodeURIComponent(value);
  });
}

/** What is wrong with a recipe beyond its shape (the schema checks that), as messages; empty: fine. */
export function recipeProblems(name: string, recipe: Recipe): string[] {
  const problems: string[] = [];
  const site = siteOf(name);
  if (!(recipe.key in recipe.fields)) problems.push(`key "${recipe.key}" is not one of the fields`);
  const declared = new Set(Object.keys(recipe.params));
  const templates = [recipe.url, ...(recipe.next?.kind === "page" ? [recipe.next.url] : [])];
  for (const template of templates) {
    for (const placeholder of placeholders(template)) {
      if (placeholder !== "page" && !declared.has(placeholder)) problems.push(`{${placeholder}} in ${template} is not in params`);
    }
    const sample = template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, "x");
    if (!onSite(sample, site)) problems.push(`${template} is not on ${site}`);
  }
  if (placeholders(recipe.url).includes("page")) problems.push("{page} belongs in next.url, not url");
  if (recipe.next?.kind === "page" && !placeholders(recipe.next.url).includes("page")) problems.push("next.url has no {page}");
  return problems;
}
