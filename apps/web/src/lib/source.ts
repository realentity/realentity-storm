export { definitionToSource } from "@ai-me/shared";

export const NEW_PIPELINE_TEMPLATE = `name: My pipeline
description: What it does, in a sentence
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
