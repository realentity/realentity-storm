/** A passage's text at most (M43-T3): about a screen, so a draft can quote what it needs and stay within its budget. */
export const PASSAGE_TEXT = 1_500;

export interface Passage {
  /** The headings it is under: "Decision > Database". */
  heading: string;
  text: string;
}

/**
 * A file's passages (M43-T3): Markdown and the like split at their headings, each section into paragraphs of at most
 * PASSAGE_TEXT. The same text always gives the same passages, so an index rebuilt equals the one deleted.
 */
export function passagesOf(text: string): Passage[] {
  const passages: Passage[] = [];
  const headings: string[] = [];
  let body: string[] = [];
  const flush = () => {
    const heading = headings.filter(Boolean).join(" > ");
    for (const piece of pieces(body.join("\n"))) passages.push({ heading, text: piece });
    body = [];
  };
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : headingOf(line);
    if (heading) {
      flush();
      headings.length = heading.level - 1;
      headings[heading.level - 1] = heading.title;
    } else body.push(line);
  }
  flush();
  return passages;
}

/** A Markdown ("## Decision") or AsciiDoc ("== Decision") heading; in linear time, since a file's lines can be long. */
function headingOf(line: string): { level: number; title: string } | null {
  const marker = line.startsWith("#") ? "#" : line.startsWith("=") ? "=" : null;
  if (!marker) return null;
  let level = 0;
  while (line[level] === marker) level++;
  if ((marker === "#" && level > 6) || !/\s/.test(line[level] ?? "")) return null;
  let title = line.slice(level).trim();
  if (marker === "#") {
    // "## Decision ##": closing marks aren't the title.
    let end = title.length;
    while (end > 0 && title[end - 1] === "#") end--;
    title = title.slice(0, end).trim();
  }
  return title ? { level, title } : null;
}

/** A section's text in paragraphs, joined up to PASSAGE_TEXT; a longer paragraph cut at sentence ends. */
function pieces(section: string): string[] {
  const paragraphs = section
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= PASSAGE_TEXT ? [p] : cut(p)));
  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + 2 + paragraph.length > PASSAGE_TEXT) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) out.push(current);
  return out;
}

function cut(paragraph: string): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > PASSAGE_TEXT) {
    const window = rest.slice(0, PASSAGE_TEXT);
    const end = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const at = end > PASSAGE_TEXT / 2 ? end + 1 : PASSAGE_TEXT;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}
