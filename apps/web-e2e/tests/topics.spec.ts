import { createPrismaConnection } from "@realentity/storm-db";
import { expect, test, type Page } from "@playwright/test";
import { unique } from "./support";

/** A topic's own page, on one of its tabs. */
async function open(page: Page, topicId: string, tab: "directions" | "facts" | "sources" | "emails") {
  await page.goto(`/topics/${topicId}?tab=${tab}`);
}

// M41-T2
test("a topic made, given directions of each kind, edited and archived", async ({ page }) => {
  const name = unique("Orion");
  await page.goto("/topics");
  await page.getByTestId("topic-add").click();
  const form = page.getByTestId("topic-form");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("What it is").fill("The customer portal rebuild for Client Ltd");
  await form.getByRole("button", { name: "Save" }).click();

  // Its own page, on its directions.
  await expect(page).toHaveURL(/\/topics\/[0-9a-f-]{36}\?tab=directions$/);
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

  // Asked first: dismissed, it stays.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await card.getByRole("button", { name: "Remove direction" }).first().click();
  await expect(card.getByTestId("directions").locator(".list-group-item")).toHaveCount(3);
  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Remove direction" }).first().click();
  await expect(card.getByTestId("directions").locator(".list-group-item")).toHaveCount(2);

  await card.getByRole("button", { name: "Edit" }).click();
  await page.getByTestId("topic-form").getByLabel("What it is").fill("The portal rebuild, phase 2");
  await page.getByTestId("topic-form").getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("The portal rebuild, phase 2");

  await card.getByRole("button", { name: "Archive" }).click();
  await expect(card).toContainText("archived");

  // The list: a row per topic, linking to its page.
  await card.getByRole("link", { name: "Topics" }).click();
  const row = page.getByTestId(`topic-row-${name}`);
  await expect(row).toContainText("archived");
  await expect(row).toContainText("The portal rebuild, phase 2");
  await row.getByRole("link", { name }).click();
  await expect(page.getByTestId(`topic-${name}`)).toBeVisible();
});

