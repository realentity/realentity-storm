import { SealKeys, sealIntegration } from "@realentity/storm-crypto";
import { Integrations } from "@realentity/storm-db";
import { type GoogleClientRequest, type GoogleClientView } from "@realentity/storm-shared";
import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { hintOf } from "../integrations/integrations.service";

/**
 * M63: Google's OAuth client (a Web application client of your Google Cloud project), set up in Settings → Google
 * instead of .env: its secret sealed with the integration key, never returned. Saving it asks for the authenticator
 * code again. The api opens it to exchange a sign-in's code; the worker, to refresh the accounts' access.
 */
@Injectable()
export class GoogleClientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: SealKeys,
    private readonly integrations: Integrations,
    private readonly auth: AuthService,
  ) {}

  async get(userId: string): Promise<GoogleClientView> {
    return view(await this.row(userId));
  }

  async save(userId: string, body: GoogleClientRequest): Promise<GoogleClientView> {
    this.auth.checkCode(body.code);
    const existing = await this.row(userId);
    if (!existing && !body.clientSecret) throw new BadRequestException("The client secret is needed to set it up");
    const integrationId = existing?.integrationId ?? randomUUID();
    const data = {
      config: { clientId: body.clientId },
      ...(body.clientSecret ? { ...sealIntegration(this.keys, integrationId, body.clientSecret), secretHint: hintOf(body.clientSecret) } : {}),
    };
    const row = existing
      ? await this.prisma.client.integration.update({ where: { integrationId }, data })
      : await this.prisma.client.integration.create({ data: { integrationId, userId, kind: "GOOGLE_OAUTH", name: "Google", ...data } });
    this.integrations.forget(userId);
    return view(row);
  }

  /** The accounts stay: connecting them again needs a client. */
  async remove(userId: string): Promise<void> {
    await this.prisma.client.integration.deleteMany({ where: { userId, kind: "GOOGLE_OAUTH" } });
    this.integrations.forget(userId);
  }

  private row(userId: string) {
    return this.prisma.client.integration.findFirst({ where: { userId, kind: "GOOGLE_OAUTH" } });
  }
}

function view(row: { config: unknown; secretHint: string | null; ciphertext: unknown } | null): GoogleClientView {
  const clientId = (row?.config as { clientId?: string } | undefined)?.clientId ?? null;
  return { configured: Boolean(row?.ciphertext && clientId), clientId, secretHint: row?.secretHint ?? null };
}
