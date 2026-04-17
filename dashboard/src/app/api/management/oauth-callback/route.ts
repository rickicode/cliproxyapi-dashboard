import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  classifyOAuthAutoClaim,
  type OAuthAutoClaimCandidate,
  type OAuthAutoClaimClassification,
} from "@/lib/providers/oauth-auto-claim";
import { resolveOAuthOwnership } from "@/lib/providers/oauth-ownership-resolver";

const PROVIDERS = {
  CLAUDE: "claude",
  GEMINI_CLI: "gemini-cli",
  CODEX: "codex",
  ANTIGRAVITY: "antigravity",
  IFLOW: "iflow",
  QWEN: "qwen",
  KIMI: "kimi",
  COPILOT: "copilot",
  KIRO: "kiro",
  CURSOR: "cursor",
  CODEBUDDY: "codebuddy",
} as const;

type Provider = (typeof PROVIDERS)[keyof typeof PROVIDERS];

const PROVIDERS_WITH_CALLBACK = new Set<Provider>([
  PROVIDERS.CLAUDE,
  PROVIDERS.GEMINI_CLI,
  PROVIDERS.CODEX,
  PROVIDERS.ANTIGRAVITY,
  PROVIDERS.IFLOW,
]);

const PROVIDER_MATCH_ALIASES: Record<Provider, readonly string[]> = {
  [PROVIDERS.CLAUDE]: ["claude", "anthropic"],
  [PROVIDERS.GEMINI_CLI]: ["gemini-cli", "gemini"],
  [PROVIDERS.CODEX]: ["codex", "openai"],
  [PROVIDERS.ANTIGRAVITY]: ["antigravity"],
  [PROVIDERS.IFLOW]: ["iflow"],
  [PROVIDERS.QWEN]: ["qwen"],
  [PROVIDERS.KIMI]: ["kimi"],
  [PROVIDERS.COPILOT]: ["copilot", "github", "github-copilot"],
  [PROVIDERS.KIRO]: ["kiro"],
  [PROVIDERS.CURSOR]: ["cursor"],
  [PROVIDERS.CODEBUDDY]: ["codebuddy"],
};

const CLIPROXYAPI_BASE = process.env.CLIPROXYAPI_MANAGEMENT_URL?.replace("/v0/management", "") || "http://cliproxyapi:8317";
const CLIPROXYAPI_MANAGEMENT_URL = process.env.CLIPROXYAPI_MANAGEMENT_URL || "http://cliproxyapi:8317/v0/management";
const MANAGEMENT_API_KEY = process.env.MANAGEMENT_API_KEY;

const CALLBACK_PATHS: Partial<Record<Provider, string>> = {
  [PROVIDERS.CLAUDE]: `${CLIPROXYAPI_BASE}/anthropic/callback`,
  [PROVIDERS.GEMINI_CLI]: `${CLIPROXYAPI_BASE}/google/callback`,
  [PROVIDERS.CODEX]: `${CLIPROXYAPI_BASE}/codex/callback`,
  [PROVIDERS.ANTIGRAVITY]: `${CLIPROXYAPI_BASE}/antigravity/callback`,
  [PROVIDERS.IFLOW]: `${CLIPROXYAPI_BASE}/iflow/callback`,
};

interface OAuthCallbackRequestBody {
  provider: Provider;
  callbackUrl?: string;
  state?: string;
}

interface OAuthCallbackResponse {
  status: number;
}

interface AuthFileEntry {
  name: string;
  provider?: string;
  type?: string;
  email?: string;
}

interface AuthFilesResponse {
  files: AuthFileEntry[];
  hasMalformedEntries: boolean;
}

