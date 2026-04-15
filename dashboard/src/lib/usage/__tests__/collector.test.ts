import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = {
  collectorState: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  usageRecord: {
    createMany: vi.fn(),
    updateMany: vi.fn(),
  },
  userApiKey: {
    findMany: vi.fn(),
  },
  providerOAuthOwnership: {
    findMany: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
};

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const syncKeysToCliProxyApi = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));
vi.mock("@/lib/api-keys/sync", () => ({ syncKeysToCliProxyApi }));

function buildUsageResponse(detailOverrides: Partial<Record<string, unknown>> = {}) {
  return new Response(
    JSON.stringify({
      usage: {
        total_requests: 1,
        success_count: 1,
        failure_count: 0,
        total_tokens: 42,
        apis: {
          test: {
            total_requests: 1,
            total_tokens: 42,
            models: {
              "gpt-4": {
                total_requests: 1,
                total_tokens: 42,
                details: [
                  {
                    timestamp: "2026-04-15T00:00:00.000Z",
                    latency_ms: 123,
                    source: "tester@example.com",
                    auth_index: "auth-1",
                    tokens: {
                      input_tokens: 20,
                      output_tokens: 22,
                      reasoning_tokens: 0,
                      cached_tokens: 0,
                      total_tokens: 42,
                    },
                    failed: false,
                    ...detailOverrides,
                  },
                ],
              },
            },
          },
        },
      },
    }),
    { status: 200 }
  );
}

function buildUsageResponseWithDetails(details: Array<Record<string, unknown>>) {
  return new Response(
    JSON.stringify({
      usage: {
        total_requests: details.length,
        success_count: details.length,
        failure_count: 0,
        total_tokens: 42 * details.length,
        apis: {
          test: {
            total_requests: details.length,
            total_tokens: 42 * details.length,
            models: {
              "gpt-4": {
                total_requests: details.length,
                total_tokens: 42 * details.length,
                details,
              },
            },
          },
        },
      },
    }),
    { status: 200 }
  );
}

function buildAuthFilesResponse() {
  return new Response(
    JSON.stringify({
      auth_files: [
        {
          auth_index: "auth-1",
          file_name: "tester@example.com",
          email: "tester@example.com",
        },
      ],
    }),
    { status: 200 }
  );
}

