import { expect, test } from "@playwright/test";
import { authenticator } from "otplib";
import { PASSWORD, STACK_ENV } from "../src/stack";

test.use({ storageState: { cookies: [], origins: [] } });

// M3-T1: password + TOTP. One successful login per run: a TOTP code can't be used twice.
test("signs in with password and authenticator code, and out again", async ({ page }) => {
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Password").fill("wrong password");
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  const secret = process.env[STACK_ENV.totpSecret];
  expect(secret, "set by the global setup").toBeTruthy();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Authenticator code").fill(authenticator.generate(secret!));
  await page.getByRole("button", { name: "Sign in" }).click();
  // The page asked for opens.
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();

  await page.getByTitle("Sign out").click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
