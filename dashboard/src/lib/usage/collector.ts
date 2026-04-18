import "server-only";

import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { syncKeysToCliProxyApi } from "@/lib/api-keys/sync";
import { parseAuthFilesResponse } from "@/lib/providers/auth-files";

const BATCH_SIZE = 500;
const LATENCY_BACKFILL_BATCH_SIZE = 100;
const COLLECTOR_LEASE_STALE_MS = 15 * 60 * 1000;

export type UsageCollectorTrigger = "manual" | "scheduler" | "external";

export type UsageCollectorSkipReason = "collector-already-running";

export type UsageCollectorFailureReason =
  | "missing-management-api-key"
  | "collector-lock-failed"
  | "proxy-service-unavailable"
  | "failed-to-fetch-usage-data"
  | "unexpected-usage-response"
  | "usage-persist-failed";

export type UsageCollectorResult =
  | {
      ok: true;
      skipped: false;
      runId: string;
      processed: number;
      stored: number;
      skippedCount: number;
      latencyBackfilled: number;
      durationMs: number;
      lastCollectedAt: string;
    }
  | { ok: false; skipped: true; runId: string; reason: UsageCollectorSkipReason }
  | { ok: false; skipped: false; runId: string; reason: UsageCollectorFailureReason; status: "error" };

interface TokenDetails {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

interface RequestDetail {
  timestamp: string;
  latency_ms?: number;
  source: string;
  auth_index: string;
  tokens: TokenDetails;
  failed: boolean;
}

interface ModelUsage {
  total_requests: number;
  total_tokens: number;
  details: RequestDetail[];
}

interface ApiUsageEntry {
  total_requests: number;
  total_tokens: number;
  success_count?: number;
  failure_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  models?: Record<string, ModelUsage>;
  [key: string]: unknown;
}

interface RawUsageResponse {
  total_requests: number;
  success_count: number;
  failure_count: number;
  total_tokens: number;
  apis: Record<string, ApiUsageEntry>;
  requests_by_day?: Record<string, number>;
  requests_by_hour?: Record<string, number>;
  tokens_by_day?: Record<string, number>;
  tokens_by_hour?: Record<string, number>;
}

interface UsageRecordCandidate {
  authIndex: string;
  apiKeyId: string | null;
  userId: string | null;
  model: string;
  source: string;
  timestamp: Date;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  failed: boolean;
}

interface AuthFileEntry {
  auth_index: string;
  file_name?: string;
  email?: string;
  provider?: string;
  [key: string]: unknown;
}

interface AuthFileLookup {
  fileName: string;
  email: string;
  provider: string;
}

function buildOwnershipLookupKey(provider: string, source: string): string {
  return `${provider.toLowerCase()}|${source.toLowerCase()}`;
}

function addUnscopedOwnershipCandidate(lookup: Map<string, string | null>, source: string, userId: string) {
  const normalizedSource = source.toLowerCase();
  const existing = lookup.get(normalizedSource);

  if (existing === undefined) {
    lookup.set(normalizedSource, userId);
    return;
  }

  if (existing !== userId) {
    lookup.set(normalizedSource, null);
  }
}

function addProviderScopedOwnershipCandidate(lookup: Map<string, string | null>, provider: string, source: string, userId: string) {
  const key = buildOwnershipLookupKey(provider, source);
  const existing = lookup.get(key);

  if (existing === undefined) {
    lookup.set(key, userId);
    return;
  }

  if (existing !== userId) {
    lookup.set(key, null);
  }
}

function resolveOwnershipUserId(input: {
  provider: string;
  source: string;
  providerScopedSourceToUser: Map<string, string | null>;
  unscopedSourceToUser: Map<string, string | null>;
}): string | null {
  const normalizedSource = input.source.toLowerCase();
  const normalizedProvider = input.provider.trim().toLowerCase();

  if (normalizedProvider) {
    const providerScoped = input.providerScopedSourceToUser.get(buildOwnershipLookupKey(normalizedProvider, normalizedSource));
    if (providerScoped !== undefined) {
      return providerScoped;
    }
  }

  return input.unscopedSourceToUser.get(normalizedSource) ?? null;
}

function isCollectorAuthFileEntry(value: unknown): value is AuthFileEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const entry = value as Record<string, unknown>;

