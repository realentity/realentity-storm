# Recipes: reading a site's list

A **recipe** tells Storm how to read a list on a website (job ads, products, apartments) without an LLM: where the
list is, which element is one item, and where each field is inside it. Pipelines read lists with
[`browser.extract`](capabilities.md#browserextract-%EF%B8%8F), which follows a recipe page by page. Teaching costs a
few cents once; reading with a recipe costs nothing.

This guide covers when to use a recipe, how to make one, how a pipeline uses it, every part of the format, and what to
do when a recipe stops matching. How it works inside: [design.md §2.4](design.md#24-browser-steps-recipes-vs-agent).

## When to use one

Use a recipe for a list you read again and again, the same way: a job board's categories every morning, a shop's
search, a listing site's districts. The site needs no sign-in, and the list is in the page: links, cards, rows.

Use something else when:

| The site | Instead |
| --- | --- |
| has an API or a feed (JSON, RSS) | [`http.fetch`](capabilities.md#httpfetch): faster, no browser |
| is one product page you watch | [`shop.product`](capabilities.md#shopproduct-) or [`price.watch`](capabilities.md#pricewatch-) |
| needs a sign-in to see the list | not yet: recipes don't sign in. [`browser.open`](capabilities.md#browseropen-%EF%B8%8F) can sign in and read one page's text |
| changes every visit, or is a one-off task | [`browser.agent`](capabilities.md#browseragent-%EF%B8%8F-) (an LLM in the browser, each run) |

Check the site's terms and `robots.txt` first. A recipe reads at a person's pace (1.5 s between pages by default) and
never leaves its own site.

## How a recipe and a pipeline fit together

```text
the Recipes page                   a pipeline
┌──────────────────────────┐       ┌───────────────────────────────────────────────┐
│ jobs.example.com/search  │       │ search: browser.extract                       │
│   url: …/jobs/{category}/│◀──────│   recipes: [jobs.example.com/search]          │
│   params: category       │       │   params: { category: [net, java] }           │
│   fields: url, title, …  │──────▶│   → items: [{ url, title, …, source }]        │
└──────────────────────────┘       │ fresh: data.dedupe, key: url                  │
                                   │ score: llm.score …                            │
                                   └───────────────────────────────────────────────┘
```

- The recipe has a **name**, `<site>/<what>`, e.g. `jobs.example.com/search`. The site part is the only host it may
  open (with or without `www.`).
- The pipeline names the recipe and gives the **params**: the values that change between searches. A list of values
  runs one search per value.
- Every item comes back with the recipe's **fields** plus `source` (the recipe's name). The pipeline's next steps read
  those names: `data.dedupe` with `key: url`, an App type whose fields are `title`, `company`… **Name the fields the way
  the pipeline reads them.** The examples ([job-board.yaml](../examples/apps/job-search.yaml),
  [listings.yaml](../examples/apps/apartments.yaml)) read `url`, `title`, `company`, `location`, `posted` for jobs and `url`,
  `title`, `price`, `rooms`, `size` for listings.
- Runs always use the recipe's **latest version**. Editing a recipe changes what every pipeline using it reads, from
  the next run.

## Making a recipe

### Teach it (the live browser)

On the **Recipes** page, press **Teach**:

1. Choose what the list holds: **Job ads** (url, title, company, location, posted), **Products** (url, title, price),
   or **Something else** (your own field names, comma-separated; include `url`).
2. Give the recipe's name, the **Search results page** (the address of one search's results, copied from your browser),
   and the **params**: the parts of that address that change from one search to the next, as `name=value`. The form
   shows the address the recipe keeps as you type:

   ```text
   https://www.bergfreunde.eu/s/fjallraven-jacket
     is https://www.bergfreunde.eu/s/<query>
     where <query>=fjallraven-jacket   → query=fjallraven-jacket

   https://jobs.example.com/jobs/net/?seniority=senior
     is https://jobs.example.com/jobs/<category>/?seniority=<seniority>
     where <category>=net, <seniority>=senior   → category=net, seniority=senior
   ```

   A pipeline then gives its own values (`query: tent`), so one recipe serves many searches. Teach on a search with
   several results; a broad one is best.
3. Optionally say what to leave out ("the promoted ads at the top") or which of two prices is right.
4. The run page opens with the live browser. Bring it to the list (accept the cookie banner, search, set filters) and
   press **Continue**.
5. The LLM writes a recipe, and it's checked on the page: the address rebuilt from the params must be this page's, the
   items must have the fields, the next page must show other items. What it reads is outlined on the page. Right:
   **Continue** saves it. Wrong: **Abort**.

Teach mode writes paging by a next link or by a page number in the address. "Load more" buttons, scrolling and detail
pages are added by editing the recipe afterwards.

### Write or import it (YAML)

Press **Import**, give the name and paste the YAML. It's checked before it's saved; the errors say what to fix.
Starting points: [example-jobs.yaml](../recipes/example-jobs.yaml), [example-listings.yaml](../recipes/example-listings.yaml).

To find selectors, open the list in your browser, right-click an item → **Inspect**, and look for a class that every
item has and nothing else has (`.job-card`, `article.listing`). Fields are looked for inside the item. Prefer stable
names (`.job-title`, `[data-testid=price]`) to generated ones (`.css-1x2y3z`), which change with each deploy of the site.

### Try it

On a recipe's page, **Try** reads the list with the latest version and the params you give, and shows the items as a
table (at most the number you set), with how many pages it read. When it doesn't match, it shows what didn't and a
screenshot of the page as the recipe saw it. Try changes nothing: the recipe isn't marked working or broken, nobody is
told. Save an edit first, then try it.

### Edit it

On a recipe's page each version shows as YAML. **Edit** (or **Edit from here** on an older version) saves your change
as the next version, checked like an import. **Download** saves a version as a file to import elsewhere.

## A walkthrough

A made-up board, `jobs.example.com`, lists jobs per category at `https://jobs.example.com/jobs/net/`:

```html
<article class="job">
  <a class="job-link" href="/jobs/1234">Senior .NET developer</a>
  <span class="company">Acme</span> <span class="location">Sofia</span> <time>2 days ago</time>
</article>
<!-- … 20 per page … -->
<a class="next" href="/jobs/net/?page=2">Next</a>
```

The recipe:

```yaml
url: https://jobs.example.com/jobs/{category}/
params:
  category: { description: "the board's category, e.g. net, java" }
item: article.job
fields:
  url: { selector: a.job-link, attr: href, required: true }
  title: { selector: a.job-link, required: true }
  company: { selector: .company }
  location: { selector: .location }
  posted: { selector: time }
key: url
next: { kind: link, selector: a.next }
maxPages: 5
```

Import it as `jobs.example.com/search` and **Try** it with `category` = `net`: the table shows the jobs, with full
addresses in `url` (an `href` is made absolute). Then a pipeline:

```yaml
name: .NET and Java jobs
trigger: { schedule: "0 8 * * 1-5" }
policy:
  allowedDomains: [jobs.example.com]
steps:
  - id: search
    type: browser.extract
    with:
      recipes: [jobs.example.com/search]
      params: { category: [net, java] }   # one search per category
      maxItems: 200
  - id: fresh
    type: data.dedupe
    with: { from: "{{search.items}}", key: url, against: JobPosting }
  - id: tell
    type: llm.summarize
    when: "{{fresh.items}}"
    with: { content: "{{fresh.items}}", instruction: "The new jobs, one line each." }
```

Each morning it reads up to 5 pages per category and continues with the jobs it hasn't seen before.

## The format

| Key | Required | What it is |
| --- | --- | --- |
| `url` | yes | The list's first page, with `{param}` placeholders, filled URL-encoded. On the recipe's site. |
| `params` | no | One entry per placeholder: `{ description, default }`. A param with a `default` may be left out by the pipeline. |
| `item` | yes | A CSS selector matching each item of the list (at most 500 a page). |
| `fields` | yes | Name → how to read it inside the item (below). Names are camelCase. |
| `key` | no | The field that identifies an item; `url` if left out. Must be one of the fields. |
| `empty` | no | A selector shown when the search has no results: an empty list, not a broken recipe. |
| `next` | no | How to reach more items (below). Left out: the first page only. |
| `detail` | no | Fields read on each item's own page by `browser.details` (below). |
| `maxPages` | no | At most this many pages (or presses, or scrolls): 5 by default, 20 at most. |
| `delayMs` | no | The wait between pages: 1500 by default, 500 to 10000. |

**Params.** In the YAML a param is written `{query}` (the pages show it as `<query>`). A placeholder can be anywhere in
the address: `https://shop.example/s/{query}` or
`https://jobs.example.com/jobs?category={category}&seniority={seniority}`. Every placeholder must be in `params`;
`{page}` belongs only in `next.url`. In the pipeline, `params: { category: net }` runs one search; `params:
{ category: [net, java] }` runs one per value.

**Fields.**

```yaml
fields:
  url: { selector: a.title, attr: href, required: true }   # an attribute; href and src become absolute addresses
  title: { selector: a.title, required: true }             # the visible text, spaces tidied
  price: { selector: .price }                              # text as shown: "€ 129,95"; turn it into a number in the pipeline (data.map)
  badge: { selector: .badge, attr: data-kind }             # any attribute
  label: {}                                                # no selector: the item's own text
```

`required: true` means an item without it is not a real item: it's left out (so is an item without its `key`). When no
item on the page has the key and every required field, the recipe no longer matches. Mark the fields that every item has (its link, its title) and leave the rest optional.

**Next.** Four kinds:

```yaml
next: { kind: link, selector: a.next }                                         # a "Next" link to follow
next: { kind: page, url: "https://jobs.example.com/jobs/{category}/?page={page}", start: 2 }   # page numbers in the address
next: { kind: more, selector: button.load-more }                               # a "Load more" button, pressed
next: { kind: scroll }                                                         # more items when scrolled to the bottom
```

The list ends at `maxPages`, when there is no next link, when a numbered page shows no new items, or when the button
is gone or nothing new comes within 10 seconds. A press that takes the browser to another site fails the read.

**Detail.** A list often shows a title and a link but not the description or the salary. `detail` reads more on each
item's own page:

```yaml
detail:
  link: url                                                  # the field with the page's address; url if left out
  fields:
    description: { selector: .job-description, required: true }
    salary: { selector: .salary }
```

Detail fields need new names (not a list field, not `source`). `browser.extract` doesn't open these pages;
[`browser.details`](capabilities.md#browserdetails-%EF%B8%8F) does, placed after `data.dedupe` so only new items are
opened:

```yaml
  - id: more
    type: browser.details
    with: { recipe: jobs.example.com/search, items: "{{fresh.items}}", maxItems: 30 }
```

It opens at most `maxItems` pages (20 by default, 100 at most), at the recipe's pace, only on its site. An item whose
page fails or lacks the fields comes back as it was. **Try** on a recipe with `detail` also opens the first 5 items'
pages.

## When a site changes

Each run's result shows on the Recipes page, in the **Health** column:

- **Worked** (a date): the last run read items, or the site's "no results" page.
- **Broken since** (a date, and what didn't match): nothing matched `item`, or no item had the key and the required
  fields. The step fails saying so, you get one Telegram message, the digest lists it, and the `recipe.broken` event
  fires.
- **Nothing found since** (a date): only the "no results" page for 7 days. The site may have changed so that the list
  looks empty; you're told once, until it finds items again.
- **A fix is proposed: check it**: with `fallback: true` on `browser.extract`, a broken recipe doesn't stop the run. A
  browser agent finds the list on the new page, teach mode's writer proposes a recipe, and the run continues with it.
  The fix waits on the recipe's page: save it as the next version, or discard it.

Without the fallback: **Teach again** from the recipe's page, or edit the selectors yourself, then **Try**.

`browser.details` failing (none of the pages opened has the detail fields) doesn't mark the recipe broken, since the
list still reads: edit its `detail` section.

## Limits

- **No sign-in.** Recipes read public lists only.
- **Its own site only**: the host in the name, with or without `www.`. Links to other sites are not followed;
  `browser.details` skips items whose link is elsewhere.
- At most 20 pages a read, 500 items a page, 0.5 s between pages at the least.
- Lists only: a recipe doesn't click into filters, fill forms or press anything but a "Load more" button.
- Runs headless. A site that shows a CAPTCHA to a headless browser can't be read with a recipe.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `key "link" is not one of the fields` (on save) | `key` and `detail.link` must name one of `fields`. |
| `{x} in … is not in params` | Add `x` to `params`, or remove the placeholder. |
| `… is not on jobs.example.com` | Every address must be on the site in the recipe's name. Rename the recipe or fix the address. |
| `The recipe needs "category"` (in a run) | The pipeline didn't give that param. Add it to `params`, or give the param a `default`. |
| `"article.job" matched nothing` | The item selector is wrong, or the page is different for a browser without your cookies (a consent page, another language). **Try** shows the page the recipe saw. |
| Items without the required fields | A field's selector is wrong for some items (e.g. promoted ads). Make it optional, or narrow `item` (`article.job:not(.promoted)`). |
| Try shows one page only | No `next`, or its selector doesn't match. For "Load more" or endless lists use `more` or `scroll`. |
| Prices or numbers as text | Recipes read text as shown. Convert in the pipeline with `data.map` (see [listings.yaml](../examples/apps/apartments.yaml)). |
| `url` is empty | Read the link with `attr: href`; the visible text of a link is its title. |
| `has no detail fields` | `browser.details` needs a `detail` section in the recipe's latest version. |
| `None of the N item pages opened has the detail fields` | The item pages changed (or need a sign-in): fix the `detail` selectors, then **Try**. |
| A broken recipe and the run stops | Add `fallback: true` to `browser.extract` so runs continue with a proposed fix, or teach it again. |
