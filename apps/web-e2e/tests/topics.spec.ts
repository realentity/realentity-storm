import { createPrismaConnection } from "@realentity/storm-db";
import { expect, test, type Page } from "@playwright/test";
import { unique } from "./support";

// M41-T2
test("a topic made, given directions of each kind, edited and archived", async ({ page }) => {
  const name = unique("Orion");
  await page.goto("/topics");
  await page.getByTestId("topic-add").click();
  const form = page.getByTestId("topic-form");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("What it is").fill("The customer portal rebuild for Client Ltd");
  await form.getByRole("button", { name: "Save" }).click();

  const card = page.getByTestId(`topic-${name}`);
  await expect(card).toContainText("The customer portal rebuild for Client Ltd");
  const directions = card.getByTestId("direction-form");
  await directions.getByLabel("Direction").fill("Orion");
  await directions.getByRole("button", { name: "Add" }).click();
  await directions.getByLabel("Kind").selectOption("DOMAIN");
  await directions.getByLabel("Direction").fill("@Client.Example");
  await directions.getByRole("button", { name: "Add" }).click();
  await directions.getByLabel("Kind").selectOption("PERSON");
  await directions.getByLabel("Direction").fill("ivan@client.example");
  await directions.getByLabel("About").fill("the API");
  await directions.getByRole("button", { name: "Add" }).click();
  await expect(card.getByTestId("directions").locator(".list-group-item")).toHaveText([
    /A word\s*Orion/,
    /A domain\s*client\.example/,
    /A person\s*ivan@client\.example about the API/,
  ]);

  // Not a domain: said, nothing added.
  await directions.getByLabel("Kind").selectOption("DOMAIN");
  await directions.getByLabel("Direction").fill("not a domain");
  await directions.getByRole("button", { name: "Add" }).click();
  await expect(directions).toContainText("Not added");
  await expect(card.getByTestId("directions").locator(".list-group-item")).toHaveCount(3);

  await card.getByRole("button", { name: "Remove direction" }).first().click();
  await expect(card.getByTestId("directions").locator(".list-group-item")).toHaveCount(2);

  await card.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("topic-form").getByLabel("What it is").fill("The portal rebuild, phase 2");
  await page.getByTestId("topic-form").getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("The portal rebuild, phase 2");

  await card.getByRole("button", { name: "Archive" }).click();
  await expect(card).toContainText("archived");
});

