
import { asFileRef, fieldOf, safeLink, type ViewColumn, type ViewRow } from "@realentity/storm-shared";
import { IconPaperclip } from "@tabler/icons-react";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { asText, toNumber } from "../lib/view";

const DATE = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
const NUMBER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** One value as its format says. Always text (React escapes it); a link only when it is http(s). */
export function ViewValue({
  row,
  column,
  full,
  inLink,
}: {
  row: ViewRow;
  /** M65: `control: chips` draws a list's (an enum's) values as chips. */
  column: ViewColumn & { control?: "chips" };
  full?: boolean;
  /** Inside a link already (a row's title): no link of its own. */ inLink?: boolean;
}) {
  const value = fieldOf(row, column.field);
  if (value === undefined || value === null || value === "") return <span className="text-secondary">—</span>;
  // M56: a ref as what it points at is named.
  const title = row.titles?.[column.field];
  if (title !== undefined) return <>{title}</>;
  if (column.control === "chips") {
    const values = (Array.isArray(value) ? value : [value]).map(asText).filter((v) => v !== "");
    return (
      <span className="d-inline-flex flex-wrap gap-1" data-testid="value-chips">
        {values.map((v, i) => (
          <span key={`${i}:${v}`} className="badge bg-azure-lt">
            {v}
          </span>
        ))}
      </span>
    );
  }
  switch (column.as) {
    case "number": {
      const n = toNumber(value);
      return <>{n === null ? asText(value) : NUMBER.format(n)}</>;
    }
    case "money": {
      const n = toNumber(value);
      const currency = "currency" in column && column.currency ? fieldOf(row, column.currency) : undefined;
      return <span className="text-nowrap">{n === null ? asText(value) : `${n.toFixed(2)}${currency ? ` ${asText(currency)}` : ""}`}</span>;
    }
    case "date":
    case "datetime": {
      const date = new Date(asText(value));
      if (Number.isNaN(date.getTime())) return <>{asText(value)}</>;
      return <span className="text-nowrap">{column.as === "date" ? DATE.format(date) : formatDateTime(date.toISOString())}</span>;
    }
    case "badge":
      return <span className="badge bg-secondary-lt">{asText(value)}</span>;
    case "yesno":
      return <>{value === true || value === "true" || value === 1 ? "yes" : "no"}</>;
    case "link": {
      const href = safeLink(value);
      return href ? <ShortLink href={href} /> : <>{asText(value)}</>;
    }
    case "file":
    case "image": {
      // M46: a stored file's reference only; anything else as text.
      const file = asFileRef(value);
      if (!file) return <>{asText(value)}</>;
      const href = api.apps.fileUrl(file.id);
      // An image shows its thumbnail, in a file field too (a paper's photo).
      if (file.mime.startsWith("image/")) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" title={file.name} data-testid="entity-image">
            <img src={api.apps.thumbUrl(file.id)} alt={file.name} className="rounded border" style={{ maxHeight: full ? "16rem" : "2.5rem", maxWidth: "100%" }} loading="lazy" />
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-truncate d-inline-block align-bottom" style={{ maxWidth: "18rem" }} data-testid="entity-file">
          <IconPaperclip size={16} className="me-1" />
          {file.name}
        </a>
      );
    }
    default: {
      if (full) return <span style={{ whiteSpace: "pre-wrap" }}>{asText(value)}</span>;
      // A text that is a web address (a feed's url kept as text) reads as one: short, not a wide column.
      const href = !inLink && typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim()) ? safeLink(value.trim()) : null;
      if (href) return <ShortLink href={href} />;
      return (
        <span className="text-truncate d-inline-block align-bottom" style={{ maxWidth: "24rem" }} title={asText(value)}>
          {asText(value)}
        </span>
      );
    }
  }
}

/** A link as its host and path, cut at the end to fit a column; the whole address on hover. */
function ShortLink({ href }: Readonly<{ href: string }>) {
  const url = new URL(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-truncate d-inline-block align-bottom"
      style={{ maxWidth: "18rem" }}
      title={href}
    >
      {url.hostname}
      {url.pathname === "/" ? "" : url.pathname}
    </a>
  );
}
