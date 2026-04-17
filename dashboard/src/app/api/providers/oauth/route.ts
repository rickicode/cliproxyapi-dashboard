import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { checkRateLimitWithPreset } from "@/lib/auth/rate-limit";
import { contributeOAuthAccount, listOAuthAccounts } from "@/lib/providers/dual-write";
import { OAUTH_PROVIDER, type OAuthProvider } from "@/lib/providers/constants";
import { ERROR_CODE, Errors, apiError, apiSuccess } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { DEFAULT_OAUTH_LIST_QUERY, type OAuthListQuery } from "@/lib/providers/oauth-listing";

interface ContributeOAuthRequest {
  provider: string;
  accountName: string;
  accountEmail?: string;
}

function isContributeOAuthRequest(body: unknown): body is ContributeOAuthRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;

  const obj = body as Record<string, unknown>;

  if (typeof obj.provider !== "string") return false;
  if (typeof obj.accountName !== "string") return false;
  if (obj.accountName.trim().length === 0) return false;
  if (obj.accountEmail !== undefined && typeof obj.accountEmail !== "string") return false;

  return true;
}

function isValidOAuthProvider(provider: string): provider is OAuthProvider {
  return Object.values(OAUTH_PROVIDER).includes(provider as OAuthProvider);
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOAuthListQuery(request: NextRequest): OAuthListQuery {
  const { searchParams } = new URL(request.url);

  return {
    q: searchParams.get("q") ?? DEFAULT_OAUTH_LIST_QUERY.q,
    status: searchParams.get("status") ?? DEFAULT_OAUTH_LIST_QUERY.status,
    page: parsePositiveInteger(searchParams.get("page"), DEFAULT_OAUTH_LIST_QUERY.page),
    pageSize: parsePositiveInteger(searchParams.get("pageSize"), DEFAULT_OAUTH_LIST_QUERY.pageSize),
    preview: searchParams.get("preview") === "true",
  };
}

export async function GET(request: NextRequest) {
  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { isAdmin: true },
    });

    const isAdmin = user?.isAdmin ?? false;
    const query = parseOAuthListQuery(request);

    const result = await listOAuthAccounts(session.userId, isAdmin, query);

    if (!result.ok) {
      return apiError(ERROR_CODE.PROVIDER_ERROR, result.error ?? "Provider error", 500);
    }

    return apiSuccess({ data: result.data });
  } catch (error) {
    return Errors.internal("GET /api/providers/oauth error", error);
  }
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
    return Errors.validation("Invalid JSON request body");
  }

  try {
    if (!isContributeOAuthRequest(body)) {
      return Errors.validation("Invalid request body");
    }

    if (!isValidOAuthProvider(body.provider)) {
      return apiError(ERROR_CODE.PROVIDER_INVALID, "Invalid OAuth provider", 400);
    }

    const result = await contributeOAuthAccount(
      session.userId,
      body.provider,
      body.accountName,
      body.accountEmail
    );

    if (!result.ok) {
      if (result.error?.includes("already registered") || result.error?.includes("manual review")) {
        return Errors.conflict(result.error);
      }
      return apiError(ERROR_CODE.PROVIDER_ERROR, result.error ?? "Provider error", 500);
    }

    return NextResponse.json({ id: result.id, resolution: result.resolution }, { status: 201 });
  } catch (error) {
    return Errors.internal("POST /api/providers/oauth error", error);
  }
}