async function newTopic(page: Page, name: string): Promise<string> {
  const response = await page.request.post("/api/topics", { data: { name, description: "" } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { topicId: string }).topicId;
}

// M41-E1
test("a suggested link confirmed from the queue, another moved to another topic, one taken out of a topic", async ({ page }) => {
  await page.goto("/topics");
  const orion = unique("Orion");
  const billing = unique("Billing");
  const orionId = await newTopic(page, orion);
  await newTopic(page, billing);
  // What topic.match writes (the browser tests' steps call no LLM).
  const db = createPrismaConnection();
  try {
    const { userId } = await db.client.topic.findUniqueOrThrow({ where: { topicId: orionId } });
    const link = (topicId: string, subject: string, status: "LINKED" | "SUGGESTED") => ({
      userId,
      topicId,
      messageId: `<${unique(subject).replace(/\W+/g, "-")}@client.example>`,
      threadId: "t",
      from: "ivan@client.example",
      subject,
      date: new Date(),
      status,
      via: status === "LINKED" ? ("DIRECTION" as const) : ("LLM" as const),
      evidence: status === "LINKED" ? `the word "${orion}"` : "the invoice for October",
    });
    await db.client.topicLink.createMany({
      data: [
        link(orionId, `Kickoff ${orion}`, "LINKED"),
        link(orionId, `Spec ${orion}`, "SUGGESTED"),
        link(orionId, `Invoice ${orion}`, "SUGGESTED"),
      ],
    });
  } finally {
    await db.close();
  }

  await page.reload();
  const waiting = page.getByTestId("topics-waiting");
  await expect(waiting).toContainText("the invoice for October");
  await waiting.getByTestId(`waiting-Spec ${orion}`).getByRole("button", { name: "Yes" }).click();
  await expect(waiting.getByTestId(`waiting-Spec ${orion}`)).toHaveCount(0);
  await waiting.getByTestId(`waiting-Invoice ${orion}`).getByLabel("Move to").selectOption({ label: billing });
  await expect(page.getByTestId(`waiting-Invoice ${orion}`)).toHaveCount(0);

  const orionEmails = page.getByTestId(`topic-${orion}`).getByTestId("topic-emails");
  await expect(orionEmails).toContainText(`Kickoff ${orion}`);
  await expect(orionEmails).toContainText(`Spec ${orion}`);
  await expect(orionEmails).not.toContainText(`Invoice ${orion}`);
  await expect(page.getByTestId(`topic-${billing}`).getByTestId("topic-emails")).toContainText(`Invoice ${orion}`);
  await expect(page.getByTestId(`topic-${billing}`).getByTestId("topic-emails")).toContainText("moved here from");

  await orionEmails
    .locator(".list-group-item", { hasText: `Kickoff ${orion}` })
    .getByRole("button", { name: "Not this topic" })
    .click();
  await expect(orionEmails).not.toContainText(`Kickoff ${orion}`);
});

// M42-T1
test("a topic's facts: written, no longer true with what is true now, wrong, and a change undone from the history", async ({ page }) => {
  const name = unique("Orion");
  await newTopic(page, name);
  await page.goto("/topics");
  const facts = page.getByTestId(`topic-${name}`).getByTestId("topic-facts");
  const add = async (about: string, statement: string) => {
    await facts.getByTestId("fact-add").click();
    await facts.getByTestId("fact-form").getByLabel("About").fill(about);
    await facts.getByTestId("fact-form").getByLabel("Statement").fill(statement);
    await facts.getByTestId("fact-form").getByRole("button", { name: "Save" }).click();
    await expect(facts.getByTestId("fact-form")).toHaveCount(0);
  };
  await add("Launch date", "February");
  await add("Database", "MySQL");
  await expect(facts.getByTestId("fact-Launch date")).toContainText("written by you");

  // A secret is refused.
  await facts.getByTestId("fact-add").click();
  await facts.getByTestId("fact-form").getByLabel("About").fill("Staging");
  await facts.getByTestId("fact-form").getByLabel("Statement").fill("password: hunter2");
  await facts.getByTestId("fact-form").getByRole("button", { name: "Save" }).click();
  await expect(facts.getByTestId("fact-form")).toContainText("looks like a secret");
  await facts.getByTestId("fact-form").getByRole("button", { name: "Cancel" }).click();

  const launch = facts.getByTestId("fact-Launch date");
  await launch.getByRole("button", { name: "No longer true" }).click();
  await launch.getByLabel("What is true now").fill("March");
  await launch.getByRole("button", { name: "Save" }).click();
  await expect(facts.getByTestId("fact-Launch date")).toContainText("Launch date: March");

  await facts.getByTestId("fact-Database").getByRole("button", { name: "Wrong" }).click();
  await expect(facts.getByTestId("fact-Database")).toHaveCount(0);

  await facts.getByTestId("facts-history").click();
  const history = facts.getByTestId("topic-history");
  await expect(history).toContainText("Launch date: February");
  await expect(history).toContainText("Launch date: February → March");
  await expect(history).toContainText('Wrong: "Database: MySQL"');
  await history.getByRole("button", { name: "Undo" }).first().click();
  await expect(facts.getByTestId("fact-Database")).toContainText("Database: MySQL");
});

// M42: topic upkeep offered on the Topics page, installed off, with what is left; deleted, offered again
test("Keep topics up to date: set up from the Topics page, a checklist until it runs, offered again once deleted", async ({ page }) => {
  await page.goto("/topics");
  const card = page.getByTestId("topic-upkeep");
  await card.getByRole("button", { name: "Set up" }).click();
  await expect(card.getByTestId("topic-upkeep-status")).toContainText("Topic upkeep: off");
  const checklist = card.getByTestId("topic-upkeep-checklist");
  await expect(checklist).toContainText("Try it: a dry run");
  await expect(checklist.getByRole("link", { name: "Switch it on" })).toBeVisible();

  // An ordinary pipeline: opened, and deleted like any other.
  await card.getByRole("link", { name: "Topic upkeep" }).click();
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
  const pipelineId = page.url().split("/").at(-1)!;
  expect((await page.request.delete(`/api/pipelines/${pipelineId}`)).status()).toBe(204);
  await page.goto("/topics");
  await expect(page.getByTestId("topic-upkeep").getByRole("button", { name: "Set up" })).toBeVisible();
});

// M43: a topic's GitHub source, linked and never copied
test("a topic's source: a repository added from its address, shown not read yet, then removed", async ({ page }) => {
  const name = unique("Orion");
  await newTopic(page, name);
  await page.goto("/topics");
  const sources = page.getByTestId(`topic-${name}`).getByTestId("topic-sources");
  await sources.getByTestId("source-add").click();
  const form = sources.getByTestId("source-form");
  await form.getByLabel("GitHub repository").fill("https://github.com/acme/orion");
  await form.getByLabel("Files").fill("docs/adr/**");
  await form.getByRole("button", { name: "Add" }).click();
  const row = sources.getByTestId("source-acme/orion");
  await expect(row).toContainText("docs/adr/**");
  await expect(row).toContainText("not read yet");
  await expect(row.getByRole("link", { name: "acme/orion" })).toHaveAttribute("href", "https://github.com/acme/orion/tree/HEAD/docs/adr");

  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "Remove source" }).click();
  await expect(sources.getByTestId("source-acme/orion")).toHaveCount(0);
});

