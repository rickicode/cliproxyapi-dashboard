import "server-only";
import { prisma } from "@/lib/db";
import {
  BACKUP_SOURCE_APP,
  BACKUP_TYPE,
  BACKUP_VERSION,
  type ProviderCredentialsBackupEnvelope,
} from "@/lib/backup/types";

export async function exportProviderCredentialsBackup(): Promise<ProviderCredentialsBackupEnvelope> {
  const [providerKeys, providerOAuth] = await Promise.all([
    prisma.providerKeyOwnership.findMany({
      select: {
        provider: true,
        keyIdentifier: true,
        name: true,
        keyHash: true,
        user: { select: { username: true } },
      },
      orderBy: [{ user: { username: "asc" } }, { provider: "asc" }, { keyIdentifier: "asc" }],
    }),
    prisma.providerOAuthOwnership.findMany({
      select: {
        provider: true,
        accountName: true,
        accountEmail: true,
        user: { select: { username: true } },
      },
      orderBy: [{ user: { username: "asc" } }, { provider: "asc" }, { accountName: "asc" }],
    }),
  ]);

  return {
    type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceApp: BACKUP_SOURCE_APP,
    payload: {
      providerKeys: providerKeys.map((item) => ({
        username: item.user.username,
        provider: item.provider,
        keyIdentifier: item.keyIdentifier,
        name: item.name,
        keyHash: item.keyHash,
      })),
      providerOAuth: providerOAuth.map((item) => ({
        username: item.user.username,
        provider: item.provider,
        accountName: item.accountName,
        accountEmail: item.accountEmail,
      })),
    },
  };
}
