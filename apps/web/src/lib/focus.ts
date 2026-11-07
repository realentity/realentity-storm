/**
 * M38-T5: what I am on, from the control that has the focus: its step and input on the cards, its type and field in
 * the designer, else what the control is called.
 */
export function focusOf(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const step = target.closest("[data-step]")?.getAttribute("data-step");
  const input = target.closest("[data-input]")?.getAttribute("data-input");
  if (step) return input ? `step ${step}, input ${input}` : `step ${step}`;
  const type = target.closest("[data-type-name]")?.getAttribute("data-type-name");
  const field = target.closest("[data-field-name]")?.getAttribute("data-field-name");
  if (type) return field ? `field ${type}.${field}` : `type ${type}`;
  return target.getAttribute("aria-label") ?? undefined;
}
