import "server-only";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { type OAuthProvider } from "./constants";
import { invalidateUsageCaches, invalidateProxyModelsCache } from "@/lib/cache";
import {
  fetchWithTimeout,
  MANAGEMENT_BASE_URL,
  MANAGEMENT_API_KEY,
  FETCH_TIMEOUT_MS,
  isRecord,
  type ContributeOAuthResult,
  type RemoveOAuthResult,
  type ListOAuthResult,
  type ImportOAuthResult,
  type ToggleOAuthResult,
  type OAuthAccountWithOwnership,
} from "./management-api";
import { type OAuthListItem, type OAuthListQuery, buildOAuthListResponse } from "./oauth-listing";
import type { CodexBulkCredentialInput } from "@/lib/validation/schemas";
import { inferOAuthProviderFromIdentifiers, isMeaningfulProviderValue } from "./provider-inference";
import { resolveOAuthOwnership } from "./oauth-ownership-resolver";
import { parseAuthFilesResponse } from "./auth-files";

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

export interface BulkImportOAuthCredentialItemResult {
  email: string;
  ok: boolean;
  id?: string;
  accountName?: string;
  error?: string;
}

export interface BulkImportOAuthCredentialResult {
  results: BulkImportOAuthCredentialItemResult[];
  summary: {
    total: number;
    successCount: number;
    failureCount: number;
  };
}

export interface BulkOAuthActionFailure {
  actionKey: string;
  reason: string;
}

export interface BulkOAuthActionSummary {
  total: number;
  successCount: number;
  failureCount: number;
}

export interface BulkUpdateOAuthAccountsInput {
  action: "enable" | "disable" | "disconnect";
  actionKeys: string[];
}

export interface BulkUpdateOAuthAccountsResult {
  ok: boolean;
  error?: string;
  summary: BulkOAuthActionSummary;
  failures: BulkOAuthActionFailure[];
}

interface AuthFilePollEntry {
  name: string;
  provider?: string;
  type?: string;
  email?: string;
}

interface AuthFilePollSnapshot {
  files: AuthFilePollEntry[];
  hasMalformedEntries: boolean;
}

interface OAuthListAuthFileEntry {
  id: string;
  name: string;
  provider?: string;
  type?: string;
  email?: string;
  status?: string;
  status_message?: string;
  unavailable?: boolean;
}

function normalizeOAuthProviderAlias(provider: string | undefined): string | null {
  if (typeof provider !== "string") {
    return null;
  }

  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return OAUTH_PROVIDER_ALIASES[normalized] ?? normalized;
}

function buildAuthFileScopeKey(file: AuthFilePollEntry, fallbackProvider?: string): string {
  const normalizedProvider = normalizeOAuthProviderAlias(file.provider)
    ?? normalizeOAuthProviderAlias(file.type)
    ?? normalizeOAuthProviderAlias(
      inferOAuthProviderFromIdentifiers(undefined, file.name, file.email)
        ?? fallbackProvider
    )
    ?? "";

  return `${normalizedProvider}:${file.name}`;
}

const sanitizeAuthFilePollEntry = (entry: unknown): AuthFilePollEntry | null => {
  if (!isRecord(entry) || typeof entry.name !== "string") return null;

  if (entry.provider !== undefined && typeof entry.provider !== "string") return null;
  if (entry.type !== undefined && typeof entry.type !== "string") return null;
  if (entry.email !== undefined && typeof entry.email !== "string") return null;

  const sanitized: AuthFilePollEntry = { name: entry.name };

  if (typeof entry.provider === "string") {
    sanitized.provider = entry.provider;
  }

  if (typeof entry.type === "string") {
    sanitized.type = entry.type;
  }

  if (typeof entry.email === "string") {
    sanitized.email = entry.email;
  }

  return sanitized;
};

const sanitizeOAuthListAuthFileEntry = (entry: unknown): OAuthListAuthFileEntry | null => {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") {
    return null;
  }

  if (entry.provider !== undefined && typeof entry.provider !== "string") return null;
  if (entry.type !== undefined && typeof entry.type !== "string") return null;
  if (entry.email !== undefined && typeof entry.email !== "string") return null;
  if (entry.status !== undefined && typeof entry.status !== "string") return null;
  if (entry.status_message !== undefined && typeof entry.status_message !== "string") return null;
  if (entry.unavailable !== undefined && typeof entry.unavailable !== "boolean") return null;

  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    type: entry.type,
    email: entry.email,
    status: entry.status,
    status_message: entry.status_message,
    unavailable: entry.unavailable,
  };
};

