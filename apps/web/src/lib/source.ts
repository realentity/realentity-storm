import { type CompiledDefinition } from "@ai-me/shared";
import { stringify } from "yaml";

/**
 * A compiled definition back as editable YAML: the steps as authored (gates the compiler inserted are left out,
 * since it inserts them again) and without empty defaults. Versions keep the compiled form only.
 */
export function definitionToSource(definition: CompiledDefinition): string {
  const authored: Record<string, unknown> = { name: definition.name };
  if (definition.description) authored.description = definition.description;
  if (definition.trigger !== "manual") authored.trigger = definition.trigger;
  if (Object.keys(definition.limits).length > 0) authored.limits = definition.limits;
  const { allowedDomains, allowedRecipients } = definition.policy;
  if (allowedDomains.length > 0 || allowedRecipients.length > 0) {
    authored.policy = {
      ...(allowedDomains.length > 0 ? { allowedDomains } : {}),
      ...(allowedRecipients.length > 0 ? { allowedRecipients } : {}),
    };
  }
  authored.steps = definition.steps
    .filter((step) => !step.autoInserted)
    .map(({ autoInserted: _, ...step }) => ({
      id: step.id,
      type: step.type,
      ...(step.forEach ? { forEach: step.forEach } : {}),
      ...(step.retries !== undefined ? { retries: step.retries } : {}),
      with: step.with,
    }));
  return stringify(authored, { lineWidth: 0 });
}

export const NEW_PIPELINE_TEMPLATE = `name: My pipeline
description: What it does, in a sentence
trigger: manual            # or { schedule: "0 8 * * 1-5", tz: Europe/Sofia }
steps:
  - id: summary
    type: llm.generate
    with:
      instruction: Write a two-line good-morning note
  - id: tell
    type: notify.telegram
    with:
      text: "{{summary.text}}"
`;