const sanitizeAuthFileEntry = (entry: unknown): AuthFileEntry | null => {
  if (!isRecord(entry) || typeof entry.name !== "string") return null;

  if (entry.provider !== undefined && typeof entry.provider !== "string") return null;
  if (entry.type !== undefined && typeof entry.type !== "string") return null;
  if (entry.email !== undefined && typeof entry.email !== "string") return null;

  const sanitized: AuthFileEntry = { name: entry.name };

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

interface OAuthOwnershipRecord {
  accountName: string;
  userId: string;
  user?: {
    id: string;
    username: string | null;
  } | null;
}

type OAuthCallbackAutoClaimResponse =
  | {
    kind: "claimed";
    candidate: OAuthAutoClaimCandidate;
   }
  | {
      kind: "merged_with_existing";
      candidate: OAuthAutoClaimCandidate;
    }
  | OAuthAutoClaimClassification;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isProvider = (value: unknown): value is Provider =>
  Object.values(PROVIDERS).includes(value as Provider);

const matchesAuthFileProvider = (
  provider: Provider,
  fileProviderRaw: string,
  fileNameRaw: string
) => {
  const aliases = PROVIDER_MATCH_ALIASES[provider];
  const fileProvider = fileProviderRaw.toLowerCase();
  const fileName = fileNameRaw.toLowerCase();
  return aliases.some((alias) => fileProvider === alias || fileName.includes(alias));
};

const parseRequestBody = (body: unknown): OAuthCallbackRequestBody | null => {
  if (!isRecord(body)) return null;
  const provider = body.provider;
  const callbackUrl = body.callbackUrl;
  const state = body.state;
  if (!isProvider(provider)) return null;
  if (callbackUrl !== undefined && typeof callbackUrl !== "string") return null;
  if (state !== undefined && typeof state !== "string") return null;
  return {
    provider,
    callbackUrl: typeof callbackUrl === "string" ? callbackUrl : undefined,
    state: typeof state === "string" ? state : undefined,
  };
};

const extractCallbackParams = (callbackUrl: string) => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    return null;
  }

  const code = parsedUrl.searchParams.get("code");
  const state = parsedUrl.searchParams.get("state");
  if (!code || !state) return null;

  return { code, state };
};

const fetchAuthFiles = async (): Promise<AuthFilesResponse | null> => {
  if (!MANAGEMENT_API_KEY) return null;

  try {
    const response = await fetch(`${CLIPROXYAPI_MANAGEMENT_URL}/auth-files`, {
      method: "GET",
      headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
    });

    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.files)) return null;

    let hasMalformedEntries = false;
    const files = data.files.flatMap((entry) => {
      const sanitized = sanitizeAuthFileEntry(entry);
      if (!sanitized) {
        hasMalformedEntries = true;
      }
      return sanitized ? [sanitized] : [];
    });

    return { files, hasMalformedEntries };
  } catch {
    return null;
  }
};

/**
 * Find new auth files by comparing before/after snapshots.
 * Primary strategy: snapshot-diff is provider-agnostic and works regardless
 * of how CLIProxyAPIPlus names the auth file.
 */
const findNewAuthFilesByDiff = (
  before: AuthFileEntry[],
  after: AuthFileEntry[],
  provider: Provider
): AuthFileEntry[] => {
  const beforeNames = new Set(before.map((f) => f.name));

  return after.filter((file) => {
    if (beforeNames.has(file.name)) return false;

    const fileProvider = (file.provider || file.type || "").toLowerCase();
    const fileNameLower = file.name.toLowerCase();
    return matchesAuthFileProvider(provider, fileProvider, fileNameLower);
  });
};

/**
 * Find auth files matching the OAuth state in the filename.
 * Fallback strategy for providers that embed state in auth file names.
 */
const findAuthFilesByState = (
  files: AuthFileEntry[],
  provider: Provider,
  resolvedState: string | undefined
): AuthFileEntry[] => {
  return files.filter((file) => {
    const fileNameLower = file.name.toLowerCase();
    const fileProvider = (file.provider || file.type || "").toLowerCase();

    if (!matchesAuthFileProvider(provider, fileProvider, fileNameLower)) {
      return false;
    }

    if (!resolvedState) return true;

    return file.name.includes(resolvedState) ||
      fileNameLower.includes(resolvedState.toLowerCase());
  });
};

