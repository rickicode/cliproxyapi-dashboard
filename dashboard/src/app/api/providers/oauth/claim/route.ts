import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  fetchWithTimeout,
  MANAGEMENT_BASE_URL,
  MANAGEMENT_API_KEY,
  isRecord,
} from "@/lib/providers/management-api";
import { resolveOAuthOwnership } from "@/lib/providers/oauth-ownership-resolver";
import { inferOAuthProviderFromIdentifiers, isMeaningfulProviderValue } from "@/lib/providers/provider-inference";

interface ClaimRequest {
  accountName: string;
  provider: string;
}

interface ManagementAuthFile {
  name: string;
  provider?: string;
  type?: string;
  email?: string;
}

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

function normalizeOAuthProviderAlias(provider: string | null | undefined): string | null {
  if (typeof provider !== "string") {
    return null;
  }

  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return OAUTH_PROVIDER_ALIASES[normalized] ?? normalized;
}

function isClaimRequest(body: unknown): body is ClaimRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  return typeof obj.accountName === "string"
    && obj.accountName.trim().length > 0
    && (typeof obj.provider !== "string" || obj.provider.trim().length > 0);
}

function isManagementAuthFile(value: unknown): value is ManagementAuthFile {
  if (!isRecord(value) || typeof value.name !== "string") {
    return false;
  }

  if (value.provider !== undefined && typeof value.provider !== "string") {
    return false;
  }

  if (value.type !== undefined && typeof value.type !== "string") {
    return false;
  }

  if (value.email !== undefined && typeof value.email !== "string") {
    return false;
  }

  return true;
}

function resolveCanonicalAuthFileProvider(file: ManagementAuthFile): string | null {
  return normalizeOAuthProviderAlias(isMeaningfulProviderValue(file.provider) ? file.provider : undefined)
    ?? normalizeOAuthProviderAlias(isMeaningfulProviderValue(file.type) ? file.type : undefined)
    ?? normalizeOAuthProviderAlias(
      inferOAuthProviderFromIdentifiers(undefined, file.name, file.email)
    );
}

function hasExplicitCanonicalAuthFileProvider(file: ManagementAuthFile): boolean {
  return normalizeOAuthProviderAlias(isMeaningfulProviderValue(file.provider) ? file.provider : undefined) !== null
    || normalizeOAuthProviderAlias(isMeaningfulProviderValue(file.type) ? file.type : undefined) !== null;
}

export async function POST(request: NextRequest) {
  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  const originError = validateOrigin(request);
  if (originError) {
    return originError;
  }

  const rateLimit = checkRateLimitWithPreset(request, "oauth-accounts", "OAUTH_ACCOUNTS");
  if (!rateLimit.allowed) {
    return Errors.rateLimited(rateLimit.retryAfterSeconds);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Errors.validation("Invalid JSON");
  }

  if (!isClaimRequest(body)) {
    return Errors.validation("Request body must include 'accountName' and 'provider' (string)");
  }

  const { accountName, provider: requestedProvider } = body;

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { isAdmin: true },
    });

    const isAdmin = user?.isAdmin ?? false;
    if (!isAdmin) {
      return Errors.forbidden();
    }

    if (!MANAGEMENT_API_KEY) {
      return Errors.internal("Management API key not configured");
    }

    let getRes: Response;
    try {
      getRes = await fetchWithTimeout(`${MANAGEMENT_BASE_URL}/auth-files`, {
        method: "GET",
        headers: { Authorization: `Bearer ${MANAGEMENT_API_KEY}` },
      });
    } catch {
      return Errors.badGateway("Failed to reach management API");
    }

    if (!getRes.ok) {
      await getRes.body?.cancel();
      return Errors.badGateway("Failed to fetch auth files");
    }

    let getData: unknown;
    try {
      getData = await getRes.json();
    } catch (error) {
      return Errors.badGateway("Invalid management API response", error);
    }

    if (!isRecord(getData) || !Array.isArray(getData.files)) {
      return Errors.badGateway("Invalid management API response");
    }

    const requestedCanonicalProvider = requestedProvider ? normalizeOAuthProviderAlias(requestedProvider) : null;

    const candidateFiles = getData.files.filter(
      (file): file is ManagementAuthFile => isManagementAuthFile(file) && file.name === accountName
    );

    let matchingFile: ManagementAuthFile | undefined;
    if (requestedCanonicalProvider) {
      matchingFile = candidateFiles.find((file) => {
        if (!hasExplicitCanonicalAuthFileProvider(file)) {
          return false;
        }
        return resolveCanonicalAuthFileProvider(file) === requestedCanonicalProvider;
      }) ?? candidateFiles.find((file) => resolveCanonicalAuthFileProvider(file) === requestedCanonicalProvider);
    } else {
      matchingFile = candidateFiles[0];
    }

    if (!matchingFile) {
      return Errors.notFound("Auth file not found in CLIProxyAPIPlus");
    }

    const provider = resolveCanonicalAuthFileProvider(matchingFile);
    if (!provider) {
      return Errors.badGateway("Invalid management API response");
    }

    const resolution = await resolveOAuthOwnership({
      currentUserId: session.userId,
      provider,
      accountName,
      accountEmail: matchingFile.email || null,
    });

    if (resolution.kind === "claimed_by_other_user" || resolution.kind === "ambiguous") {
      return Errors.conflict("Account already has an owner");
    }

    if (resolution.kind === "error") {
      return Errors.internal("Failed to claim OAuth account");
    }

    if (
      resolution.kind === "claimed"
      || resolution.kind === "merged_with_existing"
      || resolution.kind === "already_owned_by_current_user"
    ) {
      logger.info(
        { accountName, provider, userId: session.userId, resolution: resolution.kind },
        "Admin claimed ownership of OAuth account"
      );

      const status = resolution.kind === "claimed" ? 201 : 200;
      return NextResponse.json(
        { id: resolution.ownership.id, accountName, provider },
        { status }
      );
    }

    return Errors.conflict("Account already has an owner");
  } catch (error) {
    return Errors.internal("Failed to claim OAuth account", error);
  }
}
