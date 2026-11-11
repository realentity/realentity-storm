import { expect, test } from "@playwright/test";

// M3-E5
test("the credentials page never displays a stored value (DOM and network)", async ({ page }) => {
  const secret = `e2e-SECRET-${Date.now()}-first`;
  const replacement = `e2e-SECRET-${Date.now()}-second`;
  const name = `e2e-site-${Date.now().toString(36)}`;
  // Every api response body and every live event the page receives.
  const bodies: Promise<string>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/")) bodies.push(response.text().catch(() => ""));
  });
  page.on("websocket", (socket) => socket.on("framereceived", (frame) => bodies.push(Promise.resolve(String(frame.payload)))));

  await page.goto("/credentials");
  await page.getByTestId("add-credential").click();
  const form = page.getByTestId("credential-form");
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Allowed hosts").fill("example.org, *.example.org");
  await form.getByLabel("Username (optional)").fill("me@example.org");
  await page.getByTestId("credential-secret").fill(secret);
  await form.getByRole("button", { name: "Store" }).click();
  const row = page.getByTestId("credentials").locator("tr", { hasText: name });
  await expect(row).toContainText("example.org, *.example.org");

  await row.getByRole("button", { name: "Replace" }).click();
  await page.getByLabel("New secret").fill(replacement);
  await page.getByRole("button", { name: "Replace", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("credentials").locator("tr", { hasText: name })).toBeVisible();

  // DOM: not in the markup, not in any input's value.
  const html = await page.content();
  expect(html).not.toContain(secret);
  expect(html).not.toContain(replacement);
  for (const value of await page.locator("input, textarea").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))) {
    expect(value).not.toContain("e2e-SECRET");
  }
  // Network: no api response (or live event) carries either value.
  await page.waitForLoadState("networkidle");
  const everything = (await Promise.all(bodies)).join("\n");
  expect(everything).toContain(name);
  expect(everything).not.toContain(secret);
  expect(everything).not.toContain(replacement);
});

// M29: a database is one connection string; its host becomes the allowed host
test("a database credential: one connection string, checked as it is typed, its host the allowed host", async ({ page }) => {
  const name = `e2e-db-${Date.now().toString(36)}`;
  const password = `e2e-DBPASS-${Date.now()}`;
  await page.goto("/credentials");
  await page.getByTestId("add-credential").click();
  const form = page.getByTestId("credential-form");
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Kind").selectOption("DATABASE");
  await expect(form.getByLabel("Allowed hosts")).toHaveCount(0);
  await expect(form.getByLabel("Username (optional)")).toHaveCount(0);

  const connection = form.getByLabel("Connection string");
  await connection.fill("host=postgres dbname=app");
  await expect(form).toContainText("Not a connection string");
  await expect(form.getByRole("button", { name: "Store" })).toBeDisabled();
  await connection.fill(`postgresql://reader:${password}@db.example.ts.net:5433/shop`);
  await expect(page.getByTestId("connection-hint")).toHaveText(
    "Connects to database shop on db.example.ts.net:5433 as reader, and nowhere else.",
  );
  await page.screenshot({ path: "test-results/credential-database.png" });
  await form.getByRole("button", { name: "Store" }).click();

  const row = page.getByTestId("credentials").locator("tr", { hasText: name });
  await expect(row).toContainText("database");
  await expect(row).toContainText("db.example.ts.net");

  await row.getByRole("button", { name: "Replace" }).click();
  await page.getByLabel("New connection string").fill(`postgresql://reader:${password}@elsewhere.example.org/shop`);
  await expect(page.getByTestId("connection-hint")).toContainText("not db.example.ts.net. Another server is another credential.");
  // The preview names the server, never the password.
  await expect(page.getByTestId("connection-hint")).not.toContainText(password);
});

// A GitHub token: an API key for api.github.com only, with the steps to make one; shown as a GitHub token
test("a GitHub token: the steps to make one, api.github.com as its only host, a pasted password pointed out", async ({ page }) => {
  const name = `e2e-gh-${Date.now().toString(36)}`;
  await page.goto("/credentials");
  await page.getByTestId("add-credential").click();
  const form = page.getByTestId("credential-form");
  await form.getByLabel("Name", { exact: true }).fill(name);
  await expect(page.getByTestId("credential-kind-hint")).toContainText("browser.open's login");
  await form.getByLabel("Kind").selectOption("GITHUB");
  await expect(page.getByTestId("github-steps")).toContainText("Fine-grained");
  await expect(form.getByLabel("Allowed hosts")).toHaveCount(0);
  await expect(form.getByLabel("Username (optional)")).toHaveCount(0);
  await expect(form).toContainText("api.github.com only");

  const token = form.getByLabel("Token");
  await token.fill("my-github-password");
  await expect(page.getByTestId("token-hint")).toContainText("doesn't look like a GitHub token");
  await token.fill(`github_pat_e2e${Date.now()}`);
  await expect(page.getByTestId("token-hint")).toHaveCount(0);
  await form.getByRole("button", { name: "Store" }).click();

  const row = page.getByTestId("credentials").locator("tr", { hasText: name });
  await expect(row).toContainText("GitHub token");
  await expect(row).toContainText("api.github.com");
  await row.getByRole("button", { name: "Replace" }).click();
  await expect(page.getByLabel("New token")).toBeVisible();
});