  if (typeof entry.auth_index !== "string" || !entry.auth_index.trim()) {
    return false;
  }

  if ("file_name" in entry && entry.file_name !== undefined && typeof entry.file_name !== "string") {
    return false;
  }

  if ("email" in entry && entry.email !== undefined && typeof entry.email !== "string") {
    return false;
  }

  if ("provider" in entry && entry.provider !== undefined && typeof entry.provider !== "string") {
    return false;
  }

  return true;
}

function normalizeSource(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseDetailTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isApiUsageEntry(value: unknown): value is ApiUsageEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "total_requests" in value &&
    "total_tokens" in value &&
    typeof (value as ApiUsageEntry).total_requests === "number" &&
    typeof (value as ApiUsageEntry).total_tokens === "number"
  );
}

function isRawUsageResponse(value: unknown): value is RawUsageResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("total_requests" in value) ||
    !("success_count" in value) ||
    !("failure_count" in value) ||
    !("total_tokens" in value) ||
    !("apis" in value)
  ) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  if (
    typeof obj.total_requests !== "number" ||
    typeof obj.success_count !== "number" ||
    typeof obj.failure_count !== "number" ||
    typeof obj.total_tokens !== "number" ||
    typeof obj.apis !== "object" ||
    obj.apis === null
  ) {
    return false;
  }

  const apis = obj.apis as Record<string, unknown>;
  for (const apiValue of Object.values(apis)) {
    if (!isApiUsageEntry(apiValue)) {
      return false;
    }
  }

  return true;
}

function usageDedupKey(input: {
  authIndex: string | null;
  model: string;
  timestamp: Date;
  source: string | null;
  totalTokens: number;
}) {
  return [
    input.authIndex ?? "",
    input.model,
    input.timestamp.toISOString(),
    input.source ?? "",
    String(input.totalTokens),
  ].join("|");
}

function buildLatencyBackfillCandidates(candidates: UsageRecordCandidate[]): UsageRecordCandidate[] {
  const deduped = new Map<string, UsageRecordCandidate>();

  for (const candidate of candidates) {
    if (candidate.latencyMs <= 0) {
      continue;
    }

    const key = usageDedupKey(candidate);
    const existing = deduped.get(key);
    if (!existing || candidate.latencyMs > existing.latencyMs) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}

async function tryAcquireCollectorLease(now: Date): Promise<boolean> {
  await prisma.collectorState.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      lastCollectedAt: now,
      lastStatus: "idle",
      recordsStored: 0,
      errorMessage: null,
    },
    update: {},
  });

  const staleBefore = new Date(now.getTime() - COLLECTOR_LEASE_STALE_MS);
  const claim = await prisma.collectorState.updateMany({
    where: {
      id: "singleton",
      OR: [{ lastStatus: { not: "running" } }, { updatedAt: { lt: staleBefore } }],
    },
    data: {
      lastStatus: "running",
      errorMessage: null,
    },
  });

  return claim.count === 1;
}

async function markCollectorError(runId: string, errorMessage: string) {
  await prisma.collectorState
    .upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        lastCollectedAt: new Date(),
        lastStatus: "error",
        recordsStored: 0,
        errorMessage,
      },
      update: {
        lastCollectedAt: new Date(),
        lastStatus: "error",
        recordsStored: 0,
        errorMessage,
      },
    })
    .then(() => {
      logger.warn({ runId, errorMessage }, "Collector state marked as error");
    })
    .catch((stateError) => {
      logger.error({ err: stateError, runId }, "Failed to mark collector error state");
    });
}

async function markCollectorSuccess(totalStored: number, collectedAt: Date) {
  await prisma.collectorState.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      lastCollectedAt: collectedAt,
      lastStatus: "success",
      recordsStored: totalStored,
      errorMessage: null,
    },
    update: {
      lastCollectedAt: collectedAt,
      lastStatus: "success",
      recordsStored: totalStored,
      errorMessage: null,
    },
  });
}

