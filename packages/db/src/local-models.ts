import { type PrismaClient } from "./generated/prisma/client";

/**
 * M60: whether the user's local models are on (switched on in Settings, and a server set up: `available`), and the
 * local model of every task without its own choice. The model router passes over local models while they are off.
 */
export async function localModelsOf(prisma: PrismaClient, userId: string, available: boolean): Promise<{ on: boolean; model: string | null }> {
  if (!available) return { on: false, model: null };
  const setting = await prisma.userSetting.findUnique({ where: { userId }, select: { localModels: true, localModel: true } });
  return { on: setting?.localModels ?? false, model: setting?.localModel ?? null };
}
