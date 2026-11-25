import { randomBytes } from "node:crypto";
import { parseServerEnv, removedEnvWarning } from "./env";

const valid = (): Record<string, string> => ({
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});

// M0-U1
describe("parseServerEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = parseServerEnv(valid());
    expect(env.API_PORT).toBe(3000);
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
    expect(env.APP_ADMIN_PASSWORD_HASH).toBeUndefined();
  });

  it("treats empty values as not set", () => {
    const env = parseServerEnv({ ...valid(), APP_TOTP_SECRET: "", VNC_PASSWORD: "" });
    expect(env.APP_TOTP_SECRET).toBeUndefined();
    expect(env.VNC_PASSWORD).toBeUndefined();
  });

  // M62: Claude, the model servers and the models are set up in Settings → AI
  it("doesn't read the AI keys any more, and says which are still set, never their values", () => {
    const old = { ANTHROPIC_API_KEY: "sk-ant-made-up", LLM_MODEL_WRITING: "claude-sonnet-5-5", OPENAI_BASE_URL: "not even a url", LLM_MONTHLY_BUDGET_USD: "" };
    const env = parseServerEnv({ ...valid(), ...old });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_BASE_URL");
    const warning = removedEnvWarning(old);
    expect(warning).toBe("No longer read from .env (set them up in Settings → AI, then remove them): ANTHROPIC_API_KEY, OPENAI_BASE_URL, LLM_MODEL_WRITING");
    expect(warning).not.toContain("sk-ant");
    expect(removedEnvWarning(valid())).toBeNull();
  });

  it("accepts a hex ENCRYPTION_KEY", () => {
    expect(() => parseServerEnv({ ...valid(), ENCRYPTION_KEY: randomBytes(32).toString("hex") })).not.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["short hex", randomBytes(16).toString("hex")],
    ["short", randomBytes(16).toString("base64")],
    ["not base64", "change-me"],
  ])("rejects a %s ENCRYPTION_KEY", (_name, value) => {
    expect(() => parseServerEnv({ ...valid(), ENCRYPTION_KEY: value })).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects a missing DATABASE_URL", () => {
    const { DATABASE_URL: _, ...rest } = valid();
    expect(() => parseServerEnv(rest)).toThrow(/DATABASE_URL: is required/);
  });

  it("never puts values into the error message", () => {
    const secret = "do-not-print-me-0123456789";
    let message = "";
    try {
      parseServerEnv({ ...valid(), ENCRYPTION_KEY: secret, APP_ADMIN_PASSWORD_HASH: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ENCRYPTION_KEY/);
    expect(message).not.toContain(secret);
  });
});
