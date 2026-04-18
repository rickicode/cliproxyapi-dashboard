import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const customProviderFindUniqueMock = vi.fn();
const customProviderDeleteMock = vi.fn();
const logAuditAsyncMock = vi.fn();
const extractIpAddressMock = vi.fn(() => "127.0.0.1");
const invalidateProxyModelsCacheMock = vi.fn();
const loggerErrorMock = vi.fn();
const syncCustomProviderToProxyMock = vi.fn();
const acquireMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    customProvider: {
      findUnique: customProviderFindUniqueMock,
      delete: customProviderDeleteMock,
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: {
    CUSTOM_PROVIDER_DELETED: "CUSTOM_PROVIDER_DELETED",
    CUSTOM_PROVIDER_UPDATED: "CUSTOM_PROVIDER_UPDATED",
  },
  extractIpAddress: extractIpAddressMock,
  logAuditAsync: logAuditAsyncMock,
}));

vi.mock("@/lib/env", () => ({
  env: {
    CLIPROXYAPI_MANAGEMENT_URL: "http://localhost:3000",
    MANAGEMENT_API_KEY: "test-management-key",
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: loggerErrorMock,
  },
}));

vi.mock("@/lib/cache", () => ({
  invalidateProxyModelsCache: invalidateProxyModelsCacheMock,
}));

vi.mock("@/lib/providers/custom-provider-sync", () => ({
  syncCustomProviderToProxy: syncCustomProviderToProxyMock,
}));

vi.mock("@/lib/providers/management-api", () => ({
  providerMutex: {
    acquire: acquireMock,
  },
}));

vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    notFound: (entity: string) => new Response(JSON.stringify({ error: `${entity} not found` }), { status: 404 }),
    forbidden: () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    internal: (_context: string, error?: unknown) =>
      new Response(JSON.stringify({ error: error instanceof Error ? error.message : "internal" }), {
        status: 500,
      }),
  },
  apiSuccess: (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 10) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("DELETE /api/custom-providers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();

    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    customProviderFindUniqueMock.mockResolvedValue({
      id: "provider-row-1",
      userId: "user-1",
      providerId: "custom-provider",
      name: "Custom Provider",
    });
    customProviderDeleteMock.mockResolvedValue({ id: "provider-row-1" });
    syncCustomProviderToProxyMock.mockResolvedValue({ syncStatus: "ok" });
  });

  it("waits for the shared openai-compatibility mutex before starting delete sync fetches", async () => {
    const releaseMock = vi.fn();
    const acquireGate = createDeferred<() => void>();
    acquireMock.mockReturnValueOnce(acquireGate.promise);

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "openai-compatibility": [{ name: "custom-provider" }, { name: "other-provider" }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { DELETE } = await import("./route");

    const responsePromise = DELETE(
      new NextRequest("http://localhost/api/custom-providers/provider-row-1", {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      }),
      { params: Promise.resolve({ id: "provider-row-1" }) }
    );

    await flushMicrotasks();

    expect(acquireMock).toHaveBeenCalledWith("openai-compatibility");
    expect(fetchSpy).not.toHaveBeenCalled();

    acquireGate.resolve(releaseMock);

    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ syncStatus: "ok" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(invalidateProxyModelsCacheMock).toHaveBeenCalledTimes(1);
  });
});
