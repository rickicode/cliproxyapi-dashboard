import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { timingSafeEqual } from "crypto";
import { apiError, ERROR_CODE, Errors } from "@/lib/errors";
import { runUsageCollector, type UsageCollectorFailureReason } from "@/lib/usage/collector";

const COLLECTOR_API_KEY = process.env.COLLECTOR_API_KEY;

function assertNever(value: never): never {
  throw new Error(`Unhandled collector failure reason: ${value}`);
}

function mapCollectorFailure(reason: UsageCollectorFailureReason) {
  switch (reason) {
    case "missing-management-api-key":
      return apiError(ERROR_CODE.CONFIG_ERROR, "Server configuration error", 500);
    case "collector-lock-failed":
      return apiError(ERROR_CODE.INTERNAL_SERVER_ERROR, "Failed to acquire collector lock", 500);
    case "proxy-service-unavailable":
      return apiError(
        ERROR_CODE.UPSTREAM_ERROR,
        "Proxy service unavailable during usage collection",
        503
      );
    case "failed-to-fetch-usage-data":
      return apiError(ERROR_CODE.UPSTREAM_ERROR, "Failed to fetch usage data from CLIProxyAPI", 502);
    case "unexpected-usage-response":
      return apiError(ERROR_CODE.UPSTREAM_ERROR, "Invalid usage data format from CLIProxyAPI", 502);
    case "usage-persist-failed":
      return apiError(ERROR_CODE.INTERNAL_SERVER_ERROR, "Collection failed", 500);
    default:
      return assertNever(reason);
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const isCronAuth = (() => {
    if (!COLLECTOR_API_KEY || !authHeader) return false;
    const expected = `Bearer ${COLLECTOR_API_KEY}`;
    if (authHeader.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
    } catch {
      return false;
    }
  })();

  if (!isCronAuth) {
    const session = await verifySession();
    if (!session) {
      return Errors.unauthorized();
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { isAdmin: true },
    });

    if (!user?.isAdmin) {
      return Errors.forbidden();
    }

    const originError = validateOrigin(request);
    if (originError) return originError;
  }

  const result = await runUsageCollector({ trigger: isCronAuth ? "external" : "manual" });

  if (result.ok) {
    return NextResponse.json({
      runId: result.runId,
      processed: result.processed,
      stored: result.stored,
      skipped: result.skippedCount,
      latencyBackfilled: result.latencyBackfilled,
      durationMs: result.durationMs,
      lastCollectedAt: result.lastCollectedAt,
    });
  }

  if (result.skipped) {
    return NextResponse.json({ success: false, message: "Collector already running", runId: result.runId }, { status: 202 });
  }

  return mapCollectorFailure(result.reason);
}
