import { type PrismaClient } from "@realentity/storm-db";
import { type TelegramMessage } from "@realentity/storm-shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, type Locator, type Page } from "playwright";
import { type ArtifactOwner, type ArtifactStore } from "../browser/artifact-store";
import { blockingState } from "../browser/blocking";
import { type BrowserPool } from "../browser/browser-pool";
import { PageSecrets } from "../browser/page-secrets";
import { type SessionStore } from "../browser/session-store";
import { NO_ATTENTION, RunStopped, type Attention, type StepContext, type StepExecutor } from "../runner/step-executor";
import { type CredentialAsker, type CredentialVault } from "../secrets/credential-vault";

/** Page text returned to the pipeline (an LLM step may read it next). */
const MAX_TEXT = 50_000;
/** How often a long wait looks for Take over. */
const SLICE_MS = 1_000;
/** A page still blocked after this many takeovers fails the step. */
const MAX_TAKEOVERS = 3;

const PASSWORD = 'input[type="password"]';
const USERNAME =
  'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[type="text"]';
const SUBMIT = 'button[type="submit"], input[type="submit"], button:not([type])';

interface OpenInput {
  url: string;
  headed: boolean;
  login?: { credential: string; username?: string; password?: string; submit?: string };
  waitFor?: string;
  timeoutSeconds: number;
}

export interface BrowserDependencies {
  prisma: PrismaClient;
  pool: BrowserPool;
  sessions: SessionStore;
  vault: CredentialVault;
  artifacts: ArtifactStore;
  /** A Telegram message to the user (a broken recipe). */
  notify?(message: string | TelegramMessage): Promise<void>;
  /** The address the browser uses (APP_ORIGIN), for the message's button. */
  appOrigin?: string;
}

/**
 * browser.open (docs/design.md §6): a page in a fresh context with the site's kept login, signed in with a credential when
 * the page asks for one, and its text. Headed, the user can watch it and take over: on a CAPTCHA, a 2FA prompt, a
 * sign-in that didn't go through or a page without what it waits for, it waits for the user with the page open and
 * goes on from where they left it. Secrets never leave it: the text is masked, screenshots cover the fields, the trace is redacted.
 */
export class BrowserOpenStep implements StepExecutor {
  readonly type = "browser.open";

