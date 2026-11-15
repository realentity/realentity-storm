import { type PrismaClient } from "./generated/prisma/client";

/** The email account an email goes out from. */
export interface EmailSender {
  emailAccountId: string;
  address: string;
  label: string | null;
}

/** An email.send waiting to go: its pipeline (for its slots) and its payload (its `account`). */
export interface EmailToSend {
  key: string;
  pipelineId: string;
  /** The pipeline version's definition: its App (`app`, `refs.appId`), for the App's slots. */
  definition: unknown;
  payload: Record<string, unknown>;
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whom each email goes out from, picked as the worker sends it (mailWho, then the mail connector): the account the
 * payload's `account` names by id, or the one bound to the slot it names (the pipeline's own over its App's), else the
 * default (the one marked, else the oldest). An id or slot whose account is gone, or no account at all: null, as the
 * send would fail. By `key`.
 */
export async function emailSenders(
  prisma: PrismaClient,
  userId: string,
  emails: readonly EmailToSend[],
): Promise<Map<string, EmailSender | null>> {
  const senders = new Map<string, EmailSender | null>();
  if (emails.length === 0) return senders;
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { dateCreated: "asc" }],
    select: { emailAccountId: true, address: true, label: true },
  });
  const byId = new Map(accounts.map((a) => [a.emailAccountId, a]));
  const slotsOf = new Map<string, Record<string, string>>();
  for (const email of emails) {
    const named = email.payload.account;
    let id: string | null = null;
    if (typeof named === "string" && named) {
      if (ACCOUNT_ID.test(named)) id = named;
      else {
        if (!slotsOf.has(email.pipelineId))
          slotsOf.set(email.pipelineId, await emailSlots(prisma, userId, email.pipelineId, email.definition));
        id = slotsOf.get(email.pipelineId)![named] ?? null;
      }
    }
    const account = id ? byId.get(id) : accounts[0];
    senders.set(email.key, account ? { emailAccountId: account.emailAccountId, address: account.address, label: account.label } : null);
  }
  return senders;
}

/** A pipeline's email slots and their accounts: its App's bindings, then its own over them (the worker's loadBindings). */
async function emailSlots(prisma: PrismaClient, userId: string, pipelineId: string, definition: unknown): Promise<Record<string, string>> {
  const { app, refs } = (definition ?? {}) as { app?: string; refs?: { appId?: string } };
  const appId =
    refs?.appId ??
    (app ? (await prisma.app.findUnique({ where: { userId_name: { userId, name: app } }, select: { appId: true } }))?.appId : undefined);
  const rows = await prisma.binding.findMany({
    where: { emailAccountId: { not: null }, OR: [{ pipelineId }, ...(appId ? [{ appId }] : [])] },
    select: { slot: true, emailAccountId: true, pipelineId: true },
  });
  const slots: Record<string, string> = {};
  for (const row of [...rows.filter((r) => !r.pipelineId), ...rows.filter((r) => r.pipelineId)]) slots[row.slot] = row.emailAccountId!;
  return slots;
}

/** The type of a step in a definition, by its id. */
export function stepTypeIn(definition: unknown, stepKey: string): string | null {
  return (definition as { steps?: { id: string; type: string }[] } | null)?.steps?.find((s) => s.id === stepKey)?.type ?? null;
}
