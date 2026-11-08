import { fieldOf, safeLink, type ViewRow } from "@realentity/storm-shared";
import { IconExternalLink } from "@tabler/icons-react";

/** An entity's address (its type's first url field, M31), as an icon that opens it: http(s) only. */
export function EntityLink({ row, field }: { row: ViewRow; field: string | null }) {
  const href = field ? safeLink(fieldOf(row, field)) : null;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="btn btn-ghost-secondary btn-icon btn-sm"
      title={href}
      data-testid="entity-link"
    >
      <IconExternalLink size={16} />
    </a>
  );
}