// The list stays short however much the topics know: counts, not their facts
test("the Topics list shows each topic's counts, and says when its facts don't all fit", async ({ page }) => {
  const name = unique("Orion");
  const topicId = await newTopic(page, name);
  for (let i = 0; i < 8; i++) {
    const response = await page.request.post(`/api/topics/${topicId}/facts`, {
      data: { about: `Note ${i}`, statement: "Routine detail of the weekly meeting. ".repeat(23).trim() },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/topics");
  const row = page.getByTestId(`topic-row-${name}`);
  await expect(row).toContainText("no directions");
  await expect(row).toContainText("8");
  await expect(row).toContainText("6 fit");
  await expect(row).not.toContainText("Note 0");

  await row.getByRole("link", { name }).click();
  await expect(page.getByTestId("topic-summary")).toContainText("8 facts (a draft has room for about 6)");
  // No direction yet: its page opens on them.
  await expect(page.getByTestId("tab-directions")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("tab-facts").click();
  const facts = page.getByTestId("topic-facts");
  await facts.getByLabel("Find a fact").fill("Note 3");
  await expect(facts.locator("[data-testid^='fact-Note']")).toHaveCount(1);
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
  const billingId = await newTopic(page, billing);
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

  await open(page, billingId, "emails");
  await expect(page.getByTestId(`topic-${billing}`).getByTestId("topic-emails")).toContainText(`Invoice ${orion}`);
  await expect(page.getByTestId(`topic-${billing}`).getByTestId("topic-emails")).toContainText("moved here from");

  await open(page, orionId, "emails");
  const orionEmails = page.getByTestId(`topic-${orion}`).getByTestId("topic-emails");
  await expect(orionEmails).toContainText(`Kickoff ${orion}`);
  await expect(orionEmails).toContainText(`Spec ${orion}`);
  await expect(orionEmails).not.toContainText(`Invoice ${orion}`);
  await expect(page.getByTestId("tab-emails")).toHaveText("Emails (2)");

  page.once("dialog", (dialog) => void dialog.accept());
  await orionEmails
    .locator(".list-group-item", { hasText: `Kickoff ${orion}` })
    .getByRole("button", { name: "Not this topic" })
    .click();
  await expect(orionEmails).not.toContainText(`Kickoff ${orion}`);
});

// M42-T1
test("a topic's facts: written, no longer true with what is true now, wrong, and a change undone from the history", async ({ page }) => {
  const name = unique("Orion");
  const topicId = await newTopic(page, name);
  await open(page, topicId, "facts");
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

  // Asked first.
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain('Mark "Database: MySQL" wrong?');
    void dialog.accept();
  });
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

// M44-T7
test("a topic with more facts than a draft has room for says so, and which ones a draft takes", async ({ page }) => {
  const name = unique("Orion");
  const topicId = await newTopic(page, name);
  const add = async (i: number) =>
    expect(
      (
        await page.request.post(`/api/topics/${topicId}/facts`, {
          data: { about: `Note ${i}`, statement: "Routine detail of the weekly meeting. ".repeat(23).trim() },
        })
      ).status(),
    ).toBe(201);
  await add(0);
  await open(page, topicId, "facts");
  const facts = page.getByTestId(`topic-${name}`).getByTestId("topic-facts");
  await expect(facts.getByTestId("fact-Note 0")).toBeVisible();
  await expect(facts.getByTestId("facts-room")).toHaveCount(0);
  for (let i = 1; i < 8; i++) await add(i);
  await page.reload();
  await expect(facts.getByTestId("facts-room")).toContainText("A draft has room for about 6 of these 8 facts");
  await expect(facts.getByTestId("facts-room")).toContainText("the ones you wrote or confirmed first");
  await expect(facts.getByTestId("facts-room")).toContainText("the weekly tidy-up");
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

// M44
test("Answer your topics' email: set up from the Topics page, off, an ordinary pipeline", async ({ page }) => {
  await page.goto("/topics");
  const card = page.getByTestId("topic-replies");
  await expect(card).toContainText("nothing is sent without you");
  await card.getByRole("button", { name: "Set up" }).click();
  await expect(card.getByTestId("topic-replies-status")).toContainText("Topic replies: off");
  await expect(card.getByTestId("topic-replies-checklist")).toContainText("Try it: a dry run");
  await card.getByRole("link", { name: "Topic replies" }).click();
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
  const pipelineId = page.url().split("/").at(-1)!;
  expect((await page.request.delete(`/api/pipelines/${pipelineId}`)).status()).toBe(204);
});

// M44-T8
test("Tidy up topics' facts: set up from the Topics page, off, with what it would read", async ({ page }) => {
  await page.goto("/topics");
  const card = page.getByTestId("topic-tidy");
  await expect(card).toContainText("You pick at its gate what is done");
  await card.getByRole("button", { name: "Set up" }).click();
  await expect(card.getByTestId("topic-tidy-status")).toContainText("Topic tidy-up: off");
  await expect(card.getByTestId("topic-tidy-status")).toContainText(/fit/);
  const checklist = card.getByTestId("topic-tidy-checklist");
  await expect(checklist).toContainText("Try it: a dry run");
  await expect(checklist).not.toContainText("An email account");
  await card.getByRole("link", { name: "Topic tidy-up" }).click();
  await expect(page).toHaveURL(/\/pipelines\/[0-9a-f-]{36}$/);
  const pipelineId = page.url().split("/").at(-1)!;
  expect((await page.request.delete(`/api/pipelines/${pipelineId}`)).status()).toBe(204);
});

// M43: a topic's GitHub source, linked and never copied
test("a topic's source: a repository added from its address, shown not read yet, then removed", async ({ page }) => {
  const name = unique("Orion");
  const topicId = await newTopic(page, name);
  await open(page, topicId, "sources");
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

// A private repository's token, made from the source form: a GitHub token, chosen as the source's once stored
test("a topic's source: a new GitHub token from the form is stored for api.github.com and chosen", async ({ page }) => {
  const name = unique("Orion");
  const credential = `gh-${Date.now().toString(36)}`;
  const topicId = await newTopic(page, name);
  await open(page, topicId, "sources");
  const sources = page.getByTestId(`topic-${name}`).getByTestId("topic-sources");
  await sources.getByTestId("source-add").click();
  await sources.getByTestId("source-new-token").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Add a GitHub token");
  await expect(dialog.getByTestId("github-steps")).toContainText("Contents: Read-only");
  await dialog.getByLabel("Name", { exact: true }).fill(credential);
  await dialog.getByLabel("Token").fill(`github_pat_e2e${Date.now()}`);
  await dialog.getByRole("button", { name: "Store" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(sources.getByTestId("source-form").getByLabel("Token")).toHaveValue(credential);

  const stored = (await (await page.request.get("/api/credentials")).json()) as { name: string; kind: string; allowedHosts: string[] }[];
  expect(stored.find((c) => c.name === credential)).toMatchObject({ kind: "API_KEY", allowedHosts: ["api.github.com"] });
});

// M43-T2: a Drive folder, read through the Google connection, which says when it doesn't allow Drive
test("a topic's source: a Drive folder from its link, with a word when Google's access doesn't include Drive", async ({ page }) => {
  const name = unique("Orion");
  const topicId = await newTopic(page, name);
  const db = createPrismaConnection();
  const { userId } = await db.client.topic.findUniqueOrThrow({ where: { topicId } });
  const sealed = { ciphertext: Buffer.from("x"), iv: Buffer.from("x"), authTag: Buffer.from("x"), wrappedDek: Buffer.from("x") };
  await db.client.googleConnection.create({
    data: { userId, email: "ana@gmail.test", scopes: ["https://www.googleapis.com/auth/calendar.events"], ...sealed },
  });
  try {
    await page.goto("/settings");
    await expect(page.getByTestId("google-allowed")).toContainText("Calendar: allowed");
    await expect(page.getByTestId("google-allowed")).toContainText("Drive (read-only): not allowed");

    await open(page, topicId, "sources");
    const sources = page.getByTestId(`topic-${name}`).getByTestId("topic-sources");
    await sources.getByTestId("source-add").click();
    const form = sources.getByTestId("source-form");
    await form.getByTestId("source-kind-drive").click();
    await expect(form.getByTestId("source-drive-access")).toContainText("doesn't include Drive");
    await expect(form.getByLabel("Branch")).toHaveCount(0);
    await form.getByLabel("Drive folder").fill("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing");
    await form.getByRole("button", { name: "Add" }).click();
    const row = sources.getByTestId("source-1AbCdEfGhIjKlMnOpQrStUv");
    await expect(row).toContainText("in Google Drive, with its subfolders");
    await expect(row).toContainText("not read yet: the next run of a pipeline with drive.changes reads it");
    await expect(row.getByRole("link", { name: "Drive folder" })).toHaveAttribute("href", "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv");
  } finally {
    await db.client.googleConnection.deleteMany({ where: { userId } });
    await db.close();
  }
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
    await open(page, topicId, "facts");
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

// M44-T1, T4
test("a direction suggested from the user's decisions, accepted; a topic split from its card", async ({ page }) => {
  const name = unique("Billing");
  const topicId = await newTopic(page, name);
  const sender = `${unique("ivan")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}@client.example`;
  const db = createPrismaConnection();
  try {
    const { userId } = await db.client.topic.findUniqueOrThrow({ where: { topicId } });
    await db.client.topicLink.createMany({
      data: [1, 2, 3].map((i) => ({
        userId,
        topicId,
        messageId: `<${sender}-${i}>`,
        threadId: `<${sender}-${i}>`,
        from: sender,
        subject: `Invoice ${i}`,
        date: new Date(),
        status: "CONFIRMED" as const,
        via: "USER" as const,
        evidence: "you",
      })),
    });
  } finally {
    await db.close();
  }
  await page.goto("/topics");
  const suggestion = page.getByTestId("topic-suggestions").getByTestId("suggestion-DIRECTION").filter({ hasText: sender });
  await expect(suggestion).toContainText(`${name}: add the person ${sender} as a direction?`);
  await suggestion.getByRole("button", { name: "Yes" }).click();
  await expect(suggestion).toHaveCount(0);
  await open(page, topicId, "directions");
  await expect(page.getByTestId(`topic-${name}`).getByTestId("directions")).toContainText(sender);

  // Split: the fact and the direction go to a new topic, whose page opens.
  expect((await page.request.post(`/api/topics/${topicId}/facts`, { data: { about: "Terms", statement: "30 days" } })).status()).toBe(201);
  await open(page, topicId, "facts");
  const card = page.getByTestId(`topic-${name}`);
  await card.getByRole("button", { name: "Split" }).click();
  const form = page.getByTestId("split-form");
  const split = unique("Invoices");
  await form.getByLabel("New topic").fill(split);
  await form.getByText("Terms: 30 days").click();
  await form.getByLabel(sender, { exact: true }).check();
  await form.getByRole("button", { name: "Split" }).click();
  await expect(page.getByTestId(`topic-${split}`).getByTestId("fact-Terms")).toContainText("Terms: 30 days");
  await page.getByTestId("tab-directions").click();
  await expect(page.getByTestId(`topic-${split}`).getByTestId("directions")).toContainText(sender);
  await open(page, topicId, "facts");
  await expect(page.getByTestId(`topic-${name}`).getByTestId("topic-facts")).toBeVisible();
  await expect(page.getByTestId(`topic-${name}`).getByTestId("fact-Terms")).toHaveCount(0);
});
