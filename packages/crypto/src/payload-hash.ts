import { canonicalJson } from "@ai-me/shared";
import { createHash } from "node:crypto";

/** SHA-256 (hex) of a payload's canonical JSON: what I approved is exactly what the worker may execute. */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}
