import "server-only";
import { prisma } from "@/lib/db";
import {
  BACKUP_SOURCE_APP,
  BACKUP_FORMAT,
  BACKUP_TYPE,
  BACKUP_VERSION,
  type ProviderCredentialsBackupEnvelope,
} from "@/lib/backup/types";
import { MANAGEMENT_BASE_URL, MANAGEMENT_API_KEY, fetchWithTimeout } from "@/lib/providers/management-api";
import { logger } from "@/lib/logger";

class BackupCredentialDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCredentialDownloadError";
  }
}

async function fetchOAuthCredentialContent(accountName: string): Promise<Record<string, unknown>> {
  if (!MANAGEMENT_API_KEY) {
    throw new BackupCredentialDownloadError("Management API key is not configured");
  }

  const endpoint = `${MANAGEMENT_BASE_URL}/auth-files/download?name=${encodeURIComponent(accountName)}`;
  const response = await fetchWithTimeout(endpoint, {
    headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
  });

  if (!response.ok) {
    throw new BackupCredentialDownloadError(
      `Failed to download OAuth credential for ${accountName}: HTTP ${response.status}`
    );
  }

  const rawContent = await response.text();
  if (!rawContent.trim()) {
    throw new BackupCredentialDownloadError(`OAuth credential for ${accountName} is empty`);
  }

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(rawContent);
  } catch {
    throw new BackupCredentialDownloadError(`OAuth credential for ${accountName} is not valid JSON`);
  }

  if (!parsedContent || typeof parsedContent !== "object" || Array.isArray(parsedContent)) {
    throw new BackupCredentialDownloadError(`OAuth credential for ${accountName} must be a JSON object`);
  }

  return parsedContent as Record<string, unknown>;
}

export async function exportProviderCredentialsBackup(): Promise<ProviderCredentialsBackupEnvelope> {
  const providerOAuth = await prisma.providerOAuthOwnership.findMany({
    select: {
      provider: true,
      accountName: true,
      user: { select: { username: true } },
    },
    orderBy: [{ user: { username: "asc" } }, { provider: "asc" }, { accountName: "asc" }],
  });

  const entries: ProviderCredentialsBackupEnvelope["payload"]["entries"] = [];

  for (const [index, item] of providerOAuth.entries()) {
    try {
      const content = await fetchOAuthCredentialContent(item.accountName);

      const accessToken = typeof content.access_token === "string" ? content.access_token : null;
      const refreshToken = typeof content.refresh_token === "string" ? content.refresh_token : null;

      if (!accessToken || !refreshToken) {
        logger.warn(
          { accountName: item.accountName, provider: item.provider },
          "Skipping OAuth credential without access_token or refresh_token"
        );
        continue;
      }

      entries.push({
        id: `${item.provider}:${item.accountName}:${index + 1}`,
        provider: item.provider,
        authType: "oauth",
        name: item.accountName,
        priority: index + 1,
        isActive: true,
        accessToken,
        refreshToken,
        idToken: typeof content.id_token === "string" ? content.id_token : null,
        expiresAt: typeof content.expires_at === "string" ? content.expires_at : null,
        expiresIn: typeof content.expires_in === "number" ? content.expires_in : null,
      });
    } catch (error) {
      logger.warn(
        { err: error, accountName: item.accountName, provider: item.provider },
        "Skipping OAuth credential during backup export"
      );
      continue;
    }
  }

  return {
    type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceApp: BACKUP_SOURCE_APP,
    payload: {
      format: BACKUP_FORMAT.UNIVERSAL_CREDENTIALS,
      exportedAt: new Date().toISOString(),
      entries,
    },
  };
}
