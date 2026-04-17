import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { acquireMock, releaseMock, invalidateProxyModelsCacheMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  invalidateProxyModelsCacheMock: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  env: {
    CLIPROXYAPI_MANAGEMENT_URL: "http://localhost:3000",
    MANAGEMENT_API_KEY: "test-management-key",
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/cache", () => ({
  invalidateProxyModelsCache: invalidateProxyModelsCacheMock,
}));

vi.mock("@/lib/providers/management-api", () => ({
  providerMutex: {
    acquire: acquireMock,
  },
}));

import { syncCustomProviderToProxy } from "@/lib/providers/custom-provider-sync";

describe("syncCustomProviderToProxy", () => {
  beforeEach(() => {
    acquireMock.mockReset();
    releaseMock.mockReset();
    invalidateProxyModelsCacheMock.mockReset();
    acquireMock.mockResolvedValue(releaseMock);
    vi.spyOn(globalThis, "fetch").mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires and releases the shared openai-compatibility mutex once", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ "openai-compatibility": [] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      syncCustomProviderToProxy(
        {
          providerId: "custom-provider",
          prefix: "custom",
          baseUrl: "https://example.com/v1",
          apiKey: "secret",
          proxyUrl: null,
          headers: { "X-Test": "1" },
          models: [{ upstreamName: "gpt-4", alias: "gpt-4" }],
          excludedModels: [{ pattern: "blocked-*" }],
        },
        "update"
      )
    ).resolves.toEqual({ syncStatus: "ok" });

    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(acquireMock).toHaveBeenCalledWith("openai-compatibility");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("uses the authoritative list fetched under the lock instead of stale prefetched config", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "openai-compatibility": [
              {
                name: "newer-provider",
                "base-url": "https://newer.example.com/v1",
                "api-key-entries": [{ "api-key": "newer-secret" }],
                models: [],
                "excluded-models": [],
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(
      syncCustomProviderToProxy(
        {
          providerId: "custom-provider",
          prefix: "custom",
          baseUrl: "https://example.com/v1",
          apiKey: "secret",
          proxyUrl: null,
          headers: null,
          models: [{ upstreamName: "gpt-4", alias: "gpt-4" }],
          excludedModels: [],
        },
        "update",
        [
          {
            name: "stale-provider",
            "base-url": "https://stale.example.com/v1",
            "api-key-entries": [{ "api-key": "stale-secret" }],
            models: [],
            "excluded-models": [],
          },
        ]
      )
    ).resolves.toEqual({ syncStatus: "ok" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const putCall = fetchSpy.mock.calls[1];
    expect(putCall?.[1]?.body).toBe(
      JSON.stringify([
        {
          name: "newer-provider",
          "base-url": "https://newer.example.com/v1",
          "api-key-entries": [{ "api-key": "newer-secret" }],
          models: [],
          "excluded-models": [],
        },
        {
          name: "custom-provider",
          prefix: "custom",
          "base-url": "https://example.com/v1",
          "api-key-entries": [{ "api-key": "secret" }],
          models: [{ name: "gpt-4", alias: "gpt-4" }],
          "excluded-models": [],
        },
      ])
    );
  });
});
