export { definitionToSource } from "@ai-me/shared";

/** A new pipeline: no description (its box says what goes there). */
export const NEW_PIPELINE_TEMPLATE = `name: My pipeline
trigger: manual            # or { schedule: "0 8 * * 1-5", tz: Europe/Sofia }, { on: run.finished, pipeline: Jobs }, { webhook: hmac-sha256 }
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
