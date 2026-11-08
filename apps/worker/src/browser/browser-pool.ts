import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from "playwright";

/** At most this many headless pages at once in this process (each context is a separate tab-set). */
const HEADLESS_CONTEXTS = 3;

export interface PoolOptions {
  /** Where headed Chromium draws (the worker image's Xvfb, :99). Unset: DISPLAY, or the machine's own screen. */
  display?: string;
  /** Tests and CI: the headed slot (one at a time, can be taken over) without a window. */
  invisible?: boolean;
}

/** A browser context for one step; `close` returns its slot. */
export interface Lease {
  context: BrowserContext;
  headed: boolean;
  close(): Promise<void>;
}

/**
 * The worker's browsers (docs/design.md §6): one shared headless Chromium for unattended work, with a few contexts at once,
 * and one headed slot on the virtual display, launched for the step that needs it and closed after (the live view
 * then shows an empty desktop). Headed runs are already one at a time across workers (the runs-headed queue); the
 * slot also serializes them inside one process. Every step gets a fresh context: no profile folder on disk, logins
 * come only from the sealed storageState it is given.
 */
export class BrowserPool {
  private headless: Promise<Browser> | null = null;
  private headlessInUse = 0;
  private readonly headlessQueue: (() => void)[] = [];
  private headedBusy: Promise<void> = Promise.resolve();

  constructor(private readonly options: PoolOptions = {}) {}

  async lease(headed: boolean, contextOptions: BrowserContextOptions): Promise<Lease> {
    return headed ? this.leaseHeaded(contextOptions) : this.leaseHeadless(contextOptions);
  }

  async close(): Promise<void> {
    const browser = this.headless;
    this.headless = null;
    if (browser) await (await browser).close().catch(() => undefined);
  }

  private async leaseHeadless(contextOptions: BrowserContextOptions): Promise<Lease> {
    if (this.headlessInUse >= HEADLESS_CONTEXTS) await new Promise<void>((resolve) => this.headlessQueue.push(resolve));
    this.headlessInUse++;
    try {
      this.headless ??= chromium.launch({ headless: true });
      const context = await (await this.headless).newContext(contextOptions);
      return {
        context,
        headed: false,
        close: async () => {
          await context.close().catch(() => undefined);
          this.release();
        },
      };
    } catch (error) {
      this.headless = null;
      this.release();
      throw error;
    }
  }

  private release(): void {
    this.headlessInUse--;
    this.headlessQueue.shift()?.();
  }

  private async leaseHeaded(contextOptions: BrowserContextOptions): Promise<Lease> {
    let free!: () => void;
    const previous = this.headedBusy;
    this.headedBusy = new Promise<void>((resolve) => (free = resolve));
    await previous;
    try {
      const browser = await chromium.launch({
        headless: this.options.invisible ?? false,
        env: this.options.display ? { ...process.env, DISPLAY: this.options.display } : undefined,
        // Full-screen on the virtual display, so the live view shows the page and nothing else.
        args: ["--start-maximized", "--no-first-run", "--disable-infobars"],
      });
      const context = await browser.newContext({ ...contextOptions, viewport: this.options.invisible ? undefined : null });
      return {
        context,
        headed: true,
        close: async () => {
          await browser.close().catch(() => undefined);
          free();
        },
      };
    } catch (error) {
      free();
      throw error;
    }
  }
}
