import { type Page } from "playwright";

/** CAPTCHA widgets by their frames or markers: reCAPTCHA, hCaptcha, Cloudflare Turnstile, and generic challenges. */
const CAPTCHA = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  "[data-sitekey]",
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "[data-captcha]",
].join(", ");

const CAPTCHA_TEXT = /verify (that )?you are (a )?human|are you a robot|i'?m not a robot|security check|потвърдете,? че не сте робот/i;

/** A one-time code prompt: the field's autocomplete hint, or a code field next to words about a code. */
const TWO_FACTOR = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="2fa" i], input[id*="otp" i]';
const TWO_FACTOR_TEXT = /verification code|authentication code|two-factor|2-step|security code|код за потвърждение/i;

/**
 * Why the page needs the user (docs/design.md §6), or null: a CAPTCHA or a 2FA prompt. Unknown pages (a selector that doesn't
 * appear) and timeouts are found by the step, which knows what it waits for.
 */
export async function blockingState(page: Page): Promise<string | null> {
  if (await visible(page, CAPTCHA)) return "CAPTCHA";
  const text = await page
    .locator("body")
    .innerText({ timeout: 2_000 })
    .catch(() => "");
  if (CAPTCHA_TEXT.test(text.slice(0, 5_000))) return "CAPTCHA";
  if (await visible(page, TWO_FACTOR)) return "2FA prompt";
  if (
    TWO_FACTOR_TEXT.test(text.slice(0, 5_000)) &&
    (await visible(page, 'input[inputmode="numeric"], input[type="tel"], input[maxlength="6"]'))
  ) {
    return "2FA prompt";
  }
  return null;
}

async function visible(page: Page, selector: string): Promise<boolean> {
  const all = page.locator(selector);
  const count = await all.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 5); i++) {
    if (
      await all
        .nth(i)
        .isVisible()
        .catch(() => false)
    )
      return true;
  }
  return false;
}
