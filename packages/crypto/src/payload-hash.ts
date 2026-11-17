import { canonicalJson } from "@realentity/storm-shared";
import { createHash } from "node:crypto";

/** SHA-256 (hex) of a payload's canonical JSON: what the user approved is exactly what the worker may execute. */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** M53: a batch of proposals as Telegram's Approve all carries it: the start of a hash of their ids, in any order. */
export function batchHash(proposalIds: readonly string[]): string {
  return createHash("sha256")
    .update([...proposalIds].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}
