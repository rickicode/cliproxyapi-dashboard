import "server-only";
import type {
  ProviderCredentialsBackupEnvelope,
  RestoreProviderCredentialsResult,
} from "@/lib/backup/types";
import { BACKUP_TYPE, BACKUP_VERSION } from "@/lib/backup/types";
import { prisma } from "@/lib/db";
import { getUserIdMapByUsername } from "@/lib/backup/user-mapping";

const OAUTH_PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "claude",
  claude: "claude",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  openai: "codex",
  codex: "codex",
  github: "copilot",
  "github-copilot": "copilot",
  copilot: "copilot",
  antigravity: "antigravity",
  iflow: "iflow",
  qwen: "qwen",
  kimi: "kimi",
  kiro: "kiro",
  cursor: "cursor",
  codebuddy: "codebuddy",
};

function normalizeOAuthProviderAlias(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return OAUTH_PROVIDER_ALIASES[normalized] ?? normalized;
}

function normalizeOAuthAccountEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") {
    return null;
  }

  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

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

    const normalizedProvider = normalizeOAuthProviderAlias(item.provider);
    const normalizedAccountEmail = normalizeOAuthAccountEmail(item.accountEmail);

    try {
      const existing = await prisma.providerOAuthOwnership.findUnique({
        where: {
          provider_accountName: {
            provider: normalizedProvider,
            accountName: item.accountName,
          },
        },
      });

      if (!existing) {
        await prisma.providerOAuthOwnership.create({
          data: {
            userId,
            provider: normalizedProvider,
            accountName: item.accountName,
            accountEmail: normalizedAccountEmail,
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
        existing.provider !== normalizedProvider || existing.accountEmail !== normalizedAccountEmail;

      if (!needsUpdate) {
        skippedProviderOAuth += 1;
        continue;
      }

      await prisma.providerOAuthOwnership.update({
        where: { id: existing.id },
        data: {
          provider: normalizedProvider,
          accountEmail: normalizedAccountEmail,
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
