import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

export type TestInfrastructureKind = "containers" | "local";

/** The same image the CI workflow and docker-compose use. */
const POSTGRES_IMAGE = "pgvector/pgvector:pg17";

/**
 * PostgreSQL (with pgvector) for integration tests (Strategy).
 * - containers: a throwaway Docker container (Testcontainers); the default, used in CI.
 * - local: a temporary database on an existing server (needs CREATEDB and pgvector installed there); no Docker needed.
 */
export abstract class TestInfrastructure {
  abstract readonly kind: TestInfrastructureKind;

  /** Returns the connection string of an empty database. */
  abstract start(): Promise<string>;

  abstract stop(): Promise<void>;

  /** E2E_INFRA=local uses an existing server (E2E_DATABASE_URL or DATABASE_URL); anything else uses containers. */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): TestInfrastructure {
    if (environment.E2E_INFRA !== "local") {
      return new ContainerTestInfrastructure();
    }
    const serverUrl = environment.E2E_DATABASE_URL ?? environment.DATABASE_URL;
    if (!serverUrl) {
      throw new Error("E2E_INFRA=local needs E2E_DATABASE_URL or DATABASE_URL");
    }
    return new LocalTestInfrastructure(serverUrl);
  }
}

export class ContainerTestInfrastructure extends TestInfrastructure {
  readonly kind = "containers";
  private postgres: StartedPostgreSqlContainer | null = null;

  async start(): Promise<string> {
    this.postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase("aime_e2e")
      .withUsername("aime")
      .withPassword("aime")
      .start();
    return this.postgres.getConnectionUri();
  }

  async stop(): Promise<void> {
    await this.postgres?.stop();
    this.postgres = null;
  }
}

export class LocalTestInfrastructure extends TestInfrastructure {
  readonly kind = "local";
  private readonly databaseName = `aime_e2e_${process.pid}_${Date.now()}`;

  constructor(private readonly serverUrl: string) {
    super();
  }

  async start(): Promise<string> {
    await this.onServer(`CREATE DATABASE "${this.databaseName}"`);
    const url = new URL(this.serverUrl);
    url.pathname = `/${this.databaseName}`;
    url.search = "";
    return url.toString();
  }

  async stop(): Promise<void> {
    await this.onServer(`DROP DATABASE IF EXISTS "${this.databaseName}" WITH (FORCE)`);
  }

  /** Runs a statement on the maintenance database of the server. */
  private async onServer(statement: string): Promise<void> {
    const url = new URL(this.serverUrl);
    url.pathname = "/postgres";
    url.search = "";
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }
}
