import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { AppDefinitionSchema, type AppDefinition, type AppIssue } from "./app";

/**
 * M35: an App's YAML as the designer sees it. The designer changes the document, never a copy of its data, so my
 * comments and the order I wrote things in stay; a problem carries its line, to show it on the YAML tab too.
 */

/** The App read from its YAML, or every problem with it: YAML errors, then the definition's, each with its line. */
export function checkAppSource(source: string): { definition: AppDefinition | null; errors: AppIssue[] } {
  const lines = new LineCounter();
  const document = parseDocument(source, { lineCounter: lines, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      definition: null,
      errors: document.errors.map((error) => ({ path: "", message: error.message.split("\n")[0], line: lines.linePos(error.pos[0]).line })),
    };
  }
  const result = AppDefinitionSchema.safeParse(document.toJS());
  if (result.success) return { definition: result.data, errors: [] };
  return {
    definition: null,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.map((p) => (typeof p === "symbol" ? String(p) : p));
      return { path: path.map(String).join("."), message: issue.message, line: lineAt(document, lines, path) };
    }),
  };
}

/**
 * The line of a path in the document: of its node, or of the nearest one above it that is there (a missing field's
 * type, a missing key's map). Undefined for an empty document.
 */
export function lineAt(document: Document, lines: LineCounter, path: (string | number)[]): number | undefined {
  for (let depth = path.length; depth >= 0; depth--) {
    const node = nodeAt(document, path.slice(0, depth));
    if (node) return lines.linePos(node).line;
  }
  return undefined;
}

/** Where a path's node starts: its key's position in a map (the line I'd look at), else the node's own. */
function nodeAt(document: Document, path: (string | number)[]): number | undefined {
  if (path.length === 0) return document.contents?.range?.[0];
  const parent = path.length === 1 ? document.contents : document.getIn(path.slice(0, -1), true);
  const last = path.at(-1);
  if (isMap(parent)) {
    const pair = parent.items.find((item) => isScalar(item.key) && String(item.key.value) === String(last));
    const key = pair?.key as { range?: [number, number, number] } | undefined;
    return key?.range?.[0];
  }
  if (isSeq(parent) && typeof last === "number") {
    const item = parent.items[last] as { range?: [number, number, number] } | undefined;
    return item?.range?.[0];
  }
  return undefined;
}

/**
 * A change to an App's YAML as the designer makes it: on the document, with my comments and order. The YAML library
 * writes the whole document its own way (spacing in lists, where comments sit), so only the lines the change touches
 * are taken from it: the document is written before and after the change, and every line the two share is my own
 * line, as I wrote it.
 */
export function editAppSource(source: string, edit: (document: Document) => void): string {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error("The YAML has errors: fix them on the YAML tab first");
  const before = render(document);
  edit(document);
  const after = render(document);
  const mine = source.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
  const theirs = before.replace(/\n$/, "").split("\n");
  // Their lines are mine one for one when the library didn't join or split any: else all of it is theirs.
  if (mine.length !== theirs.length) return after;
  const changed = after.replace(/\n$/, "").split("\n");
  // The same, the library's way of padding flow collections: a new line is taken from it with its maps padded as the
  // templates have them ({ type: text }) and its lists not ([due, paid]). A line the two write the same has no flow
  // collection in it (a block of text among them), so it is taken as it is.
  const padded = document.toString({ lineWidth: 0, flowCollectionPadding: true }).replace(/\n$/, "").split("\n");
  const fresh = (j: number) => (padded.length === changed.length && padded[j] !== changed[j] ? unpadLists(padded[j]) : changed[j]);
  return `${sameLines(theirs, changed)
    .map((line) => (line.from === "before" ? mine[line.index] : alignComment(fresh(line.index), mine)))
    .join("\n")}\n`;
}

/** A changed line's comment where I had it: at the column of the same comment on one of my lines. */
function alignComment(line: string, mine: string[]): string {
  const match = / # (.*)$/.exec(line);
  if (!match || /["']/.test(line)) return line;
  const content = line.slice(0, match.index);
  const comment = `# ${match[1]}`;
  const original = mine.find((l) => l.endsWith(comment) && /\s/.test(l.charAt(l.length - comment.length - 1)));
  if (!original) return line;
  const column = original.length - comment.length;
  return content.length < column ? `${content.padEnd(column)}${comment}` : line;
}

/** A line's flow lists without the library's padding ([ due, paid ] to [due, paid]), outside quotes and comments. */
function unpadLists(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === "\\" && quote === '"') out += line[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || line[i - 1] === " ")) return out + line.slice(i);
    else if (c === "[" && line[i + 1] === " ") {
      out += "[";
      i++;
      continue;
    } else if (c === " " && line[i + 1] === "]") continue;
    out += c;
  }
  return out;
}

function render(document: Document): string {
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/**
 * The edited document's lines in order: each one the original had (its index there) or a new one (its index in the
 * edited). A longest common subsequence: Apps are hundreds of lines.
 */
function sameLines(before: string[], after: string[]): { from: "before" | "after"; index: number }[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: { from: "before" | "after"; index: number }[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && before[i] === after[j]) {
      lines.push({ from: "before", index: i });
      i++;
      j++;
    } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++; // a line the edit removed
    } else {
      lines.push({ from: "after", index: j });
      j++;
    }
  }
  return lines;
}

/** Which of the designer's tabs a problem belongs to, by its path. */
export type AppDesignerTab = "app" | "types" | "stages" | "pages";

export function tabOf(path: string): AppDesignerTab {
  const [first, , third] = path.split(".");
  if (first === "pages") return "pages";
  if (first === "types") return third === "stages" ? "stages" : "types";
  return "app";
}

export const AppCheckRequestSchema = z
  .object({
    source: z.string().max(200_000),
    /** The App it is a draft of: its pipelines are compiled against the draft, and what changes is listed. */
    appId: z.uuid().optional(),
  })
  .strict();
export type AppCheckRequest = z.infer<typeof AppCheckRequestSchema>;

/** M35-T1: a draft App checked as I edit it: its problems, those of its pipelines against it, and what it changes. */
export interface AppCheckView {
  ok: boolean;
  errors: AppIssue[];
  pipelines: { pipelineId: string; name: string; errors: AppIssue[] }[];
  /** What the draft changes against the current version; empty for a new App. */
  changes: string[];
}