const parseAuthFilePollSnapshot = (data: unknown): AuthFilePollSnapshot | null => {
  const hasSupportedShape = Array.isArray(data)
    || (isRecord(data) && (Array.isArray(data.files) || Array.isArray(data.auth_files)));

  if (!hasSupportedShape) {
    return null;
  }

  let hasMalformedEntries = false;
  const rawFiles = parseAuthFilesResponse<Record<string, unknown>>(data);
  if (!rawFiles) {
    return { files: [], hasMalformedEntries: true };
  }

  const files = rawFiles.flatMap((entry) => {
    const sanitized = sanitizeAuthFilePollEntry(entry);
    if (!sanitized) {
      hasMalformedEntries = true;
    }
    return sanitized ? [sanitized] : [];
  });

  return { files, hasMalformedEntries };
};

export function summarizeBulkOAuthAction(
  actionKeys: string[],
  failures: BulkOAuthActionFailure[]
): BulkOAuthActionSummary {
  return {
    total: actionKeys.length,
    successCount: actionKeys.length - failures.length,
    failureCount: failures.length,
  };
}

function buildOAuthActionKey(provider: string, accountName: string): string {
  return `oauth:${encodeURIComponent(provider)}:${encodeURIComponent(accountName)}`;
}

function buildOAuthRowKey(provider: string, accountName: string, id: string): string {
  return `oauth-row:${encodeURIComponent(provider)}:${encodeURIComponent(accountName)}:${encodeURIComponent(id)}`;
}

function buildScopedOAuthActionKey(provider: string, accountName: string, id: string): string {
  return `${buildOAuthActionKey(provider, accountName)}:${encodeURIComponent(id)}`;
}

interface OAuthActionTarget {
  idOrName: string;
  provider?: string;
  accountName?: string;
}

function canonicalizeOAuthProvider(provider: string | undefined): string | undefined {
  return normalizeOAuthProviderAlias(provider) ?? undefined;
}

function resolveOAuthActionTarget(actionKey: string): OAuthActionTarget {
  if (!actionKey.startsWith("oauth:")) {
    return { idOrName: actionKey };
  }

  const segments = actionKey.split(":");
  if (segments.length < 4) {
    return { idOrName: actionKey };
  }

  try {
    return {
      provider: canonicalizeOAuthProvider(decodeURIComponent(segments[1] ?? "")),
      accountName: decodeURIComponent(segments[2] ?? ""),
      idOrName: decodeURIComponent(segments.slice(3).join(":")),
    };
  } catch {
    return { idOrName: actionKey };
  }
}

function buildOAuthManagementQuery(target: OAuthActionTarget, fallbackAccountName: string): string {
  const params = new URLSearchParams();
  params.set("name", target.accountName ?? fallbackAccountName);

  const canonicalProvider = canonicalizeOAuthProvider(target.provider);
  if (canonicalProvider) {
    params.set("provider", canonicalProvider);
  }

  return params.toString();
}

export async function listOAuthAccounts(userId: string, isAdmin: boolean, query: OAuthListQuery) {
  const result = await listOAuthWithOwnership(userId, isAdmin);

  if (!result.ok || !result.accounts) {
    return { ok: false as const, error: result.error ?? "Failed to list OAuth accounts" };
  }

  const rows: OAuthListItem[] = result.accounts.map((row) => ({
    ...row,
    rowKey: buildOAuthRowKey(row.provider, row.accountName, row.id),
    actionKey: row.isOwn || isAdmin ? buildScopedOAuthActionKey(row.provider, row.accountName, row.id) : "",
    canToggle: row.isOwn || isAdmin,
    canDelete: row.isOwn || isAdmin,
    canClaim: Boolean(isAdmin && !row.ownerUserId && row.accountName && (row.isOwn || isAdmin)),
  }));

  return { ok: true as const, data: buildOAuthListResponse(rows, query) };
}

