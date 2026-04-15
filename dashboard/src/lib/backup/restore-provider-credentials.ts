import "server-only";
import type {
  ProviderCredentialsBackupEnvelope,
  RestoreProviderCredentialsResult,
} from "@/lib/backup/types";
import { BACKUP_TYPE, BACKUP_VERSION } from "@/lib/backup/types";
import { prisma } from "@/lib/db";
import { getUserIdMapByUsername } from "@/lib/backup/user-mapping";

export async function restoreProviderCredentialsBackup(
  backup: ProviderCredentialsBackupEnvelope
): Promise<RestoreProviderCredentialsResult> {
  const referencedUsernames = [
    ...backup.payload.providerKeys.map((item) => item.username),
    ...backup.payload.providerOAuth.map((item) => item.username),
  ];
  const userIdMap = await getUserIdMapByUsername(referencedUsernames);

  let createdProviderKeys = 0;
  let updatedProviderKeys = 0;
  let skippedProviderKeys = 0;
  let failedProviderKeys = 0;

  for (const item of backup.payload.providerKeys) {
    const userId = userIdMap.get(item.username);
    if (!userId) {
      failedProviderKeys += 1;
      continue;
    }

    try {
      const existing = await prisma.providerKeyOwnership.findUnique({
        where: { keyHash: item.keyHash },
      });

      if (!existing) {
        await prisma.providerKeyOwnership.create({
          data: {
            userId,
            provider: item.provider,
            keyIdentifier: item.keyIdentifier,
            name: item.name,
            keyHash: item.keyHash,
          },
        });
        createdProviderKeys += 1;
        continue;
      }

      if (existing.userId !== userId) {
        skippedProviderKeys += 1;
        continue;
      }

      const needsUpdate =
        existing.provider !== item.provider ||
        existing.keyIdentifier !== item.keyIdentifier ||
        existing.name !== item.name;

      if (!needsUpdate) {
        skippedProviderKeys += 1;
        continue;
      }

      await prisma.providerKeyOwnership.update({
        where: { id: existing.id },
        data: {
          provider: item.provider,
          keyIdentifier: item.keyIdentifier,
          name: item.name,
        },
      });
      updatedProviderKeys += 1;
    } catch {
      failedProviderKeys += 1;
    }
  }

  let createdProviderOAuth = 0;
  let updatedProviderOAuth = 0;
  let skippedProviderOAuth = 0;
  let failedProviderOAuth = 0;

  for (const item of backup.payload.providerOAuth) {
    const userId = userIdMap.get(item.username);
    if (!userId) {
      failedProviderOAuth += 1;
      continue;
    }

    try {
      const existing = await prisma.providerOAuthOwnership.findUnique({
        where: { accountName: item.accountName },
      });

      if (!existing) {
        await prisma.providerOAuthOwnership.create({
          data: {
            userId,
            provider: item.provider,
            accountName: item.accountName,
            accountEmail: item.accountEmail,
          },
        });
        createdProviderOAuth += 1;
        continue;
      }

      if (existing.userId !== userId) {
        skippedProviderOAuth += 1;
        continue;
      }

      const needsUpdate =
        existing.provider !== item.provider || existing.accountEmail !== item.accountEmail;

      if (!needsUpdate) {
        skippedProviderOAuth += 1;
        continue;
      }

      await prisma.providerOAuthOwnership.update({
        where: { id: existing.id },
        data: {
          provider: item.provider,
          accountEmail: item.accountEmail,
        },
      });
      updatedProviderOAuth += 1;
    } catch {
      failedProviderOAuth += 1;
    }
  }

  return {
    type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
    version: BACKUP_VERSION,
    summary: {
      providerKeys: {
        created: createdProviderKeys,
        updated: updatedProviderKeys,
        skipped: skippedProviderKeys,
        failed: failedProviderKeys,
      },
      providerOAuth: {
        created: createdProviderOAuth,
        updated: updatedProviderOAuth,
        skipped: skippedProviderOAuth,
        failed: failedProviderOAuth,
      },
    },
  };
}
