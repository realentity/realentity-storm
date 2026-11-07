import { isMap, isScalar, isSeq, type Document, type Node, type YAMLMap } from "yaml";
import { editAppSource, keepComment } from "./app-source";

/**
 * M37-T1: an App's pages as the Pages tab changes them. Every type has a list and a view page, written or by default
 * from its fields; the first change to a default one writes it, after its type's other pages (else at the end). A
 * property set to undefined is removed, and the page's default takes its place.
 */

export type PageKind = "list" | "view" | "form";

/** What I'd write first on each kind of page, in this order. */
const ORDER: Record<PageKind, string[]> = {
  list: ["list", "menu", "columns", "filters", "search", "sort", "group", "removed", "actions", "moves", "chart"],
  view: ["view", "fields", "sections", "history", "actions"],
  form: ["form", "fields"],
};

/** A property of a page: lists on one line, a section a line each, as the templates are written. */
export function setPageProperty(source: string, kind: PageKind, type: string, property: string, value: unknown): string {
  if (!ORDER[kind].includes(property) || property === kind) throw new Error(`A ${kind} page has no ${property}`);
  return editAppSource(source, (document) => {
    if (value === undefined && !pageOf(document, kind, type)) return;
    const page = pageOf(document, kind, type) ?? addPageNode(document, kind, type);
    if (value === undefined) {
      page.delete(property);
      return;
    }
    // A view has its fields or its sections, not both.
    if (kind === "view" && (property === "fields" || property === "sections")) page.delete(property === "fields" ? "sections" : "fields");
    const node = document.createNode(value) as Node;
    flowStyle(node, property === "sections");
    if (page.has(property)) {
      keepComment(page.get(property, true), node);
      page.set(property, node);
      return;
    }
    const before = new Set(ORDER[kind].slice(0, ORDER[kind].indexOf(property)));
    const at = page.items.reduce((index, pair, i) => (isScalar(pair.key) && before.has(pair.key.value as string) ? i + 1 : index), 0);
    page.items.splice(at, 0, document.createPair(property, node));
  });
}

/** A page written out, as its default is: `- list: Bill`, to be changed. */
export function addPage(source: string, kind: PageKind, type: string): string {
  return editAppSource(source, (document) => {
    if (pageOf(document, kind, type)) throw new Error(`${type} already has a ${kind} page`);
    addPageNode(document, kind, type);
  });
}

/** The written page; its default (from the type's fields) is shown in its place. */
export function removePage(source: string, kind: PageKind, type: string): string {
  return editAppSource(source, (document) => {
    const pages = document.get("pages", true);
    if (!isSeq(pages)) return;
    pages.items = pages.items.filter((page) => !(isMap(page) && page.get(kind) === type));
    if (pages.items.length === 0) document.delete("pages");
  });
}

/** A list page one place up (-1) or down in the menu: past the next list page, the pages between it kept as they are. */
export function moveListPage(source: string, type: string, delta: -1 | 1): string {
  return editAppSource(source, (document) => {
    const pages = document.get("pages", true);
    if (!isSeq(pages)) return;
    const lists = pages.items.flatMap((page, index) => (isMap(page) && page.has("list") ? [index] : []));
    const at = lists.findIndex((index) => (pages.items[index] as YAMLMap).get("list") === type);
    const other = lists[at + delta];
    if (at < 0 || other === undefined) return;
    const index = lists[at];
    [pages.items[index], pages.items[other]] = [pages.items[other], pages.items[index]];
  });
}

function pageOf(document: Document, kind: PageKind, type: string): YAMLMap | undefined {
  const pages = document.get("pages", true);
  if (!isSeq(pages)) return undefined;
  return pages.items.find((page): page is YAMLMap => isMap(page) && page.get(kind) === type);
}

function addPageNode(document: Document, kind: PageKind, type: string): YAMLMap {
  if (!document.hasIn(["types", type])) throw new Error(`There is no type ${type}`);
  if (!isSeq(document.get("pages", true))) document.set("pages", document.createNode([]));
  const pages = document.get("pages", true);
  if (!isSeq(pages)) throw new Error("pages is not a list");
  const node = document.createNode({ [kind]: type }) as YAMLMap;
  // After its type's pages before it (a list, then its view, then its form), else before the ones after it, else last.
  const rank = (page: unknown) => (isMap(page) ? (["list", "view", "form"] as const).findIndex((k) => page.get(k) === type) : -1);
  const mine = (["list", "view", "form"] as const).indexOf(kind);
  let before = -1;
  pages.items.forEach((page, index) => {
    if (rank(page) >= 0 && rank(page) < mine) before = index;
  });
  const after = pages.items.findIndex((page) => rank(page) > mine);
  let at = pages.items.length;
  if (before >= 0) at = before + 1;
  else if (after >= 0) at = after;
  pages.items.splice(at, 0, node);
  return node;
}

/** Lists and maps on one line (what is in them with them); sections (`block`) a line each. */
function flowStyle(node: Node, block: boolean): void {
  if (block && isSeq(node)) {
    for (const item of node.items) if (isSeq(item) || isMap(item)) item.flow = true;
  } else if (isSeq(node) || isMap(node)) node.flow = true;
}
