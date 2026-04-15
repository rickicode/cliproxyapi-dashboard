import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerKeyOwnership: { findMany: vi.fn() },
    providerOAuthOwnership: { findMany: vi.fn() },
  },
}));

describe("exportProviderCredentialsBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports provider credential ownership using usernames", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.providerKeyOwnership.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        user: { username: "alice" },
        provider: "openai",
        keyIdentifier: "default",
        name: "Default",
        keyHash: "a".repeat(64),
      },
    ]);
    (prisma.providerOAuthOwnership.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        user: { username: "bob" },
        provider: "claude",
        accountName: "bob@example.com",
        accountEmail: "bob@example.com",
      },
    ]);

    const { exportProviderCredentialsBackup, BACKUP_TYPE } = await import("@/lib/backup");
    const result = await exportProviderCredentialsBackup();

    expect(result.type).toBe(BACKUP_TYPE.PROVIDER_CREDENTIALS);
    expect(result.payload.providerKeys[0].username).toBe("alice");
    expect(result.payload.providerOAuth[0].username).toBe("bob");
  });
});