describe("runUsageCollector", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();

    mockPrisma.collectorState.upsert.mockResolvedValue(undefined);
    mockPrisma.collectorState.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.usageRecord.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.usageRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.userApiKey.findMany.mockResolvedValue([]);
    mockPrisma.providerOAuthOwnership.findMany.mockResolvedValue([
      {
        accountName: "tester@example.com",
        accountEmail: "tester@example.com",
        userId: "user-1",
      },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: "user-1", username: "tester@example.com" }]);
    mockPrisma.$transaction.mockResolvedValue([{ count: 1 }]);
    syncKeysToCliProxyApi.mockResolvedValue({ ok: true, keysCount: 0 });

    vi.stubEnv("MANAGEMENT_API_KEY", "devmanagementkey");
    vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://localhost:8317/v0/management");
  });

  it("returns skipped when collector lease is already held", async () => {
    mockPrisma.collectorState.updateMany.mockResolvedValue({ count: 0 });

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: true,
      reason: "collector-already-running",
    });
  });

  it("returns structured failure when MANAGEMENT_API_KEY is missing", async () => {
    vi.stubEnv("MANAGEMENT_API_KEY", "");

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: false,
      reason: "missing-management-api-key",
      status: "error",
    });
  });

  it("returns proxy-service-unavailable and marks collector error when fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: false,
      reason: "proxy-service-unavailable",
      status: "error",
    });

    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "error",
          recordsStored: 0,
          errorMessage: "Proxy service unavailable",
        }),
      })
    );
  });

  it("returns failed-to-fetch-usage-data for non-ok usage responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream error", { status: 500, statusText: "Server Error" }))
      .mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: false,
      reason: "failed-to-fetch-usage-data",
      status: "error",
    });

    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "error",
          errorMessage: "Failed to fetch usage data",
        }),
      })
    );
  });

  it("returns unexpected-usage-response for invalid payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ usage: { invalid: true } }), { status: 200 }))
      .mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: false,
      reason: "unexpected-usage-response",
      status: "error",
    });

    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "error",
          errorMessage: "Invalid usage data format",
        }),
      })
    );
  });

  it("returns usage-persist-failed when persistence fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(buildUsageResponse()).mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);
    mockPrisma.usageRecord.createMany.mockRejectedValue(new Error("db write failed"));

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: false,
      reason: "usage-persist-failed",
      status: "error",
    });

    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "error",
          errorMessage: "Collection failed",
        }),
      })
    );
  });

  it("stores usage records with skipDuplicates, backfills latency, and marks collector success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(buildUsageResponse()).mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
      processed: 1,
      stored: 1,
      skippedCount: 0,
      latencyBackfilled: 1,
      lastCollectedAt: expect.any(String),
      durationMs: expect.any(Number),
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            authIndex: "auth-1",
            userId: "user-1",
            model: "gpt-4",
            source: "tester@example.com",
            latencyMs: 123,
            totalTokens: 42,
          }),
        ],
        skipDuplicates: true,
      })
    );

    expect(mockPrisma.usageRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          authIndex: "auth-1",
          model: "gpt-4",
          source: "tester@example.com",
          totalTokens: 42,
          latencyMs: 0,
        }),
        data: { latencyMs: 123 },
      })
    );

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "success",
          recordsStored: 1,
          errorMessage: null,
        }),
      })
    );
  });

  it("skips malformed timestamp rows while still storing valid sibling rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildUsageResponseWithDetails([
          {
            timestamp: "not-a-date",
            latency_ms: 999,
            source: "tester@example.com",
            auth_index: "auth-1",
            tokens: {
              input_tokens: 1,
              output_tokens: 2,
              reasoning_tokens: 3,
              cached_tokens: 4,
              total_tokens: 10,
            },
            failed: false,
          },
          {
            timestamp: "2026-04-15T00:00:00.000Z",
            latency_ms: 123,
            source: "tester@example.com",
            auth_index: "auth-1",
            tokens: {
              input_tokens: 20,
              output_tokens: 22,
              reasoning_tokens: 0,
              cached_tokens: 0,
              total_tokens: 42,
            },
            failed: false,
          },
        ])
      )
      .mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            authIndex: "auth-1",
            timestamp: new Date("2026-04-15T00:00:00.000Z"),
            totalTokens: 42,
          }),
        ],
      })
    );
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "success",
          recordsStored: 1,
        }),
      })
    );
  });

  it("skips malformed non-string source rows while still storing valid sibling rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildUsageResponseWithDetails([
          {
            timestamp: "2026-04-15T00:00:00.000Z",
            latency_ms: 999,
            source: { nested: "bad-source" },
            auth_index: "auth-1",
            tokens: {
              input_tokens: 1,
              output_tokens: 2,
              reasoning_tokens: 3,
              cached_tokens: 4,
              total_tokens: 10,
            },
            failed: false,
          },
          {
            timestamp: "2026-04-15T01:00:00.000Z",
            latency_ms: 123,
            source: "tester@example.com",
            auth_index: "auth-1",
            tokens: {
              input_tokens: 20,
              output_tokens: 22,
              reasoning_tokens: 0,
              cached_tokens: 0,
              total_tokens: 42,
            },
            failed: false,
          },
        ])
      )
      .mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
      processed: 2,
      stored: 1,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            authIndex: "auth-1",
            timestamp: new Date("2026-04-15T00:00:00.000Z"),
            source: "",
            totalTokens: 10,
          }),
          expect.objectContaining({
            authIndex: "auth-1",
            timestamp: new Date("2026-04-15T01:00:00.000Z"),
            source: "tester@example.com",
            totalTokens: 42,
          }),
        ]),
      })
    );
    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "success",
          recordsStored: 1,
        }),
      })
    );
  });

  it("skips malformed detail payloads without failing the run", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        buildUsageResponseWithDetails([
          {
            timestamp: "2026-04-15T00:00:00.000Z",
            latency_ms: 123,
            source: "tester@example.com",
            auth_index: "",
            tokens: {
              input_tokens: 20,
              output_tokens: 22,
              reasoning_tokens: 0,
              cached_tokens: 0,
              total_tokens: 42,
            },
            failed: false,
          },
          {
            timestamp: "2026-04-15T01:00:00.000Z",
            latency_ms: 124,
            source: "tester@example.com",
            auth_index: "auth-1",
            tokens: "not-an-object",
            failed: false,
          },
          {
            timestamp: "2026-04-15T02:00:00.000Z",
            latency_ms: 125,
            source: "tester@example.com",
            auth_index: "auth-1",
            tokens: {
              total_tokens: 42,
            },
            failed: false,
          },
        ])
      )
      .mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            authIndex: "auth-1",
            timestamp: new Date("2026-04-15T01:00:00.000Z"),
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
          }),
          expect.objectContaining({
            authIndex: "auth-1",
            timestamp: new Date("2026-04-15T02:00:00.000Z"),
            totalTokens: 42,
          }),
        ],
      })
    );
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockPrisma.collectorState.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: "success",
          recordsStored: 1,
        }),
      })
    );
  });

  it("does not assign apiKeyId when user is resolved indirectly and has multiple keys", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(buildUsageResponse()).mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    mockPrisma.userApiKey.findMany.mockResolvedValue([
      { id: "key-1", key: "sk-first-key-value", userId: "user-1" },
      { id: "key-2", key: "sk-second-key-value", userId: "user-1" },
    ]);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: "user-1",
            apiKeyId: null,
            authIndex: "auth-1",
          }),
        ],
      })
    );
  });

  it("assigns apiKeyId when user is resolved indirectly and has exactly one key", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(buildUsageResponse()).mockResolvedValueOnce(buildAuthFilesResponse());
    vi.stubGlobal("fetch", fetchMock);

    mockPrisma.userApiKey.findMany.mockResolvedValue([{ id: "key-1", key: "sk-only-key-value", userId: "user-1" }]);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: "user-1",
            apiKeyId: "key-1",
            authIndex: "auth-1",
          }),
        ],
      })
    );
  });

  it("keeps an already-resolved user when authIndex prefix matches a different user's key", async () => {
    const authIndexPrefix = "auth-prefix-0001";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildUsageResponse({ auth_index: authIndexPrefix }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ auth_files: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mockPrisma.userApiKey.findMany.mockResolvedValue([{ id: "key-2", key: `sk-${authIndexPrefix}-conflict-key`, userId: "user-2" }]);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: "user-1",
            apiKeyId: null,
            authIndex: authIndexPrefix,
          }),
        ],
      })
    );
  });

  it("fills apiKeyId from authIndex prefix when it belongs to the same resolved user", async () => {
    const authIndexPrefix = "auth-prefix-0002";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildUsageResponse({ auth_index: authIndexPrefix }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ auth_files: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mockPrisma.userApiKey.findMany.mockResolvedValue([
      { id: "key-1", key: `sk-${authIndexPrefix}-same-user`, userId: "user-1" },
      { id: "key-2", key: "sk-second-key-value", userId: "user-1" },
    ]);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: "user-1",
            apiKeyId: "key-1",
            authIndex: authIndexPrefix,
          }),
        ],
      })
    );
  });

  it("resolves both userId and apiKeyId from authIndex prefix when no user is resolved yet", async () => {
    const authIndexPrefix = "auth-prefix-0003";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(buildUsageResponse({ source: "unknown@example.com", auth_index: authIndexPrefix }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ auth_files: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mockPrisma.providerOAuthOwnership.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.userApiKey.findMany.mockResolvedValue([{ id: "key-9", key: `sk-${authIndexPrefix}-prefix-only`, userId: "user-9" }]);

    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: true,
      skipped: false,
    });

    expect(mockPrisma.usageRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: "user-9",
            apiKeyId: "key-9",
            authIndex: authIndexPrefix,
          }),
        ],
      })
    );
  });
});