/**
 * Find unclaimed auth files matching the provider that have no ownership record.
 * Last-resort fallback: if only one unclaimed file exists for this provider, claim it.
 */
const findUnclaimedAuthFiles = async (
  files: AuthFileEntry[],
  provider: Provider
): Promise<AuthFileEntry[]> => {
  const providerFiles = files.filter((file) => {
    const fileProvider = (file.provider || file.type || "").toLowerCase();
    const fileNameLower = file.name.toLowerCase();
    return matchesAuthFileProvider(provider, fileProvider, fileNameLower);
  });

  if (providerFiles.length === 0) return [];

  const existingOwnerships = await prisma.providerOAuthOwnership.findMany({
    where: { accountName: { in: providerFiles.map((f) => f.name) } },
    select: { accountName: true },
  });

  const ownedNames = new Set(existingOwnerships.map((o) => o.accountName));
  return providerFiles.filter((f) => !ownedNames.has(f.name));
};

const buildAutoClaimCandidates = (
  files: AuthFileEntry[],
  ownerships: OAuthOwnershipRecord[]
): OAuthAutoClaimCandidate[] => {
  const ownershipMap = new Map(ownerships.map((ownership) => [ownership.accountName, ownership]));

  return files.map((file) => {
    const ownership = ownershipMap.get(file.name);
    return {
      accountName: file.name,
      accountEmail: file.email || null,
      ownerUserId: ownership?.userId ?? null,
      ownerUsername: ownership?.user?.username ?? null,
    };
  });
};

const fetchOwnershipRecords = async (accountNames: string[]): Promise<OAuthOwnershipRecord[]> => {
  if (accountNames.length === 0) return [];

  const ownerships = await prisma.providerOAuthOwnership.findMany({
    where: { accountName: { in: accountNames } },
    include: { user: { select: { id: true, username: true } } },
  });

  return ownerships as OAuthOwnershipRecord[];
};

const normalizeAutoClaimResult = async ({
  currentUserId,
  candidateFiles,
}: {
  currentUserId: string;
  candidateFiles: AuthFileEntry[];
}): Promise<OAuthCallbackAutoClaimResponse> => {
  try {
    const candidates = buildAutoClaimCandidates(
      candidateFiles,
      await fetchOwnershipRecords(candidateFiles.map((file) => file.name))
    );

    const classification = classifyOAuthAutoClaim({
      currentUserId,
      candidates,
    });

    if (classification.kind !== "claimable") {
      return classification;
    }

    return {
      kind: "claimed",
      candidate: {
        ...classification.candidate,
        ownerUserId: currentUserId,
      },
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        accountNames: candidateFiles.map((file) => file.name),
      },
      "OAuth callback: failed to normalize auto-claim candidates"
    );

    return classifyOAuthAutoClaim({
      currentUserId,
      candidates: [],
      failure: {
        code: "ownership_lookup_failed",
        message: "Failed to evaluate OAuth auto-claim candidates",
      },
    });
  }
};

const toAutoClaimCandidate = (
  accountName: string,
  accountEmail: string | null | undefined,
  ownerUserId: string | null,
  ownerUsername: string | null
): OAuthAutoClaimCandidate => ({
  accountName,
  accountEmail: accountEmail ?? null,
  ownerUserId,
  ownerUsername,
});

const resolveCandidateOwnership = async ({
  currentUserId,
  provider,
  candidate,
}: {
  currentUserId: string;
  provider: Provider;
  candidate: OAuthAutoClaimCandidate;
}): Promise<OAuthCallbackAutoClaimResponse> => {
  const resolution = await resolveOAuthOwnership({
    currentUserId,
    provider,
    accountName: candidate.accountName,
    accountEmail: candidate.accountEmail ?? null,
  });

  switch (resolution.kind) {
    case "claimed":
    case "merged_with_existing":
      return {
        kind: resolution.kind,
        candidate: toAutoClaimCandidate(
          resolution.ownership.accountName,
          resolution.ownership.accountEmail,
          resolution.ownership.userId,
          null
        ),
      };
    case "already_owned_by_current_user":
    case "claimed_by_other_user":
      return {
        kind: resolution.kind,
        candidate: toAutoClaimCandidate(
          resolution.ownership.accountName,
          resolution.ownership.accountEmail,
          resolution.ownership.userId,
          null
        ),
      };
    case "ambiguous":
      return {
        kind: "ambiguous",
        candidates: resolution.ownerships.map((ownership) =>
          toAutoClaimCandidate(
            ownership.accountName,
            ownership.accountEmail,
            ownership.userId,
            null
          )
        ),
      };
    case "error":
      return {
        kind: "error",
        failure: resolution.failure,
      };
  }
};

