import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { Errors, apiSuccess } from "@/lib/errors";
import { bulkUpdateOAuthAccounts } from "@/lib/providers/dual-write";

interface BulkOAuthRequest {
  action: "enable" | "disable" | "disconnect";
  actionKeys: string[];
}

function isBulkOAuthRequest(body: unknown): body is BulkOAuthRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }

  const value = body as Record<string, unknown>;

  if (!["enable", "disable", "disconnect"].includes(String(value.action))) {
    return false;
  }

  if (!Array.isArray(value.actionKeys) || value.actionKeys.length === 0) {
    return false;
  }

  return value.actionKeys.every((entry) => typeof entry === "string" && entry.trim().length > 0);
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

  try {
    const body = await request.json();

    if (!isBulkOAuthRequest(body)) {
      return Errors.validation("Invalid request body");
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { isAdmin: true },
    });

    const result = await bulkUpdateOAuthAccounts(session.userId, user?.isAdmin ?? false, {
      action: body.action,
      actionKeys: body.actionKeys,
    });

    if (!result.ok) {
      return Errors.internal("POST /api/providers/oauth/bulk error", result.error);
    }

    return apiSuccess(
      {
        data: {
          summary: result.summary,
          failures: result.failures,
        },
      },
      result.summary.failureCount > 0 ? 207 : 200
    );
  } catch (error) {
    return Errors.internal("POST /api/providers/oauth/bulk error", error);
  }
}