export async function runUsageCollector(input: {
  trigger: UsageCollectorTrigger;
}): Promise<UsageCollectorResult> {
  const runId = randomUUID();
  const startedAtMs = Date.now();
  const managementUrl =
    process.env.CLIPROXYAPI_MANAGEMENT_URL || "http://cliproxyapi:8317/v0/management";
  const managementApiKey = process.env.MANAGEMENT_API_KEY;

  if (!managementApiKey) {
    logger.error({ runId, trigger: input.trigger }, "MANAGEMENT_API_KEY is not configured");
    return { ok: false, skipped: false, runId, reason: "missing-management-api-key", status: "error" };
  }

  try {
    const leaseAcquired = await tryAcquireCollectorLease(new Date());
    if (!leaseAcquired) {
      logger.warn({ runId, trigger: input.trigger }, "Usage collection skipped: collector already running");
      return { ok: false, skipped: true, runId, reason: "collector-already-running" };
    }
  } catch (error) {
    logger.error({ err: error, runId, trigger: input.trigger }, "Failed to acquire collector lease");
    return { ok: false, skipped: false, runId, reason: "collector-lock-failed", status: "error" };
  }

  try {
    let usageResponse: Response;
    let authFilesResponse: Response | null = null;

    try {
      [usageResponse, authFilesResponse] = await Promise.all([
        fetch(`${managementUrl}/usage`, {
          method: "GET",
          headers: { Authorization: `Bearer ${managementApiKey}` },
          signal: AbortSignal.timeout(30_000),
        }),
        fetch(`${managementUrl}/auth-files`, {
          method: "GET",
          headers: { Authorization: `Bearer ${managementApiKey}` },
          signal: AbortSignal.timeout(30_000),
        }).catch(() => null),
      ]);
    } catch (fetchError) {
      logger.error({ err: fetchError, runId, trigger: input.trigger }, "Failed to connect to CLIProxyAPI");
      await markCollectorError(runId, "Proxy service unavailable");
      return { ok: false, skipped: false, runId, reason: "proxy-service-unavailable", status: "error" };
    }

    const authIndexToFile = new Map<string, AuthFileLookup>();
    if (authFilesResponse?.ok) {
      try {
        const authFilesJson: unknown = await authFilesResponse.json();
        const entries = parseAuthFilesResponse<AuthFileEntry>(authFilesJson);

        if (!entries || !entries.every(isCollectorAuthFileEntry)) {
          logger.warn({ runId }, "Ignoring auth-files response due to malformed entry");
        } else {
          for (const entry of entries) {
            authIndexToFile.set(entry.auth_index, {
              fileName: entry.file_name ?? "",
              email: entry.email ?? "",
              provider: entry.provider ?? "",
            });
          }
        }
      } catch {
        logger.warn({ runId }, "Failed to parse auth-files response");
      }
    } else if (authFilesResponse) {
      await authFilesResponse.body?.cancel();
    }

    if (!usageResponse.ok) {
      await usageResponse.body?.cancel();
      logger.error(
        { runId, status: usageResponse.status, statusText: usageResponse.statusText },
        "CLIProxyAPI usage endpoint returned error"
      );
      await markCollectorError(runId, "Failed to fetch usage data");
      return { ok: false, skipped: false, runId, reason: "failed-to-fetch-usage-data", status: "error" };
    }

    const responseJson: unknown = await usageResponse.json();
    const rawData: unknown =
      typeof responseJson === "object" && responseJson !== null && "usage" in responseJson
        ? (responseJson as Record<string, unknown>).usage
        : responseJson;

    if (!isRawUsageResponse(rawData)) {
      logger.error(
        { runId, response: JSON.stringify(responseJson).slice(0, 200) },
        "Unexpected usage response format from CLIProxyAPI"
      );
      await markCollectorError(runId, "Invalid usage data format");
      return { ok: false, skipped: false, runId, reason: "unexpected-usage-response", status: "error" };
    }

    const syncResult = await syncKeysToCliProxyApi();
    if (!syncResult.ok) {
      logger.warn({ runId, error: syncResult.error }, "API key sync failed before collection, continuing anyway");
    }

    const [apiKeys, oauthOwnerships, users] = await Promise.all([
      prisma.userApiKey.findMany({
        select: { id: true, key: true, userId: true },
      }),
      prisma.providerOAuthOwnership.findMany({
        select: { provider: true, accountName: true, accountEmail: true, userId: true },
      }),
      prisma.user.findMany({
        select: { id: true, username: true },
      }),
    ]);

    const providerScopedSourceToUser = new Map<string, string | null>();
    const unscopedSourceToUser = new Map<string, string | null>();
    for (const o of oauthOwnerships) {
      const provider = o.provider?.trim().toLowerCase() ?? "";

      if (o.accountEmail) {
        const normalizedEmail = o.accountEmail.toLowerCase();
        if (provider) {
          addProviderScopedOwnershipCandidate(providerScopedSourceToUser, provider, normalizedEmail, o.userId);
        }
        addUnscopedOwnershipCandidate(unscopedSourceToUser, normalizedEmail, o.userId);
      }

      if (o.accountName) {
        const normalizedName = o.accountName.toLowerCase();
        if (provider) {
          addProviderScopedOwnershipCandidate(providerScopedSourceToUser, provider, normalizedName, o.userId);
        }
        addUnscopedOwnershipCandidate(unscopedSourceToUser, normalizedName, o.userId);
      }
    }
    for (const u of users) {
      const normalizedUsername = u.username.toLowerCase();
      if (!unscopedSourceToUser.has(normalizedUsername)) {
        unscopedSourceToUser.set(normalizedUsername, u.id);
      }
    }

    const fullKeyMap = new Map<string, { apiKeyId: string; userId: string }>();
    for (const k of apiKeys) {
      fullKeyMap.set(k.key, { apiKeyId: k.id, userId: k.userId });
    }

    const keyMap = new Map<string, { apiKeyId: string; userId: string }>();
    for (const k of apiKeys) {
      const keyWithoutPrefix = k.key.startsWith("sk-") ? k.key.slice(3) : k.key;
      const prefix16 = keyWithoutPrefix.substring(0, 16);
      keyMap.set(prefix16, { apiKeyId: k.id, userId: k.userId });
    }

    const userToApiKeys = new Map<string, string[]>();
    for (const k of apiKeys) {
      const existingKeys = userToApiKeys.get(k.userId);
      if (existingKeys) {
        existingKeys.push(k.id);
      } else {
        userToApiKeys.set(k.userId, [k.id]);
      }
    }

    const candidates: UsageRecordCandidate[] = [];

    for (const [apiGroupKey, apiEntry] of Object.entries(rawData.apis)) {
      const models = apiEntry.models as Record<string, ModelUsage> | undefined;
      if (!models) continue;

      const keyGroupInfo = apiGroupKey.startsWith("sk-") ? fullKeyMap.get(apiGroupKey) ?? null : null;

      for (const [modelName, modelData] of Object.entries(models)) {
        if (!modelData.details || !Array.isArray(modelData.details)) continue;

        for (const detail of modelData.details) {
          const authIndex = typeof detail.auth_index === "string" ? detail.auth_index.trim() : "";
          const normalizedSource = normalizeSource(detail.source);

          if (!authIndex) {
            logger.warn({ runId, modelName, apiGroupKey, detail }, "Skipping malformed usage detail row: missing auth index");
            continue;
          }

          const timestamp = parseDetailTimestamp(detail.timestamp);
          if (!timestamp) {
            logger.warn({ runId, modelName, apiGroupKey, authIndex, detail }, "Skipping malformed usage detail row: invalid timestamp");
            continue;
          }

          const tokens =
            typeof detail.tokens === "object" && detail.tokens !== null
              ? (detail.tokens as Partial<TokenDetails>)
              : null;

          let resolvedUserId: string | null = null;
          let resolvedApiKeyId: string | null = null;

          if (keyGroupInfo) {
            resolvedUserId = keyGroupInfo.userId;
            resolvedApiKeyId = keyGroupInfo.apiKeyId;
          }

          if (!resolvedUserId) {
            const authFile = authIndexToFile.get(authIndex);
            if (authFile) {
              const provider = authFile.provider.trim().toLowerCase();
              const byFile = authFile.fileName
                ? resolveOwnershipUserId({
                    provider,
                    source: authFile.fileName,
                    providerScopedSourceToUser,
                    unscopedSourceToUser,
                  })
                : null;
              if (byFile) {
                resolvedUserId = byFile;
              } else if (authFile.email) {
                resolvedUserId = resolveOwnershipUserId({
                  provider,
                  source: authFile.email,
                  providerScopedSourceToUser,
                  unscopedSourceToUser,
                });
              }
            }
          }

          if (!resolvedUserId && normalizedSource) {
            const authFile = authIndexToFile.get(authIndex);
            const provider = authFile?.provider.trim().toLowerCase() ?? "";
            resolvedUserId = resolveOwnershipUserId({
              provider,
              source: normalizedSource,
              providerScopedSourceToUser,
              unscopedSourceToUser,
            });
          }

          if (!resolvedApiKeyId) {
            const keyInfo = keyMap.get(authIndex);
            if (keyInfo) {
              if (!resolvedUserId) {
                resolvedUserId = keyInfo.userId;
                resolvedApiKeyId = keyInfo.apiKeyId;
              } else if (resolvedUserId === keyInfo.userId) {
                resolvedApiKeyId = keyInfo.apiKeyId;
              }
            }
          }

          if (resolvedUserId && !resolvedApiKeyId) {
            const userApiKeys = userToApiKeys.get(resolvedUserId) ?? [];
            if (userApiKeys.length === 1) {
              resolvedApiKeyId = userApiKeys[0];
            }
          }

          candidates.push({
            authIndex,
            apiKeyId: resolvedApiKeyId,
            userId: resolvedUserId,
            model: modelName,
            source: normalizedSource,
            timestamp,
            latencyMs: Number.isFinite(Number(detail.latency_ms))
              ? Math.max(0, Math.round(Number(detail.latency_ms)))
              : 0,
            inputTokens: safeNumber(tokens?.input_tokens),
            outputTokens: safeNumber(tokens?.output_tokens),
            reasoningTokens: safeNumber(tokens?.reasoning_tokens),
            cachedTokens: safeNumber(tokens?.cached_tokens),
            totalTokens: safeNumber(tokens?.total_tokens),
            failed: detail.failed || false,
          });
        }
      }
    }

    let totalStored = 0;
    try {
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const result = await prisma.usageRecord.createMany({
          data: batch,
          skipDuplicates: true,
        });
        totalStored += result.count;
      }

      let latencyBackfilled = 0;
      const latencyBackfillCandidates = buildLatencyBackfillCandidates(candidates);
      for (let i = 0; i < latencyBackfillCandidates.length; i += LATENCY_BACKFILL_BATCH_SIZE) {
        const batch = latencyBackfillCandidates.slice(i, i + LATENCY_BACKFILL_BATCH_SIZE);
        const results = await prisma.$transaction(
          batch.map((candidate) =>
            prisma.usageRecord.updateMany({
              where: {
                authIndex: candidate.authIndex,
                model: candidate.model,
                timestamp: candidate.timestamp,
                source: candidate.source,
                totalTokens: candidate.totalTokens,
                latencyMs: 0,
              },
              data: {
                latencyMs: candidate.latencyMs,
              },
            })
          )
        );

        for (const result of results) {
          latencyBackfilled += result.count;
        }
      }

      const skipped = candidates.length - totalStored;
      const collectedAt = new Date();
      const durationMs = Date.now() - startedAtMs;

      await markCollectorSuccess(totalStored, collectedAt);

      logger.info(
        { runId, trigger: input.trigger, processed: candidates.length, stored: totalStored, skipped, latencyBackfilled, durationMs },
        "Usage collection completed"
      );

      return {
        ok: true,
        skipped: false,
        runId,
        processed: candidates.length,
        stored: totalStored,
        skippedCount: skipped,
        latencyBackfilled,
        durationMs,
        lastCollectedAt: collectedAt.toISOString(),
      };
    } catch (error) {
      logger.error({ err: error, runId, trigger: input.trigger }, "Failed to persist usage data");
      await markCollectorError(runId, "Collection failed");
      return { ok: false, skipped: false, runId, reason: "usage-persist-failed", status: "error" };
    }
  } catch (error) {
    const durationMs = Date.now() - startedAtMs;
    logger.error({ err: error, runId, trigger: input.trigger, durationMs }, "Usage collection failed");
    await markCollectorError(runId, "Collection failed");
    return { ok: false, skipped: false, runId, reason: "usage-persist-failed", status: "error" };
  }
}
