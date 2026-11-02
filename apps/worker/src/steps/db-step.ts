import { Client, TypeOverrides, type FieldDef, type QueryConfig } from "pg";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { type CredentialVault } from "../secrets/credential-vault";

type Item = Record<string, unknown>;

interface QueryInput {
  connection: string;
  sql: string;
  params: (string | number | boolean | null)[];
  maxRows: number;
  timeoutSeconds: number;
}

/** A connector to PostgreSQL: tests replace it to count connections. */
export type Connect = (connectionString: string, timeoutMs: number) => Client;

/** bigint (counts) as a number while it is exact; every other type as pg gives it. */
const TYPES = new TypeOverrides();
TYPES.setTypeParser(20, (value: string) => (Number.isSafeInteger(Number(value)) ? Number(value) : value));

const connect: Connect = (connectionString, timeoutMs) =>
  new Client({ connectionString: readOnly(connectionString), connectionTimeoutMillis: timeoutMs, application_name: "ai-me db.query", types: TYPES });

/**
 * Read-only from the first statement, whatever the role may do. Added to the URL's own `options` (a search_path, say):
 * pg lets the URL's settings override the client's, so an `options` in the URL would otherwise drop it.
 */
export function readOnly(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", [url.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return url.href;
}

/**
 * db.query (M29-T7): one read of a PostgreSQL database through a DATABASE credential (its connection URL, opened by the
 * vault only when its host is one the credential allows). The query runs as a subquery (`SELECT * FROM (<sql>)`), so
 * only something that reads fits; through the extended protocol, so it is one statement; in a READ ONLY transaction
 * that is always rolled back, with a statement timeout; and at most maxRows rows come back. A dry run reads too.
 */
export class DbQueryStep implements StepExecutor {
  readonly type = "db.query";

  constructor(
    private readonly vault?: CredentialVault,
    private readonly open: Connect = connect,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { connection, sql, params, maxRows, timeoutSeconds } = input as unknown as QueryInput;
    const name = /\{\{\s*cred:([a-z0-9._-]+)\s*\}\}/.exec(connection)?.[1];
    if (!name) throw new Error("db.query: `connection` is a database credential, {{cred:name}}");
    if (!this.vault) throw new Error(`db.query can't use credentials here ("${name}")`);
    const { secret } = await this.vault.revealConnection(context.userId, name);
    const mask = (text: string) => text.split(secret).join("•••");

    const timeout = timeoutSeconds * 1000;
    const client = this.open(secret, timeout);
    // A server that goes away mid-query emits an error on the client; the query's own rejection reports it.
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      const body = sql.trim().replace(/;+\s*$/, "");
      // queryMode "extended": one statement even without parameters (the simple protocol would run "…; DROP TABLE x"
      // as two). pg supports it; its types don't list it yet.
      const query: QueryConfig & { queryMode: "extended" } = {
        text: `SELECT * FROM (\n${body}\n) AS ai_me_query LIMIT ${maxRows + 1}`,
        values: params,
        queryMode: "extended",
      };
      const result = await client.query<Item>(query);
      const rows = result.rows.slice(0, maxRows).map(plain);
      return { items: rows, rows: rows.length, truncated: result.rows.length > maxRows, columns: result.fields.map((f: FieldDef) => f.name) };
    } catch (error) {
      throw new Error(`db.query (${name}): ${mask(error instanceof Error ? error.message : String(error))}`);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  }
}

/** A row as JSON: dates as ISO text, bytes as their size. */
function plain(row: Item): Item {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? `<${value.length} bytes>` : value,
    ]),
  );
}
