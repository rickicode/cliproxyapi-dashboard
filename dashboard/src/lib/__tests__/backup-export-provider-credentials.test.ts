import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerOAuthOwnership: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/providers/management-api", () => ({
  MANAGEMENT_BASE_URL: "http://localhost:8317",
  MANAGEMENT_API_KEY: "test-key",
  fetchWithTimeout: vi.fn(),
}));

describe("exportProviderCredentialsBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports provider credential ownership using usernames", async () => {
    const { prisma } = await import("@/lib/db");
    const { fetchWithTimeout } = await import("@/lib/providers/management-api");
    (prisma.providerOAuthOwnership.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        user: { username: "bob" },
        provider: "claude",
        accountName: "bob@example.com",
        accountEmail: "bob@example.com",
      },
    ]);
    (fetchWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('{"type":"codex","refresh_token":"rt","access_token":"at"}'),
    });

    const { exportProviderCredentialsBackup, BACKUP_TYPE } = await import("@/lib/backup");
    const result = await exportProviderCredentialsBackup();

    expect(result.type).toBe(BACKUP_TYPE.PROVIDER_CREDENTIALS);
    expect(result.payload.format).toBe("universal-credentials");
    expect(result.payload.entries[0]).toEqual({
      id: "claude:bob@example.com:1",
      provider: "claude",
      authType: "oauth",
      name: "bob@example.com",
      priority: 1,
      isActive: true,
      accessToken: "at",
      refreshToken: "rt",
      idToken: null,
      expiresAt: null,
      expiresIn: null,
    });
  });

  it("skips when credential download is missing tokens", async () => {
    const { prisma } = await import("@/lib/db");
    const { fetchWithTimeout } = await import("@/lib/providers/management-api");
    (prisma.providerOAuthOwnership.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        user: { username: "bob" },
        provider: "claude",
        accountName: "bob@example.com",
      },
    ]);
    (fetchWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('{"type":"codex"}'),
    });

    const { exportProviderCredentialsBackup } = await import("@/lib/backup/export-provider-credentials");

    const result = await exportProviderCredentialsBackup();
    expect(result.payload.entries).toHaveLength(0);
  });
});
