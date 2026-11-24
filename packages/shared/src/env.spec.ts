import { randomBytes } from "node:crypto";
import { parseServerEnv } from "./env";

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
    const env = parseServerEnv({ ...valid(), APP_TOTP_SECRET: "", ANTHROPIC_API_KEY: "" });
    expect(env.APP_TOTP_SECRET).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // M60
  it("takes a model on an OpenAI-compatible server and its address", () => {
    const env = parseServerEnv({ ...valid(), OPENAI_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "openai:qwen3:14b", LLM_MODEL_BUILDER: "claude-opus-5-5" });
    expect(env).toMatchObject({ OPENAI_BASE_URL: "http://localhost:11434/v1", LLM_MODEL: "openai:qwen3:14b", LLM_MODEL_BUILDER: "claude-opus-5-5" });
    expect(() => parseServerEnv({ ...valid(), LLM_MODEL_WRITING: "qwen3:14b" })).toThrow(/LLM_MODEL_WRITING: a Claude model id or openai:<model>/);
    expect(() => parseServerEnv({ ...valid(), OPENAI_BASE_URL: "localhost:11434" })).toThrow(/OPENAI_BASE_URL/);
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
