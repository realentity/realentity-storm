import { DatabasePreparer } from "./database-preparer";
import { TestEnvironment } from "./test-environment";
import { TestInfrastructure } from "./test-infrastructure";
import { TEST_TIME_ZONE } from "./time-zone";

export { TEST_TIME_ZONE };

declare global {
  var __STORM_TEST_INFRASTRUCTURE__: TestInfrastructure | undefined;
}

/** Jest globalSetup: starts PostgreSQL once per run, migrates and seeds, and exports the test environment. */
export default async function globalSetup(): Promise<void> {
  // The tests' expectations are written in one zone: the same results on every machine and in CI, whatever its zone.
  process.env.TZ = TEST_TIME_ZONE;
  const infrastructure = TestInfrastructure.fromEnvironment();
  const databaseUrl = await infrastructure.start();
  globalThis.__STORM_TEST_INFRASTRUCTURE__ = infrastructure;

  TestEnvironment.apply(databaseUrl);
  try {
    await new DatabasePreparer().prepare(databaseUrl);
  } catch (error) {
    await infrastructure.stop();
    throw error;
  }
}