  constructor(private readonly deps: BrowserDependencies) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, headed, login, waitFor, timeoutSeconds } = input as unknown as OpenInput;
    const timeout = timeoutSeconds * 1000;
    const site = new URL(url).hostname;
    const owner: ArtifactOwner = { userId: context.userId, runId: context.runId, stepKey: context.stepKey, itemIndex: context.itemIndex };
    const secrets = new PageSecrets();

    const storageState = await this.deps.sessions.load(context.userId, site);
    const lease = await this.deps.pool.lease(headed, { storageState, acceptDownloads: false });
    // Only the live browser can be taken over.
    const attention = lease.headed ? context.attention : NO_ATTENTION;
    rememberSession(secrets, storageState);
    await lease.context.tracing.start({ screenshots: true, snapshots: true });
    let page: Page | undefined;
    try {
      page = await lease.context.newPage();
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await settle(page);
      await unblock(page, attention);

      let signedIn = false;
      if (login && (await signInForm(page))) {
        signedIn = await this.signIn(page, login, context, secrets, attention, timeout);
      }
      if (waitFor) await waitForSelector(page, waitFor, timeout, attention);
      await attention.checkpoint(page.url());

      const text = secrets.mask(await page.locator("body").innerText()).slice(0, MAX_TEXT);
      const output = { url: secrets.mask(page.url()), title: secrets.mask(await page.title()), text, signedIn };
      const state = await lease.context.storageState();
      rememberSession(secrets, state);
      await this.deps.sessions.save(context.userId, site, state);
      await this.screenshot(page, secrets, owner);
      return output;
    } catch (error) {
      if (page) await this.screenshot(page, secrets, owner).catch(() => undefined);
      if (error instanceof RunStopped) throw error;
      throw new Error(secrets.mask(error instanceof Error ? error.message : String(error)));
    } finally {
      await this.trace(lease.context, secrets, owner).catch(() => undefined);
      await lease.close();
    }
  }

  /**
   * Fills the sign-in form (one page, or username then password) with the credential, only on a host the credential
   * is bound to (docs/design.md §7, M8-S1): the vault refuses others, and the host is checked again right before typing.
   */
  private async signIn(
    page: Page,
    login: NonNullable<OpenInput["login"]>,
    asker: CredentialAsker,
    secrets: PageSecrets,
    attention: Attention,
    timeout: number,
  ): Promise<boolean> {
    const name = /cred:([a-z0-9][a-z0-9_-]{0,39})/.exec(login.credential)?.[1] ?? "";
    for (let stage = 0; stage < 2; stage++) {
      const host = new URL(page.url()).hostname;
      const credential = await this.deps.vault.revealFor(asker, name, host);
      secrets.add(credential.secret, login.password ?? PASSWORD);
      const sameHost = () => new URL(page.url()).hostname === host;

      const password = page.locator(login.password ?? PASSWORD).first();
      const hasPassword = await password.isVisible().catch(() => false);
      const username = login.username ? page.locator(login.username).first() : await firstVisible(page, USERNAME);
      if (
        username &&
        credential.username &&
        (await username.isVisible().catch(() => false)) &&
        !(await username.inputValue().catch(() => ""))
      ) {
        if (!sameHost()) throw new Error(`The page moved to another host while signing in; not filling "${name}"`);
        await username.fill(credential.username);
      }
      if (hasPassword) {
        if (!sameHost()) throw new Error(`The page moved to another host while signing in; not filling "${name}"`);
        await password.fill(credential.secret);
      }
      await submit(page, login.submit, hasPassword ? password : username);
      await settle(page, timeout);
      await unblock(page, attention);
      if (!(await signInForm(page))) return true;
      // Username first, password on the next page (most SSO providers): one more round.
      if (hasPassword) break;
    }
    // Still on a sign-in form: wrong password, an extra question, a consent screen.
    await attention.needMe("The sign-in didn't go through", page.url());
    if (await signInForm(page)) throw new Error("Still on the sign-in page");
    return true;
  }

  /** The page as it ended, with every secret field covered (M8-T7). */
  private async screenshot(page: Page, secrets: PageSecrets, owner: ArtifactOwner): Promise<void> {
    const png = await page.screenshot({ fullPage: false, mask: secrets.masks(page), maskColor: "#555", timeout: 10_000 });
    await this.deps.artifacts.save(this.deps.prisma, owner, "screenshot", png, "png", "image/png");
  }

  /** The Playwright trace, redacted (credential values, cookies and stored tokens masked) or not kept at all. */
  private async trace(context: BrowserContext, secrets: PageSecrets, owner: ArtifactOwner): Promise<void> {
    // tracing.stop writes a file: a private temp folder, removed right after.
    const dir = await mkdtemp(join(tmpdir(), "storm-trace-"));
    try {
      const path = join(dir, "trace.zip");
      await context.tracing.stop({ path });
      const redacted = secrets.redactTrace(await readFile(path));
      if (redacted) await this.deps.artifacts.save(this.deps.prisma, owner, "trace", redacted, "zip", "application/zip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Cookie and local-storage values are session tokens: masked wherever they could appear. */
function rememberSession(secrets: PageSecrets, state: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined): void {
  for (const cookie of state?.cookies ?? []) if (cookie.value.length >= 8) secrets.add(cookie.value);
  for (const origin of state?.origins ?? []) for (const item of origin.localStorage) if (item.value.length >= 8) secrets.add(item.value);
}

/** Waits for a CAPTCHA or 2FA prompt to go away, with the user. */
async function unblock(page: Page, attention: Attention): Promise<void> {
  for (let i = 0; i < MAX_TAKEOVERS; i++) {
    const reason = await blockingState(page);
    if (!reason) return;
    await attention.needMe(reason, page.url());
    await settle(page);
  }
  if (await blockingState(page)) throw new Error("The page is still blocked after taking over");
}

/** The selector, waited for in slices so Take over works meanwhile; missing, the user takes a look. */
async function waitForSelector(page: Page, selector: string, timeout: number, attention: Attention): Promise<void> {
  const found = async (ms: number) =>
    page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout: ms })
      .then(() => true)
      .catch(() => false);
  for (let waited = 0; waited < timeout; waited += SLICE_MS) {
    if (await found(SLICE_MS)) return;
    await attention.checkpoint(page.url());
  }
  await unblock(page, attention);
  if (await found(SLICE_MS)) return;
  await attention.needMe(`"${selector}" didn't appear`, page.url());
  if (!(await found(5_000))) throw new Error(`"${selector}" didn't appear within ${Math.round(timeout / 1000)} s`);
}

async function signInForm(page: Page): Promise<boolean> {
  return page
    .locator(PASSWORD)
    .first()
    .isVisible()
    .catch(() => false);
}

async function firstVisible(page: Page, selector: string): Promise<Locator | null> {
  const all = page.locator(selector);
  const count = await all.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 10); i++) {
    if (
      await all
        .nth(i)
        .isVisible()
        .catch(() => false)
    )
      return all.nth(i);
  }
  return null;
}

async function submit(page: Page, selector: string | undefined, field: Locator | null): Promise<void> {
  const button = selector ? page.locator(selector).first() : await firstVisible(page, SUBMIT);
  if (button) await button.click();
  else if (field) await field.press("Enter");
}

/** After a navigation: the page loaded, and its requests quiet for a moment (not forever: some pages poll). */
async function settle(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 3_000) }).catch(() => undefined);
}
