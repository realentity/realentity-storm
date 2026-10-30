/** Jest globalTeardown: removes what globalSetup started. */
export default async function globalTeardown(): Promise<void> {
  await globalThis.__AIME_TEST_INFRASTRUCTURE__?.stop();
  globalThis.__AIME_TEST_INFRASTRUCTURE__ = undefined;
}
