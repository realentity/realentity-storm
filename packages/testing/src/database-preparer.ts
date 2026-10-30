import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Brings an empty database to the state the application expects: the real migrations (`prisma migrate deploy`)
 * and the real seed. Tests therefore run against the same schema as production.
 */
export class DatabasePreparer {
  private readonly databasePackageDir: string;

  constructor(workspaceRoot: string = DatabasePreparer.findWorkspaceRoot()) {
    this.databasePackageDir = join(workspaceRoot, "packages", "db");
  }

  async prepare(databaseUrl: string): Promise<void> {
    const environment = { ...process.env, DATABASE_URL: databaseUrl };
    await this.pnpm(["exec", "prisma", "migrate", "deploy"], environment);
    await this.requireMigrationsMatchSchema(environment);
    await this.pnpm(["exec", "tsx", "prisma/seed.ts"], environment);
  }

  /** A schema change without its migration fails here, with what to run, instead of as "column does not exist" in a test. */
  private async requireMigrationsMatchSchema(environment: NodeJS.ProcessEnv): Promise<void> {
    const diff = ["exec", "prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"];
    try {
      await run("pnpm", diff, { cwd: this.databasePackageDir, env: environment, shell: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      if (DatabasePreparer.exitCodeOf(error) !== 2) throw new Error(`"pnpm ${diff.join(" ")}" failed\n${DatabasePreparer.outputOf(error)}`);
      throw new Error("schema.prisma has changes that prisma/migrations lacks. Run pnpm db:migrate --name <name>.");
    }
  }

  private async pnpm(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
    try {
      // shell: pnpm is a .cmd shim on Windows.
      await run("pnpm", args, { cwd: this.databasePackageDir, env: environment, shell: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`"pnpm ${args.join(" ")}" failed in ${this.databasePackageDir}\n${DatabasePreparer.outputOf(error)}`);
    }
  }

  private static exitCodeOf(error: unknown): unknown {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  }

  private static outputOf(error: unknown): string {
    if (typeof error !== "object" || error === null) return String(error);
    const parts = ["stdout" in error ? error.stdout : "", "stderr" in error ? error.stderr : ""];
    return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
  }

  static findWorkspaceRoot(start: string = process.cwd()): string {
    let current = start;
    for (;;) {
      if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`No pnpm-workspace.yaml above ${start}`);
      }
      current = parent;
    }
  }
}