export async function POST(request: NextRequest) {
  const session = await verifySession();

  if (!session) {
    return Errors.unauthorized();
  }

  const originError = validateOrigin(request);
  if (originError) {
    return originError;
  }

  const rateLimit = checkRateLimitWithPreset(request, "oauth-callback", "OAUTH_CALLBACK");
  if (!rateLimit.allowed) {
    return Errors.rateLimited(rateLimit.retryAfterSeconds);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  const parsedBody = parseRequestBody(rawBody);
  if (!parsedBody) {
    return Errors.validation("Invalid request body");
  }

  const { provider, callbackUrl, state } = parsedBody;

  try {
    let responseStatus = 200;
    let resolvedState = state;

    const preCallbackSnapshot = await fetchAuthFiles();
    const preCallbackFiles = preCallbackSnapshot?.files ?? null;
    const preCallbackNames = preCallbackFiles
      ? new Set(preCallbackFiles.map((f) => f.name))
      : null;

    if (PROVIDERS_WITH_CALLBACK.has(provider)) {
      if (!callbackUrl) {
        return Errors.validation("Callback URL is required for this provider");
      }

      if (!state) {
        return Errors.validation("State is required for this provider");
      }

      const callbackParams = extractCallbackParams(callbackUrl);
      if (!callbackParams) {
        return Errors.validation("Callback URL must include code and state");
      }

      if (callbackParams.state !== state) {
        return Errors.validation("Callback state does not match the active OAuth flow");
      }

      const callbackPath = CALLBACK_PATHS[provider];
      if (!callbackPath) {
        return Errors.internal("OAuth callback endpoint is not configured");
      }

      const callbackTarget = new URL(callbackPath);
      callbackTarget.searchParams.set("code", callbackParams.code);
      callbackTarget.searchParams.set("state", callbackParams.state);
      resolvedState = state;

      const response = await fetch(callbackTarget.toString(), { method: "GET" });
      responseStatus = response.status;

      if (!response.ok) {
        await response.body?.cancel();
        const payload: OAuthCallbackResponse = { status: responseStatus };
        return NextResponse.json(payload, { status: responseStatus });
      }
    } else if (!resolvedState) {
      return Errors.validation("State is required for this provider");
    }

    let candidateFiles: AuthFileEntry[] = [];
    const MAX_RETRIES = 10;
    const RETRY_DELAY_MS = 1500;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      const afterAuthFileSnapshot = await fetchAuthFiles();
      if (!afterAuthFileSnapshot) continue;

      const afterAuthFiles = afterAuthFileSnapshot.files;
      const hasMalformedEntries = afterAuthFileSnapshot.hasMalformedEntries;

      if (preCallbackFiles && !hasMalformedEntries) {
        const diffCandidates = findNewAuthFilesByDiff(preCallbackFiles, afterAuthFiles, provider);
        if (diffCandidates.length > 0) {
          candidateFiles = diffCandidates;
          logger.info(
            { provider, strategy: "snapshot-diff", count: diffCandidates.length },
            "OAuth callback: matched new auth file via snapshot diff"
          );
          break;
        }
      } else if (preCallbackFiles && hasMalformedEntries) {
        logger.warn(
          { provider, attempt },
          "OAuth callback: skipping snapshot-diff heuristic due to malformed auth-file entries"
        );
      }

      const stateCandidates = findAuthFilesByState(afterAuthFiles, provider, resolvedState);
      if (stateCandidates.length > 0) {
        candidateFiles = stateCandidates;
        logger.info(
          { provider, strategy: "state-match", count: stateCandidates.length },
          "OAuth callback: matched auth file via state in filename"
        );
        break;
      }

      // For non-callback providers (e.g. Cursor, CodeBuddy), the auth file is
      // written by the browser flow *before* POST /oauth-callback is called, so
      // preCallbackFiles is always stale and snapshot-diff yields nothing.
      // Run unclaimed detection on every attempt for these providers so we
      // can claim on attempt 1 rather than waiting until attempt 8+.
      const runUnclaimed =
        !hasMalformedEntries &&
        (!PROVIDERS_WITH_CALLBACK.has(provider) || attempt >= MAX_RETRIES - 2);

      if (runUnclaimed) {
        const unclaimedCandidates = await findUnclaimedAuthFiles(afterAuthFiles, provider);
        if (unclaimedCandidates.length === 1) {
          candidateFiles = unclaimedCandidates;
          logger.info(
            { provider, strategy: "unclaimed-single", name: unclaimedCandidates[0].name },
            "OAuth callback: matched single unclaimed auth file for provider"
          );
          break;
        }

        if (unclaimedCandidates.length > 1) {
          if (PROVIDERS_WITH_CALLBACK.has(provider) && preCallbackNames) {
            const newAndUnclaimed = unclaimedCandidates.filter(
              (f) => !preCallbackNames.has(f.name)
            );
            if (newAndUnclaimed.length === 1) {
              candidateFiles = newAndUnclaimed;
              logger.info(
                { provider, strategy: "unclaimed-new", name: newAndUnclaimed[0].name },
                "OAuth callback: matched single new unclaimed auth file"
              );
              break;
            }

            candidateFiles = unclaimedCandidates;
            logger.info(
              { provider, strategy: "unclaimed-ambiguous", count: unclaimedCandidates.length },
              "OAuth callback: multiple unclaimed auth files found without safe newness signal"
            );
            break;
          }

          if (!PROVIDERS_WITH_CALLBACK.has(provider)) {
            candidateFiles = unclaimedCandidates;
            logger.info(
              { provider, strategy: "unclaimed-ambiguous", count: unclaimedCandidates.length },
              "OAuth callback: multiple unclaimed auth files found without safe newness signal"
            );
            break;
          }
        }
      } else if (hasMalformedEntries) {
        logger.warn(
          { provider, attempt },
          "OAuth callback: skipping heuristic fallback due to malformed auth-file entries"
        );
      }
    }

    let autoClaim: OAuthCallbackAutoClaimResponse;

    if (candidateFiles.length === 0) {
      logger.warn(
        { provider, state: resolvedState || null, preSnapshotCount: preCallbackFiles?.length ?? -1 },
        "OAuth callback: no auth file candidates found after successful connect"
      );
      autoClaim = classifyOAuthAutoClaim({
        currentUserId: session.userId,
        candidates: [],
      });
    } else {
      const initialAutoClaim = await normalizeAutoClaimResult({
        currentUserId: session.userId,
        candidateFiles,
      });

      if (initialAutoClaim.kind === "claimed") {
        autoClaim = await resolveCandidateOwnership({
          currentUserId: session.userId,
          provider,
          candidate: initialAutoClaim.candidate,
        });

        if (autoClaim.kind === "claimed" || autoClaim.kind === "merged_with_existing") {
          logger.info(
            {
              provider,
              accountName: autoClaim.candidate.accountName,
              userId: session.userId,
              resolution: autoClaim.kind,
            },
            "OAuth callback: ownership resolved successfully"
          );
        }
      } else {
        autoClaim = initialAutoClaim;
      }
    }

    const payload: OAuthCallbackResponse & { autoClaim: OAuthCallbackAutoClaimResponse } = {
      status: responseStatus,
      autoClaim,
    };

    return NextResponse.json(payload, { status: responseStatus });
  } catch (error) {
    return Errors.internal("Failed to relay OAuth callback", error);
  }
}
