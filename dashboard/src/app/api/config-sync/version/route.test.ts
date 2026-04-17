import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-chars";
process.env.MANAGEMENT_API_KEY ??= "test-management-key-1234";

const validateSyncTokenFromHeaderMock = vi.fn();
const generateConfigBundleMock = vi.fn();

vi.mock("@/lib/auth/sync-token", () => ({
  validateSyncTokenFromHeader: validateSyncTokenFromHeaderMock,
}));

vi.mock("@/lib/config-sync/generate-bundle", () => ({
  generateConfigBundle: generateConfigBundleMock,
}));

describe("GET /api/config-sync/version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("passes authResult.syncApiKey through to generateConfigBundle", async () => {
    validateSyncTokenFromHeaderMock.mockResolvedValue({
      ok: true,
      userId: "user-1",
      syncApiKey: "sync-key-123",
    });
    generateConfigBundleMock.mockResolvedValue({ version: "bundle-version-1" });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/config-sync/version"));

    expect(generateConfigBundleMock).toHaveBeenCalledWith("user-1", "sync-key-123");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version: "bundle-version-1" });
  });

  it("returns the existing internal-error response when the assigned sync key was deleted", async () => {
    validateSyncTokenFromHeaderMock.mockResolvedValue({
      ok: true,
      userId: "user-1",
      syncApiKey: "deleted-sync-key",
    });
    generateConfigBundleMock.mockRejectedValue(new Error("Assigned sync API key not found"));

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/config-sync/version"));

    expect(generateConfigBundleMock).toHaveBeenCalledWith("user-1", "deleted-sync-key");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      },
    });
  });
});
