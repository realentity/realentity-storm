import { fillTemplate, onSite, RECIPE_NAME, recipeProblems, RecipeSchema } from "./recipe";

const recipe = (overrides: Record<string, unknown> = {}) =>
  RecipeSchema.parse({
    url: "https://dev.bg/company/jobs/{category}/",
    params: { category: {} },
    item: ".job-list-item",
    fields: { url: { selector: "a.overlay-link", attr: "href", required: true }, title: { selector: ".job-title", required: true } },
    next: { kind: "page", url: "https://dev.bg/company/jobs/{category}/?_paged={page}" },
    ...overrides,
  });

describe("recipes", () => {
  it("names a site and what is read there", () => {
    expect(RECIPE_NAME.test("dev.bg/search")).toBe(true);
    expect(RECIPE_NAME.test("jobs.localhost/search")).toBe(true);
    for (const name of ["dev.bg", "/search", "dev.bg/Search", "https://dev.bg/search", "dev/search"]) expect(RECIPE_NAME.test(name)).toBe(false);
  });

  it("stays on its site: the host or its www. host, http(s) only", () => {
    expect(onSite("https://dev.bg/x", "dev.bg")).toBe(true);
    expect(onSite("https://www.dev.bg/x", "dev.bg")).toBe(true);
    for (const url of ["https://dev.bg.evil.net/x", "https://evil.net/?dev.bg", "javascript:alert(1)", "ftp://dev.bg/", "not a url"]) {
      expect(onSite(url, "dev.bg")).toBe(false);
    }
  });

  it("fills placeholders URL-encoded, from the values or the param's default", () => {
    const params = { city: { default: "София" } };
    expect(fillTemplate("https://dev.bg/?q={q}&city={city}", { q: "C# & .NET" }, params)).toBe(
      "https://dev.bg/?q=C%23%20%26%20.NET&city=%D0%A1%D0%BE%D1%84%D0%B8%D1%8F",
    );
    expect(() => fillTemplate("https://dev.bg/{q}/", {})).toThrow('The recipe needs "q"');
  });

  it("is checked beyond its shape: key, declared params, its own site, {page} only for paging", () => {
    expect(recipeProblems("dev.bg/search", recipe())).toEqual([]);
    expect(recipeProblems("dev.bg/search", recipe({ key: "link" }))).toEqual(['key "link" is not one of the fields']);
    expect(recipeProblems("dev.bg/search", recipe({ params: {} }))).toEqual([
      "{category} in https://dev.bg/company/jobs/{category}/ is not in params",
      "{category} in https://dev.bg/company/jobs/{category}/?_paged={page} is not in params",
    ]);
    expect(recipeProblems("dev.bg/search", recipe({ url: "https://{category}.evil.net/" }))).toContain("https://{category}.evil.net/ is not on dev.bg");
    expect(recipeProblems("dev.bg/search", recipe({ next: { kind: "page", url: "https://dev.bg/jobs/{category}/" } }))).toEqual([
      "next.url has no {page}",
    ]);
  });

  it("reads at a person's pace and a bounded number of pages", () => {
    expect(recipe()).toMatchObject({ key: "url", maxPages: 5, delayMs: 1500 });
    expect(RecipeSchema.safeParse({ ...recipe(), delayMs: 100 }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...recipe(), maxPages: 50 }).success).toBe(false);
  });
});
