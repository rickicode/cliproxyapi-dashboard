import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  buildAvailableModelsFromProxyMock,
  extractOAuthModelAliasesMock,
  fetchModelsDevLimitsMock,
  getProxyUrlMock,
  getInternalProxyUrlMock,
  buildOhMyOpenCodeConfigMock,
  buildSlimConfigMock,
  fetchProxyModelsMock,
  validateFullConfigMock,
  validateSlimConfigMock,
  proxyModelsCacheGetMock,
  proxyModelsCacheSetMock,
  fetchWithRetryMock,
} = vi.hoisted(() => ({
  prismaMock: {
    modelPreference: { findUnique: vi.fn() },
    agentModelOverride: { findUnique: vi.fn() },
    userApiKey: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    configSubscription: { findUnique: vi.fn() },
    customProvider: { findMany: vi.fn() },
  },
  buildAvailableModelsFromProxyMock: vi.fn(),
  extractOAuthModelAliasesMock: vi.fn(),
  fetchModelsDevLimitsMock: vi.fn(),
  getProxyUrlMock: vi.fn(),
  getInternalProxyUrlMock: vi.fn(),
  buildOhMyOpenCodeConfigMock: vi.fn(),
  buildSlimConfigMock: vi.fn(),
  fetchProxyModelsMock: vi.fn(),
  validateFullConfigMock: vi.fn(),
  validateSlimConfigMock: vi.fn(),
  proxyModelsCacheGetMock: vi.fn(),
  proxyModelsCacheSetMock: vi.fn(),
  fetchWithRetryMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/config-generators/opencode", () => ({
  buildAvailableModelsFromProxy: buildAvailableModelsFromProxyMock,
  extractOAuthModelAliases: extractOAuthModelAliasesMock,
  fetchModelsDevLimits: fetchModelsDevLimitsMock,
  getProxyUrl: getProxyUrlMock,
  getInternalProxyUrl: getInternalProxyUrlMock,
  inferModelDefinition: vi.fn(),
}));

vi.mock("@/lib/config-generators/oh-my-opencode", () => ({
  buildOhMyOpenCodeConfig: buildOhMyOpenCodeConfigMock,
}));

vi.mock("@/lib/config-generators/oh-my-opencode-slim", () => ({
  buildSlimConfig: buildSlimConfigMock,
}));

vi.mock("@/lib/config-generators/shared", () => ({
  fetchProxyModels: fetchProxyModelsMock,
}));

vi.mock("@/lib/config-generators/oh-my-opencode-types", () => ({
  validateFullConfig: validateFullConfigMock,
}));

vi.mock("@/lib/config-generators/oh-my-opencode-slim-types", () => ({
  validateSlimConfig: validateSlimConfigMock,
}));

vi.mock("@/lib/cache", () => ({
  proxyModelsCache: {
    get: proxyModelsCacheGetMock,
    set: proxyModelsCacheSetMock,
  },
  CACHE_TTL: {
    PROXY_MODELS: 60_000,
  },
  CACHE_KEYS: {
    proxyModels: vi.fn(() => "proxy-models-cache-key"),
  },
}));

vi.mock("@/lib/fetch-utils", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

import { generateConfigBundle } from "@/lib/config-sync/generate-bundle";

describe("generateConfigBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.modelPreference.findUnique.mockResolvedValue(null);
    prismaMock.agentModelOverride.findUnique.mockResolvedValue(null);
    prismaMock.userApiKey.findFirst.mockResolvedValue({ id: "fallback-key", key: "fallback-secret" });
    prismaMock.userApiKey.findUnique.mockResolvedValue(null);
    prismaMock.userApiKey.update.mockResolvedValue(undefined);
    prismaMock.configSubscription.findUnique.mockResolvedValue(null);
    prismaMock.customProvider.findMany.mockResolvedValue([]);

    buildAvailableModelsFromProxyMock.mockReturnValue({});
    extractOAuthModelAliasesMock.mockReturnValue({});
    fetchModelsDevLimitsMock.mockResolvedValue({});
    getProxyUrlMock.mockReturnValue("https://proxy.example.com");
    getInternalProxyUrlMock.mockReturnValue("http://cliproxyapi:8317");
    buildOhMyOpenCodeConfigMock.mockReturnValue(null);
    buildSlimConfigMock.mockReturnValue(null);
    fetchProxyModelsMock.mockResolvedValue([]);
    validateFullConfigMock.mockImplementation((value: unknown) => value);
    validateSlimConfigMock.mockImplementation((value: unknown) => value);
    proxyModelsCacheGetMock.mockReturnValue(null);

    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
      body: { cancel: vi.fn() },
    });
  });

  it("uses the sync token's assigned API key when a sync key override is provided", async () => {
    prismaMock.userApiKey.findUnique.mockResolvedValue({ key: "sync-secret" });

    const bundle = await generateConfigBundle("user-1", "sync-key-id");

    expect(prismaMock.userApiKey.findUnique).toHaveBeenCalledWith({
      where: { id: "sync-key-id" },
      select: { key: true },
    });
    expect(bundle.opencode).toMatchObject({
      provider: {
        cliproxyapi: {
          options: {
            apiKey: "sync-secret",
          },
        },
      },
    });
    expect(prismaMock.userApiKey.update).toHaveBeenCalledWith({
      where: { id: "sync-key-id" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("falls back to the newest stored user API key when no sync override is present", async () => {
    prismaMock.userApiKey.findFirst.mockResolvedValue({ id: "newest-key", key: "newest-secret" });

    const bundle = await generateConfigBundle("user-1");

    expect(prismaMock.userApiKey.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      select: { id: true, key: true },
    });
    expect(bundle.opencode).toMatchObject({
      provider: {
        cliproxyapi: {
          options: {
            apiKey: "newest-secret",
          },
        },
      },
    });
    expect(prismaMock.userApiKey.update).toHaveBeenCalledWith({
      where: { id: "newest-key" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});
