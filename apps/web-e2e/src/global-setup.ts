import { startStack, stopStack } from "./stack";

/** Starts the stack for the whole run; the teardown is the returned function (Playwright calls it at the end). */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  return () => stopStack(stack);
}