export async function bulkUpdateOAuthAccounts(
  userId: string,
  isAdmin: boolean,
  input: BulkUpdateOAuthAccountsInput
): Promise<BulkUpdateOAuthAccountsResult> {
  const failures: BulkOAuthActionFailure[] = [];

  for (const actionKey of input.actionKeys) {
    if (!actionKey) {
      failures.push({
        actionKey,
        reason: "Missing action key",
      });
      continue;
    }

    const actionTarget = resolveOAuthActionTarget(actionKey);

    let result:
      | RemoveOAuthResult
      | ToggleOAuthResult;

    if (input.action === "disconnect") {
      result = await removeOAuthAccountByIdOrName(userId, actionTarget.idOrName, isAdmin, actionTarget);
    } else {
      result = await toggleOAuthAccountByIdOrName(
        userId,
        actionTarget.idOrName,
        input.action === "disable",
        isAdmin,
        actionTarget
      );
    }

    if (!result.ok) {
      failures.push({
        actionKey,
        reason: result.error ?? "Operation failed",
      });
    }
  }

  return {
    ok: true,
    summary: summarizeBulkOAuthAction(input.actionKeys, failures),
    failures,
  };
}

export function buildCodexBulkImportFileName(email: string): string {
  const safeEmail = Array.from(email.trim())
    .map((char) => /[A-Za-z0-9@._+-]/.test(char) ? char : encodeURIComponent(char))
    .join("");
  return `codex_${safeEmail}.json`;
}

export function buildCodexBulkImportFileContent(credential: CodexBulkCredentialInput): string {
  const { email, ...payload } = credential;
  return JSON.stringify({
    type: "codex",
    email,
    ...payload,
  });
}

export async function contributeOAuthAccount(
  userId: string,
  provider: OAuthProvider,
  accountName: string,
  accountEmail?: string
): Promise<ContributeOAuthResult> {
  try {
    const resolution = await resolveOAuthOwnership({
      currentUserId: userId,
      provider,
      accountName,
      accountEmail: accountEmail ?? null,
    });

    if (resolution.kind === "error") {
      return { ok: false, error: resolution.failure.message };
    }

    if (resolution.kind === "claimed_by_other_user") {
      return { ok: false, error: "OAuth account already registered to another user" };
    }

    if (resolution.kind === "ambiguous") {
      return { ok: false, error: "OAuth account requires manual review before it can be registered" };
    }

    return { ok: true, id: resolution.ownership.id, resolution: resolution.kind };
  } catch (error) {
    logger.error({ err: error, provider }, "contributeOAuthAccount error");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during OAuth registration",
    };
  }
}

