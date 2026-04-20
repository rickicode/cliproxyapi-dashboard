import "server-only";
import type {
  ProviderCredentialsBackupEnvelope,
  RestoreProviderCredentialsResult,
  UniversalCredentialEntry,
} from "@/lib/backup/types";
import { BACKUP_TYPE, BACKUP_VERSION } from "@/lib/backup/types";
import { MANAGEMENT_API_KEY, MANAGEMENT_BASE_URL, fetchWithTimeout } from "@/lib/providers/management-api";

class RestoreCredentialPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreCredentialPayloadError";
  }
}

function assertCredentialTokens(entry: UniversalCredentialEntry): void {
  if (!entry.accessToken || !entry.refreshToken) {
    throw new RestoreCredentialPayloadError(
      `Universal credential entry ${entry.id} is missing accessToken or refreshToken`
    );
  }
}

function buildCredentialPayload(entry: UniversalCredentialEntry): Record<string, unknown> {
  assertCredentialTokens(entry);

  return {
    type: entry.authType,
    id: entry.id,
    provider: entry.provider,
    name: entry.name,
    priority: entry.priority,
    is_active: entry.isActive,
    access_token: entry.accessToken,
    refresh_token: entry.refreshToken,
    id_token: entry.idToken,
    expires_at: entry.expiresAt,
    expires_in: entry.expiresIn,
  };
}

async function restoreUniversalCredential(entry: UniversalCredentialEntry): Promise<boolean> {
  if (!MANAGEMENT_API_KEY) {
    return false;
  }

  const endpoint = `${MANAGEMENT_BASE_URL}/auth-files?name=${encodeURIComponent(entry.name)}&provider=${encodeURIComponent(entry.provider)}`;

  try {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MANAGEMENT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildCredentialPayload(entry)),
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function restoreProviderCredentialsBackup(
  backup: ProviderCredentialsBackupEnvelope
): Promise<RestoreProviderCredentialsResult> {
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of backup.entries) {
    if (entry.authType !== "oauth") {
      skipped += 1;
      continue;
    }

    if (!entry.accessToken || !entry.refreshToken) {
      failed += 1;
      continue;
    }

    try {
      const ok = await restoreUniversalCredential(entry);
      if (ok) {
        restored += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
    version: BACKUP_VERSION,
    summary: {
      entries: {
        restored,
        skipped,
        failed,
      },
    },
  };
}
