import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn();
const validateOrigin = vi.fn();
const findUnique = vi.fn();
const runUsageCollector = vi.fn();

vi.mock("@/lib/auth/session", () => ({ verifySession }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));
vi.mock("@/lib/usage/collector", () => ({ runUsageCollector }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

describe("POST /api/usage/collect", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    verifySession.mockResolvedValue({ userId: "admin-user" });
    validateOrigin.mockReturnValue(null);
    findUnique.mockResolvedValue({ isAdmin: true });
  });

  async function callRoute() {
    const { POST } = await import("./route");
    return POST(
      new Request("http://localhost/api/usage/collect", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }) as unknown as NextRequest
    );
  }

  async function callRouteWithHeaders(headers: Record<string, string>) {
    const { POST } = await import("./route");
    return POST(
      new Request("http://localhost/api/usage/collect", {
        method: "POST",
        headers,
      }) as unknown as NextRequest
    );
  }

  it("returns success payload when collector succeeds", async () => {
    runUsageCollector.mockResolvedValue({
      ok: true,
      skipped: false,
      runId: "run-1",
      processed: 5,
      stored: 3,
      skippedCount: 2,
      latencyBackfilled: 1,
      durationMs: 250,
      lastCollectedAt: "2026-04-15T00:00:00.000Z",
    });

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      runId: "run-1",
      processed: 5,
      stored: 3,
      skipped: 2,
      latencyBackfilled: 1,
      durationMs: 250,
      lastCollectedAt: "2026-04-15T00:00:00.000Z",
    });
    expect(body).not.toHaveProperty("success");
  });

  it("returns 202 when collector is already running", async () => {
    runUsageCollector.mockResolvedValue({
      ok: false,
      skipped: true,
      runId: "run-2",
      reason: "collector-already-running",
    });

    const response = await callRoute();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: false,
      message: "Collector already running",
      runId: "run-2",
    });
  });

  it("uses external bearer auth when COLLECTOR_API_KEY matches", async () => {
    vi.stubEnv("COLLECTOR_API_KEY", "collector-secret");
    runUsageCollector.mockResolvedValue({
      ok: true,
      skipped: false,
      runId: "run-external",
      processed: 1,
      stored: 1,
      skippedCount: 0,
      latencyBackfilled: 0,
      durationMs: 25,
      lastCollectedAt: "2026-04-15T00:00:00.000Z",
    });

    const response = await callRouteWithHeaders({
      origin: "http://localhost",
      authorization: "Bearer collector-secret",
    });

    expect(response.status).toBe(200);
    expect(runUsageCollector).toHaveBeenCalledWith({ trigger: "external" });
    expect(verifySession).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(validateOrigin).not.toHaveBeenCalled();
  });

  it("falls back to session admin auth when bearer token is invalid", async () => {
    vi.stubEnv("COLLECTOR_API_KEY", "collector-secret");
    runUsageCollector.mockResolvedValue({
      ok: true,
      skipped: false,
      runId: "run-manual",
      processed: 1,
      stored: 1,
      skippedCount: 0,
      latencyBackfilled: 0,
      durationMs: 25,
      lastCollectedAt: "2026-04-15T00:00:00.000Z",
    });

    const response = await callRouteWithHeaders({
      origin: "http://localhost",
      authorization: "Bearer wrong-secret",
    });

    expect(response.status).toBe(200);
    expect(verifySession).toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalled();
    expect(validateOrigin).toHaveBeenCalled();
    expect(runUsageCollector).toHaveBeenCalledWith({ trigger: "manual" });
  });

  it("runs manual admin collection after validating origin", async () => {
    runUsageCollector.mockResolvedValue({
      ok: true,
      skipped: false,
      runId: "run-manual",
      processed: 1,
      stored: 1,
      skippedCount: 0,
      latencyBackfilled: 0,
      durationMs: 25,
      lastCollectedAt: "2026-04-15T00:00:00.000Z",
    });

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(validateOrigin).toHaveBeenCalledTimes(1);
    expect(runUsageCollector).toHaveBeenCalledWith({ trigger: "manual" });
  });

  it("returns the origin validation error for manual admin requests", async () => {
    validateOrigin.mockReturnValueOnce(new Response(JSON.stringify({ error: { message: "Invalid origin" } }), { status: 403 }));

    const response = await callRoute();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { message: "Invalid origin" } });
    expect(runUsageCollector).not.toHaveBeenCalled();
  });

  it("returns unauthorized when there is no session", async () => {
    verifySession.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Unauthorized" },
    });
    expect(runUsageCollector).not.toHaveBeenCalled();
  });

  it("returns forbidden for non-admin users", async () => {
    findUnique.mockResolvedValue({ isAdmin: false });

    const response = await callRoute();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Insufficient permissions" },
    });
    expect(runUsageCollector).not.toHaveBeenCalled();
  });

  it.each([
    ["missing-management-api-key", 500, "Server configuration error", "CONFIG_ERROR"],
    ["collector-lock-failed", 500, "Failed to acquire collector lock", "INTERNAL_SERVER_ERROR"],
    ["usage-persist-failed", 500, "Collection failed", "INTERNAL_SERVER_ERROR"],
    ["proxy-service-unavailable", 503, "Proxy service unavailable during usage collection", "UPSTREAM_ERROR"],
    ["failed-to-fetch-usage-data", 502, "Failed to fetch usage data from CLIProxyAPI", "UPSTREAM_ERROR"],
    ["unexpected-usage-response", 502, "Invalid usage data format from CLIProxyAPI", "UPSTREAM_ERROR"],
  ])("maps %s to the expected HTTP response", async (reason, status, message, code) => {
    runUsageCollector.mockResolvedValue({
      ok: false,
      skipped: false,
      runId: "run-fail",
      reason,
      status: "error",
    });

    const response = await callRoute();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: {
        code,
        message,
      },
    });
  });
});
