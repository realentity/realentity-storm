import { DatabasePreparer } from "./database-preparer";
import { TestEnvironment } from "./test-environment";
import { TestInfrastructure } from "./test-infrastructure";

declare global {
  var __AIME_TEST_INFRASTRUCTURE__: TestInfrastructure | undefined;
}

/** Jest globalSetup: starts PostgreSQL once per run, migrates and seeds, and exports the test environment. */
export default async function globalSetup(): Promise<void> {
  const infrastructure = TestInfrastructure.fromEnvironment();
  const databaseUrl = await infrastructure.start();
  globalThis.__AIME_TEST_INFRASTRUCTURE__ = infrastructure;

  TestEnvironment.apply(databaseUrl);
  try {
    await new DatabasePreparer().prepare(databaseUrl);
  } catch (error) {
    await infrastructure.stop();
    throw error;
  }
}