// M43-T5
test("a topic's history: the estimate shown before anything is read, then its proposals picked and kept", async ({ page }) => {
  const name = unique("Orion");
  const topicId = await newTopic(page, name);
  const db = createPrismaConnection();
  try {
    const { userId } = await db.client.topic.findUniqueOrThrow({ where: { topicId } });
    const backfill = await db.client.topicBackfill.create({
      data: {
        userId,
        topicId,
        months: 6,
        status: "ESTIMATED",
        estimateUsd: 0.12,
        emails: [{ messageId: "<a@x.test>", date: "2026-10-01" }],
      },
    });
    await page.goto("/topics");
    const history = page.getByTestId(`topic-${name}`).getByTestId("topic-history");
    await expect(history.getByTestId("history-estimate")).toContainText("Found 1 email and 0 documents from the last 6 months");
    await expect(history.getByTestId("history-estimate")).toContainText("$0.12");

    const proposal = (about: string, statement: string, date: string) => ({
      title: `${name}: ${about}: ${statement}`,
      quote: statement,
      kind: "new",
      topic: name,
      topicId,
      about,
      statement,
      replaces: null,
      source: { kind: "email", messageId: `<${statement}@client.example>`, from: "maria@client.example", subject: "Plan", date },
    });
    await db.client.topicBackfill.update({
      where: { topicBackfillId: backfill.topicBackfillId },
      data: {
        status: "REVIEW",
        proposals: [
          proposal("Launch date", "March", "2026-10-02T09:00:00.000Z"),
          proposal("Database", "PostgreSQL", "2026-10-04T09:00:00.000Z"),
        ],
      },
    });
    await page.reload();
    const review = history.getByTestId("history-review");
    await review.getByText("Database: PostgreSQL").click();
    await review.getByRole("button", { name: "Keep 1" }).click();
    await expect(page.getByTestId(`topic-${name}`).getByTestId("fact-Launch date")).toContainText("Launch date: March");
    await expect(page.getByTestId(`topic-${name}`).getByTestId("fact-Database")).toHaveCount(0);
    await expect(history).toContainText("1 fact kept");
  } finally {
    await db.close();
  }
});
