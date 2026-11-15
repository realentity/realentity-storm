import { type PipelineSummaryView } from "@realentity/storm-shared";
import { describe, expect, it } from "vitest";
import { groupByApp } from "./pipeline-groups";

const pipeline = (name: string, app: string | null): PipelineSummaryView => ({
  pipelineId: `${name}-id`,
  name,
  enabled: false,
  essential: false,
  currentVersion: 1,
  hasDraft: false,
  app: app ? { appId: `${app}-id`, name: app } : null,
  dateCreated: "2026-11-15T08:00:00.000Z",
  dateUpdated: "2026-11-15T08:00:00.000Z",
});

const ALL = [
  pipeline("Weekly digest", null),
  pipeline("Read paper", "Papers"),
  pipeline("Paper from Telegram", "Papers"),
  pipeline("Bills due", "bills"),
  pipeline("Check monitors", null),
];

const shape = (query?: string) => groupByApp(ALL, query).map((g) => [g.app?.name ?? null, g.pipelines.map((p) => p.name)]);

describe("the pipelines list by App", () => {
  it("Apps by name (any case), the pipelines in none last; each by name", () => {
    expect(shape()).toEqual([
      ["bills", ["Bills due"]],
      ["Papers", ["Paper from Telegram", "Read paper"]],
      [null, ["Check monitors", "Weekly digest"]],
    ]);
  });

  it("finds by a pipeline's name or its App's; an App left without any is gone", () => {
    expect(shape("telegram")).toEqual([["Papers", ["Paper from Telegram"]]]);
    expect(shape("  PAPERS ")).toEqual([["Papers", ["Paper from Telegram", "Read paper"]]]);
    expect(shape("digest")).toEqual([[null, ["Weekly digest"]]]);
    expect(shape("nothing like it")).toEqual([]);
  });
});