export async function importOAuthCredential(
  userId: string,
  provider: string,
  fileName: string,
  fileContent: string
): Promise<ImportOAuthResult> {
  if (!MANAGEMENT_API_KEY) {
    return { ok: false, error: "Management API key not configured" };
  }

  try {
    const cleanupUploadedAuthFile = async (accountName: string): Promise<void> => {
      const deleteEndpoint = `${MANAGEMENT_BASE_URL}/auth-files?name=${encodeURIComponent(accountName)}&provider=${encodeURIComponent(provider)}`;

      try {
        const deleteRes = await fetchWithTimeout(deleteEndpoint, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
        });

        if (!deleteRes.ok) {
          await deleteRes.body?.cancel();
          logger.warn(
            { provider, accountName, status: deleteRes.status },
            "importOAuthCredential: failed to roll back uploaded auth file"
          );
        }
      } catch (cleanupError) {
        if (cleanupError instanceof Error && cleanupError.name === "AbortError") {
          logger.error({
            err: cleanupError,
            endpoint: deleteEndpoint,
            accountName,
            timeoutMs: FETCH_TIMEOUT_MS,
          }, "Fetch timeout - importOAuthCredential cleanup DELETE");
          return;
        }

        logger.error(
          { err: cleanupError, provider, accountName },
          "importOAuthCredential: cleanup threw while rolling back uploaded auth file"
        );
      }
    };

    // Validate JSON content
    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(fileContent);
    } catch {
      return { ok: false, error: "Invalid JSON content" };
    }

    if (!parsedContent || typeof parsedContent !== "object" || Array.isArray(parsedContent)) {
      return { ok: false, error: "Credential file must contain a JSON object, not an array" };
    }

    // Build multipart form data to upload to CLIProxyAPIPlus
    const blob = new Blob([fileContent], { type: "application/json" });
    const formData = new FormData();
    formData.append("file", blob, fileName);

    const endpoint = `${MANAGEMENT_BASE_URL}/auth-files`;

    // Snapshot existing auth file names before upload to diff later
    const preExistingNames = new Set<string>();
    let preUploadSnapshotSucceeded = false;
    try {
      const snapshotRes = await fetchWithTimeout(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
      });
      if (snapshotRes.ok) {
        const snapshotData = await snapshotRes.json();
        const snapshot = parseAuthFilePollSnapshot(snapshotData);
        if (snapshot) {
          preUploadSnapshotSucceeded = true;
          for (const file of snapshot.files) {
            preExistingNames.add(buildAuthFileScopeKey(file, provider));
          }
        }
      } else {
        await snapshotRes.body?.cancel();
      }
    } catch {
      // Non-fatal: we'll fall back to name-based matching if snapshot fails
    }
    let uploadRes: Response;
    try {
      uploadRes = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
        body: formData,
      });
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        logger.error({
          err: fetchError,
          endpoint,
          provider,
          timeoutMs: FETCH_TIMEOUT_MS,
        }, "Fetch timeout - importOAuthCredential POST");
        return { ok: false, error: "Request timeout uploading credential file" };
      }
      throw fetchError;
    }

    if (!uploadRes.ok) {
      const errorText = await uploadRes.text().catch(() => "");
      await uploadRes.body?.cancel();
      logger.warn(
        { provider, status: uploadRes.status, errorText },
        "importOAuthCredential: upload failed"
      );
      if (uploadRes.status === 409) {
        return { ok: false, error: "Credential file already exists" };
      }
      return { ok: false, error: `Failed to upload credential file: HTTP ${uploadRes.status}${errorText ? ` - ${errorText}` : ""}` };
    }

    // Poll auth-files to find the newly created file and claim ownership
    const MAX_RETRIES = 8;
    const RETRY_DELAY_MS = 1500;
    let claimedAccountName: string | null = null;
    let claimedEmail: string | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      let getRes: Response;
      try {
        getRes = await fetchWithTimeout(`${endpoint}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
        });
      } catch {
        continue;
      }

      if (!getRes.ok) {
        await getRes.body?.cancel();
        continue;
      }

      const getData = await getRes.json();
      const pollSnapshot = parseAuthFilePollSnapshot(getData);
      if (!pollSnapshot) {
        continue;
      }

      const { files, hasMalformedEntries } = pollSnapshot;

      // Only consider files that did NOT exist before our upload
      const newFiles = files.filter((file) => !preExistingNames.has(buildAuthFileScopeKey(file, provider)));

      const requestedBaseName = fileName.replace(/\.json$/i, "");

      // Primary: exact filename match wins; otherwise only accept a single fuzzy basename match.
      const exactMatch = newFiles.find((file) => file.name === fileName) ?? null;
      const fuzzyMatches = exactMatch
        ? []
        : newFiles.filter((file) => file.name.includes(requestedBaseName));
      const matchingFile = exactMatch || (fuzzyMatches.length === 1 ? fuzzyMatches[0] : null);

      // Fallback: if snapshot was available and there's exactly one new file
      // matching the provider, use it (refuse if ambiguous)
      let fallbackFile: (typeof newFiles)[number] | null = null;
      if (!matchingFile && preUploadSnapshotSucceeded && !hasMalformedEntries) {
        const providerMatches = newFiles.filter((file) => {
          const fileProvider = canonicalizeOAuthProvider(
            isMeaningfulProviderValue(file.provider)
              ? file.provider
              : isMeaningfulProviderValue(file.type)
                ? file.type
                : undefined
          );

          return fileProvider === canonicalizeOAuthProvider(provider);
        });
        if (providerMatches.length === 1) {
          fallbackFile = providerMatches[0];
        }
      } else if (!matchingFile && hasMalformedEntries) {
        logger.warn(
          { provider, fileName },
          "importOAuthCredential: skipping heuristic fallback due to malformed auth-file entries"
        );
      }

      const resolvedFile = matchingFile || fallbackFile;

      if (resolvedFile) {
        claimedAccountName = resolvedFile.name;
        claimedEmail = resolvedFile.email || null;
        break;
      }
    }

    if (!claimedAccountName) {
      logger.warn(
        { provider, fileName },
        "importOAuthCredential: uploaded but could not find file to claim ownership"
      );
      return {
        ok: false,
        error: "Credential upload succeeded but ownership could not be verified; manual review required",
      };
    }

    const resolution = await resolveOAuthOwnership({
      currentUserId: userId,
      provider,
      accountName: claimedAccountName,
      accountEmail: claimedEmail,
    });

    if (resolution.kind === "error") {
      await cleanupUploadedAuthFile(claimedAccountName);
      return { ok: false, error: resolution.failure.message };
    }

    if (resolution.kind === "claimed_by_other_user") {
      await cleanupUploadedAuthFile(claimedAccountName);
      return { ok: false, error: "Credential already imported and claimed by another user" };
    }

    if (resolution.kind === "ambiguous") {
      await cleanupUploadedAuthFile(claimedAccountName);
      return {
        ok: false,
        error: "Credential import requires manual review before ownership can be assigned",
      };
    }

    invalidateUsageCaches();
    invalidateProxyModelsCache();
    return {
      ok: true,
      id: resolution.ownership.id,
      accountName: claimedAccountName,
      resolution: resolution.kind,
    };
  } catch (error) {
    logger.error({ err: error, provider, fileName }, "importOAuthCredential error");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during credential import",
    };
  }
}

export async function importBulkCodexOAuthCredentials(
  userId: string,
  credentials: CodexBulkCredentialInput[]
): Promise<BulkImportOAuthCredentialResult> {
  const results: BulkImportOAuthCredentialItemResult[] = [];

  for (const credential of credentials) {
    const { email } = credential;
    const fileName = buildCodexBulkImportFileName(email);
    const result = await importOAuthCredential(
      userId,
      "codex",
      fileName,
      buildCodexBulkImportFileContent(credential)
    );

    results.push({
      email,
      ok: result.ok,
      id: result.id,
      accountName: result.accountName,
      error: result.error,
    });
  }

  const successCount = results.filter((result) => result.ok).length;

  return {
    results,
    summary: {
      total: results.length,
      successCount,
      failureCount: results.length - successCount,
    },
  };
}

export async function listOAuthWithOwnership(
  userId: string,
  isAdmin: boolean = false
): Promise<ListOAuthResult> {
  if (!MANAGEMENT_API_KEY) {
    return { ok: false, error: "Management API key not configured" };
  }

   try {
     const endpoint = `${MANAGEMENT_BASE_URL}/auth-files`;

     let getRes: Response;
     try {
       getRes = await fetchWithTimeout(endpoint, {
         method: "GET",
         headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
       });
} catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          logger.error({
            err: fetchError,
            endpoint,
            timeoutMs: FETCH_TIMEOUT_MS,
          }, "Fetch timeout - listOAuthWithOwnership GET");
         return { ok: false, error: "Request timeout fetching OAuth accounts" };
       }
       throw fetchError;
     }

      if (!getRes.ok) {
        await getRes.body?.cancel();
        return { ok: false, error: `Failed to fetch OAuth accounts: HTTP ${getRes.status}` };
      }

     const getData: unknown = await getRes.json();
     const hasSupportedShape = Array.isArray(getData)
       || (isRecord(getData) && (Array.isArray(getData.files) || Array.isArray(getData.auth_files)));

    if (!hasSupportedShape) {
      return { ok: false, error: "Invalid Management API response for OAuth accounts" };
    }

    const rawAuthFiles = parseAuthFilesResponse<Record<string, unknown>>(getData);
    if (!rawAuthFiles) {
      return { ok: false, error: "Invalid Management API response for OAuth accounts" };
    }

    const authFiles = rawAuthFiles
      .map((entry) => sanitizeOAuthListAuthFileEntry(entry))
      .filter((entry): entry is OAuthListAuthFileEntry => entry !== null);

    if (authFiles.length !== rawAuthFiles.length) {
      return { ok: false, error: "Invalid Management API response for OAuth accounts" };
    }

    const accountIdentifiers = authFiles.map((file) => ({
      provider:
        canonicalizeOAuthProvider(
          (isMeaningfulProviderValue(file.provider) ? file.provider :
            isMeaningfulProviderValue(file.type) ? file.type :
              inferOAuthProviderFromIdentifiers(file.id, file.name, file.email)) || "unknown"
        ) || "unknown",
      accountName: file.name,
    }));

    const ownerships = await prisma.providerOAuthOwnership.findMany({
      where: {
        OR: accountIdentifiers.map(({ provider, accountName }) => ({ provider, accountName })),
      },
      include: { user: { select: { id: true, username: true } } },
    });

    const ownershipMap = new Map(ownerships.map((o) => [`${o.provider}:${o.accountName}`, o]));

     const accountsWithOwnership: OAuthAccountWithOwnership[] = authFiles.map((file, index) => {
       const provider =
         (isMeaningfulProviderValue(file.provider) ? file.provider :
           isMeaningfulProviderValue(file.type) ? file.type :
             inferOAuthProviderFromIdentifiers(file.id, file.name, file.email)) || "unknown";
       const ownership = ownershipMap.get(`${canonicalizeOAuthProvider(provider) || provider}:${file.name}`);
       const isOwn = ownership?.userId === userId;
       const canSeeDetails = isOwn || isAdmin;

       return {
         id: canSeeDetails ? file.id : `account-${index + 1}`,
         accountName: canSeeDetails ? file.name : `Account ${index + 1}`,
         accountEmail: canSeeDetails ? file.email || null : null,
         provider,
         ownerUsername: canSeeDetails ? ownership?.user.username || null : null,
         ownerUserId: canSeeDetails ? ownership?.user.id || null : null,
         isOwn,
         status: file.status || "active",
         statusMessage: file.status_message || null,
         unavailable: file.unavailable ?? false,
       };
     });

    return { ok: true, accounts: accountsWithOwnership };
  } catch (error) {
    logger.error({ err: error }, "listOAuthWithOwnership error");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during OAuth listing",
    };
  }
}

interface ResolveOAuthResult {
  accountName: string | null;
  ownership: { id: string; userId: string } | null;
}

async function resolveOAuthAccountByIdOrName(
  idOrName: string,
  actionTarget?: OAuthActionTarget
): Promise<ResolveOAuthResult> {
  // First try to find by DB ID (CUID)
  const byId = await prisma.providerOAuthOwnership.findUnique({
    where: { id: idOrName },
    select: { id: true, userId: true, accountName: true },
  });
  if (byId) {
    return {
      accountName: byId.accountName,
      ownership: { id: byId.id, userId: byId.userId },
    };
  }

  // Try to find by accountName (management API file ID)
  const byName = actionTarget?.provider
    ? await prisma.providerOAuthOwnership.findUnique({
      where: {
        provider_accountName: {
          provider: canonicalizeOAuthProvider(actionTarget.provider) ?? actionTarget.provider,
          accountName: actionTarget.accountName ?? idOrName,
        },
      },
      select: { id: true, userId: true, accountName: true },
    })
    : null;

  if (byName) {
    return {
      accountName: byName.accountName,
      ownership: { id: byName.id, userId: byName.userId },
    };
  }
  // Fallback: treat as management file name/id directly
  return {
    accountName: idOrName,
    ownership: null,
  };
}

export async function removeOAuthAccount(
  userId: string,
  provider: string,
  accountName: string,
  isAdmin: boolean
): Promise<RemoveOAuthResult> {
  if (!MANAGEMENT_API_KEY) {
    return { ok: false, error: "Management API key not configured" };
  }

  try {
    const ownership = await prisma.providerOAuthOwnership.findUnique({
      where: {
        provider_accountName: {
          provider,
          accountName,
        },
      },
    });

    if (ownership && !isAdmin && ownership.userId !== userId) {
      return { ok: false, error: "Access denied" };
    }

     const endpoint = `${MANAGEMENT_BASE_URL}/auth-files?name=${encodeURIComponent(accountName)}&provider=${encodeURIComponent(provider)}`;

     let deleteRes: Response;
     try {
       deleteRes = await fetchWithTimeout(endpoint, {
         method: "DELETE",
         headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
       });
} catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          logger.error({
            err: fetchError,
            endpoint,
            accountName,
            timeoutMs: FETCH_TIMEOUT_MS,
          }, "Fetch timeout - removeOAuthAccount DELETE");
         return { ok: false, error: "Request timeout removing OAuth account" };
       }
       throw fetchError;
     }

      if (!deleteRes.ok) {
        await deleteRes.body?.cancel();
        return { ok: false, error: `Failed to remove OAuth account: HTTP ${deleteRes.status}` };
      }

    if (ownership) {
      await prisma.providerOAuthOwnership.delete({ where: { id: ownership.id } });
    }

    return { ok: true };
  } catch (error) {
    logger.error({ err: error, provider, accountName }, "removeOAuthAccount error");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during OAuth removal",
    };
  }
}

export async function removeOAuthAccountByIdOrName(
  userId: string,
  idOrName: string,
  isAdmin: boolean,
  actionTarget?: OAuthActionTarget
): Promise<RemoveOAuthResult> {
  if (!MANAGEMENT_API_KEY) {
    return { ok: false, error: "Management API key not configured" };
  }

  try {
    const resolved = await resolveOAuthAccountByIdOrName(idOrName, actionTarget);

    if (!resolved.accountName) {
      return { ok: false, error: "OAuth account not found" };
    }

    // Check ownership - if we have DB ownership, validate auth
    if (resolved.ownership) {
      if (!isAdmin && resolved.ownership.userId !== userId) {
        return { ok: false, error: "Access denied" };
      }
    } else {
      // No DB ownership - only admin can delete
      if (!isAdmin) {
        return { ok: false, error: "Access denied" };
      }
    }

     const endpoint = `${MANAGEMENT_BASE_URL}/auth-files?${buildOAuthManagementQuery(actionTarget ?? { idOrName }, resolved.accountName)}`;

     let deleteRes: Response;
     try {
       deleteRes = await fetchWithTimeout(endpoint, {
         method: "DELETE",
         headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
       });
} catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          logger.error({
            err: fetchError,
            endpoint,
            accountName: resolved.accountName,
            timeoutMs: FETCH_TIMEOUT_MS,
          }, "Fetch timeout - removeOAuthAccountByIdOrName DELETE");
         return { ok: false, error: "Request timeout removing OAuth account" };
       }
       throw fetchError;
     }

      if (!deleteRes.ok) {
        await deleteRes.body?.cancel();
        return { ok: false, error: `Failed to remove OAuth account: HTTP ${deleteRes.status}` };
      }

    // Clean up DB record if it exists
    if (resolved.ownership) {
      try {
        await prisma.providerOAuthOwnership.delete({
          where: { id: resolved.ownership.id },
        });
      } catch (e) {
        logger.error({ err: e, ownershipId: resolved.ownership.id }, "Failed to delete ownership record");
      }
    }

    return { ok: true };
  } catch (error) {
    logger.error({ err: error, idOrName }, "removeOAuthAccountByIdOrName error");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during OAuth removal",
    };
  }
}

export async function toggleOAuthAccountByIdOrName(
  userId: string,
  idOrName: string,
  disabled: boolean,
  isAdmin: boolean,
  actionTarget?: OAuthActionTarget
): Promise<ToggleOAuthResult> {
  if (!MANAGEMENT_API_KEY) {
    return { ok: false, error: "Management API key not configured" };
  }

  try {
    const resolved = await resolveOAuthAccountByIdOrName(idOrName, actionTarget);

    if (!resolved.accountName) {
      return { ok: false, error: "OAuth account not found" };
    }

    // Check ownership - if we have DB ownership, validate auth
    if (resolved.ownership) {
      if (!isAdmin && resolved.ownership.userId !== userId) {
        return { ok: false, error: "Access denied" };
      }
    } else {
      // No DB ownership - only admin can toggle
      if (!isAdmin) {
        return { ok: false, error: "Access denied" };
      }
    }

    const endpoint = `${MANAGEMENT_BASE_URL}/auth-files?${buildOAuthManagementQuery(actionTarget ?? { idOrName }, resolved.accountName)}`;

    let postRes: Response;
    try {
      postRes = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MANAGEMENT_API_KEY}`,
        },
        body: JSON.stringify({
          name: actionTarget?.accountName ?? resolved.accountName,
          ...(canonicalizeOAuthProvider(actionTarget?.provider)
            ? { provider: canonicalizeOAuthProvider(actionTarget?.provider) }
            : {}),
          disabled,
        }),
      });
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        logger.error({
          err: fetchError,
          endpoint,
          accountName: resolved.accountName,
          timeoutMs: FETCH_TIMEOUT_MS,
        }, "Fetch timeout - toggleOAuthAccountByIdOrName POST");
        return { ok: false, error: "Request timeout toggling OAuth account" };
      }
      throw fetchError;
    }

    if (!postRes.ok) {
      const errorBody = await postRes.text().catch(() => "");
      await postRes.body?.cancel();
      return { ok: false, error: `Failed to toggle OAuth account: HTTP ${postRes.status}${errorBody ? ` - ${errorBody}` : ""}` };
    }

    return { ok: true, disabled };
  } catch (error) {
    logger.error({ err: error, idOrName, disabled }, "toggleOAuthAccountByIdOrName error");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error during OAuth toggle",
    };
  }
}
