import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-chars";
process.env.MANAGEMENT_API_KEY ??= "test-management-key-1234";

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const generateSyncTokenMock = vi.fn();
const checkRateLimitWithPresetMock = vi.fn();

const findFirstMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("@/lib/auth/sync-token", () => ({
  generateSyncToken: generateSyncTokenMock,
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: checkRateLimitWithPresetMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    userApiKey: {
      findFirst: findFirstMock,
    },
    syncToken: {
      create: createMock,
    },
  },
}));

describe("POST /api/config-sync/tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    generateSyncTokenMock.mockReturnValue({
      token: "plain-sync-token",
      hash: "hashed-sync-token",
    });
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });

    findFirstMock.mockImplementation(async ({ orderBy }) => {
      if (orderBy?.createdAt === "asc") {
        return { id: "oldest-key" };
      }

      if (orderBy?.createdAt === "desc") {
        return { id: "newest-key" };
      }

      throw new Error(`Unexpected orderBy: ${JSON.stringify(orderBy)}`);
    });

    createMock.mockImplementation(async ({ data }) => ({
      id: "sync-token-1",
      name: data.name,
      syncApiKey: data.syncApiKey,
      createdAt: new Date("2026-04-18T12:00:00.000Z"),
    }));
  });

  it("binds newly created sync tokens to the newest API key", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost/api/config-sync/tokens", { method: "POST" }),
    );

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        name: "Default",
        tokenHash: "hashed-sync-token",
        syncApiKey: "newest-key",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "sync-token-1",
      token: "plain-sync-token",
      name: "Default",
      syncApiKeyId: "newest-key",
      createdAt: "2026-04-18T12:00:00.000Z",
    });
  });
});
