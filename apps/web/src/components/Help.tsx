import { IconInfoCircle } from "@tabler/icons-react";

/** M38-T3: an info icon beside a heading or a label: what it is for, on hover or focus. */
export function Help({ text }: Readonly<{ text: string }>) {
  return (
    <span
      className="text-secondary d-inline-flex align-middle"
      title={text}
      aria-label={text}
      role="img"
      tabIndex={0}
      data-testid="help"
      style={{ cursor: "help" }}
    >
      <IconInfoCircle size={14} />
    </span>
  );
}
