import { type PipelineDetailView, type RunDetailView } from "@realentity/storm-shared";
import { expect, type Page } from "@playwright/test";

/** A name no other test (or earlier run against a reused database) has. */
export const unique = (prefix: string): string => `${prefix} ${Date.now().toString(36)}`;

/** Two recruiters from test.search; replying to each is a side effect, so the compiler puts a gate before it. */
export const REPLIES = (name: string, trigger = "manual") => `name: ${name}
trigger: ${trigger}
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: reply
    type: test.send
    forEach: "{{search.items}}"
    with: { to: "{{item.recruiter}}", body: "Thanks for {{item.title}}" }
`;

/** Through the web app's /api proxy, with the browser's session cookie. */
export async function createPipeline(page: Page, source: string): Promise<PipelineDetailView> {
  const response = await page.request.post("/api/pipelines", { data: { source } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as PipelineDetailView;
}

export async function startRun(page: Page, pipelineId: string): Promise<RunDetailView> {
  const response = await page.request.post(`/api/pipelines/${pipelineId}/runs`, { data: {} });
  expect(response.status(), await response.text()).toBe(202);
  return (await response.json()) as RunDetailView;
}

/** Opens the inbox entry of one item's proposal (it appears once the worker reaches the gate). */
export async function openProposal(page: Page, pipelineName: string, stepKey: string, item: number): Promise<void> {
  await page.goto("/inbox");
  await page.getByRole("link", { name: new RegExp(`${escape(pipelineName)} · ${stepKey} #${item}\\b`) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`${stepKey}\\s*#${item}`) })).toBeVisible();
}

/** The timeline row of one forEach item of a step. */
export function stepRow(page: Page, type: string, item: number) {
  return page
    .getByTestId("timeline")
    .locator("tr", { hasText: type })
    .filter({ hasText: `item #${item}` });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
