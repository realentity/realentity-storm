import { expect, test } from "@playwright/test";
import { unique } from "./support";

// The Start menu: every App over the page open, found by typing, pinned to the sidebar as a square
test("the Start menu opens an App found by typing, and pins it to the sidebar", async ({ page }) => {
  const name = unique("Shelf");
  const label = `Books ${name.split(" ")[1]}`;
  const created = await page.request.post("/api/apps", {
    data: {
      source: `name: ${name}
icon: book
types:
  Book:
    key: id
    title: title
    fields:
      id: { type: text, required: true }
      title: { type: text, required: true }
pages:
  - list: Book
    menu: { label: "${label}" }
`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { appId } = (await created.json()) as { appId: string };

  try {
    // Ctrl+K over any page; typing finds it, Enter opens it, and the menu is gone.
    await page.goto("/inbox");
    // The signed-in layout listens once it is there (after the session is read).
    await expect(page.getByTestId("start-button")).toBeVisible();
    await page.keyboard.press("Control+k");
    const menu = page.getByTestId("start-menu");
    await expect(menu).toBeVisible();
    await page.getByTestId("start-search").fill(name);
    await expect(menu.getByTestId("start-app")).toHaveCount(1);
    await page.getByTestId("start-search").press("Enter");
    await expect(page).toHaveURL(new RegExp(`/a/${appId}/Book$`));
    await expect(menu).toHaveCount(0);

    // Its pages' names find it too; Escape closes it, and the page stays.
    await page.getByTestId("start-button").click();
    await page.getByTestId("start-search").fill(label);
    await expect(menu.getByTestId("start-app")).toHaveText(name);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/a/${appId}/Book$`));

    // Pinned: a square in the sidebar, lit while the App is open.
    await page.getByTestId("start-button").click();
    await page.getByTestId("start-search").fill(name);
    const pin = menu.locator(".start-tile", { hasText: name }).getByTestId("start-pin");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    const square = page.getByTestId("app-square").filter({ hasText: name });
    await expect(square).toHaveAttribute("aria-current", "page");

    // Elsewhere it is there, not lit; it opens the App.
    await page.goto("/history");
    await expect(square).not.toHaveAttribute("aria-current", "page");
    await square.click();
    await expect(page).toHaveURL(new RegExp(`/a/${appId}/Book$`));
  } finally {
    // Pinned Apps take the sidebar over: the other tests' Apps aren't squares while this one is pinned.
    await page.request.put(`/api/apps/${appId}/pinned`, { data: { pinned: false } });
  }
});
