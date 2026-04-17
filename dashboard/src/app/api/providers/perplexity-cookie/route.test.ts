import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const checkRateLimitWithPresetMock = vi.fn();
const syncCustomProviderToProxyMock = vi.fn();
const loggerErrorMock = vi.fn();

const perplexityCookieUpdateManyMock = vi.fn();
const perplexityCookieCreateMock = vi.fn();
const customProviderFindUniqueMock = vi.fn();
const customProviderCreateMock = vi.fn();
const customProviderModelDeleteManyMock = vi.fn();
const customProviderUpdateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: checkRateLimitWithPresetMock,
}));

vi.mock("@/lib/providers/custom-provider-sync", () => ({
  syncCustomProviderToProxy: syncCustomProviderToProxyMock,
}));

vi.mock("@/lib/providers/perplexity", () => ({
  isPerplexityEnabled: vi.fn(() => true),
}));

vi.mock("@/lib/providers/hash", () => ({
  hashProviderKey: vi.fn(() => "hashed-key"),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: loggerErrorMock,
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    perplexityCookie: {
      updateMany: perplexityCookieUpdateManyMock,
      create: perplexityCookieCreateMock,
    },
    customProvider: {
      findUnique: customProviderFindUniqueMock,
      create: customProviderCreateMock,
      update: customProviderUpdateMock,
    },
    customProviderModel: {
      deleteMany: customProviderModelDeleteManyMock,
    },
    $transaction: transactionMock,
  },
}));

vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    validation: (message: string) =>
      new Response(JSON.stringify({ error: message }), { status: 400 }),
    missingFields: (fields: string[]) =>
      new Response(JSON.stringify({ error: `Missing fields: ${fields.join(", ")}` }), { status: 400 }),
    rateLimited: () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
    internal: (_context: string, error?: unknown) =>
      new Response(JSON.stringify({ error: error instanceof Error ? error.message : "internal" }), {
        status: 500,
      }),
    notFound: (entity: string) =>
      new Response(JSON.stringify({ error: `${entity} not found` }), { status: 404 }),
  },
}));

describe("POST /api/providers/perplexity-cookie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    perplexityCookieUpdateManyMock.mockResolvedValue({ count: 1 });
    perplexityCookieCreateMock.mockResolvedValue({
      id: "cookie-1",
      label: "Default",
      isActive: true,
      createdAt: new Date("2026-04-17T12:00:00.000Z"),
    });
    customProviderFindUniqueMock.mockResolvedValue(null);
    customProviderCreateMock.mockResolvedValue({ id: "provider-1" });
    customProviderModelDeleteManyMock.mockResolvedValue({ count: 1 });
    customProviderUpdateMock.mockResolvedValue({ id: "provider-1" });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        customProviderModel: {
          deleteMany: customProviderModelDeleteManyMock,
        },
        customProvider: {
          update: customProviderUpdateMock,
        },
      })
    );
    syncCustomProviderToProxyMock.mockResolvedValue({
      syncStatus: "failed",
      syncMessage: "Backend sync failed - provider created but may not work immediately",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ id: "sonar-pro" }] }),
      })
    );
  });

  it("returns partial-failure sync details when cookie save succeeds but proxy sync soft-fails", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/providers/perplexity-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          cookieData: JSON.stringify({ "next-auth.session-token": "session-token" }),
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      providerProvisioned: true,
      modelsUpdated: 1,
      syncStatus: "failed",
      syncMessage: expect.stringContaining("may not work immediately"),
      cookie: {
        id: "cookie-1",
        label: "Default",
        isActive: true,
      },
    });
    expect(syncCustomProviderToProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "perplexity-pro" }),
      "create"
    );
  });

  it("returns partial-failure sync details when proxy sync throws after cookie save", async () => {
    syncCustomProviderToProxyMock.mockRejectedValueOnce(new Error("proxy unavailable"));

    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/providers/perplexity-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          cookieData: JSON.stringify({ "next-auth.session-token": "session-token" }),
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      providerProvisioned: true,
      modelsUpdated: 1,
      syncStatus: "failed",
      syncMessage: expect.stringContaining("may not work immediately"),
      cookie: {
        id: "cookie-1",
      },
    });
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("returns partial-failure sync details for update sync throws after models persist", async () => {
    customProviderFindUniqueMock.mockResolvedValue({
      id: "provider-1",
      userId: "user-1",
      models: [{ upstreamName: "old-model", alias: "old-model" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ id: "sonar-pro" }, { id: "sonar-reasoning" }] }),
      })
    );
    syncCustomProviderToProxyMock.mockRejectedValueOnce(new Error("proxy unavailable"));

    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/providers/perplexity-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          cookieData: JSON.stringify({ "next-auth.session-token": "session-token" }),
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      providerProvisioned: false,
      modelsUpdated: 2,
      syncStatus: "failed",
      syncMessage: expect.stringContaining("may not work immediately"),
    });
    expect(transactionMock).toHaveBeenCalled();
    expect(customProviderModelDeleteManyMock).toHaveBeenCalled();
    expect(customProviderUpdateMock).toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("keeps earlier provisioning failures as internal errors", async () => {
    customProviderCreateMock.mockRejectedValueOnce(new Error("db write failed"));

    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/providers/perplexity-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          cookieData: JSON.stringify({ "next-auth.session-token": "session-token" }),
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "db write failed" });
    expect(syncCustomProviderToProxyMock).not.toHaveBeenCalled();
  });
});
