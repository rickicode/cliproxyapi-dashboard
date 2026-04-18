import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn() },
    providerKeyOwnership: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    providerOAuthOwnership: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

describe("restoreProviderCredentialsBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips conflicting ownership and does not reassign existing records", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "user-1", username: "alice" },
      { id: "user-2", username: "bob" },
    ]);
    (prisma.providerKeyOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pk-1",
      userId: "user-2",
      provider: "openai",
      keyIdentifier: "default",
      name: "Default",
      keyHash: "a".repeat(64),
    });
    (prisma.providerOAuthOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "oauth-1",
      userId: "user-2",
      provider: "claude",
      accountName: "alice@example.com",
      accountEmail: "alice@example.com",
    });

    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeys: [
          {
            username: "alice",
            provider: "openai",
            keyIdentifier: "default",
            name: "Default",
            keyHash: "a".repeat(64),
          },
        ],
        providerOAuth: [
          {
            username: "alice",
            provider: "claude",
            accountName: "alice@example.com",
            accountEmail: "alice@example.com",
          },
        ],
      },
    });

    expect(prisma.providerKeyOwnership.create).not.toHaveBeenCalled();
    expect(prisma.providerKeyOwnership.update).not.toHaveBeenCalled();
    expect(prisma.providerOAuthOwnership.create).not.toHaveBeenCalled();
    expect(prisma.providerOAuthOwnership.update).not.toHaveBeenCalled();
    expect(result.summary).toEqual({
      providerKeys: { created: 0, updated: 0, skipped: 1, failed: 0 },
      providerOAuth: { created: 0, updated: 0, skipped: 1, failed: 0 },
    });
  });

  it("updates same-owner existing credentials when payload differs", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "user-1", username: "alice" }]);
    (prisma.providerKeyOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pk-1",
      userId: "user-1",
      provider: "openai",
      keyIdentifier: "old-default",
      name: "Old Name",
      keyHash: "a".repeat(64),
    });
    (prisma.providerOAuthOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "oauth-1",
      userId: "user-1",
      provider: "claude",
      accountName: "alice@example.com",
      accountEmail: "old@example.com",
    });

    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeys: [
          {
            username: "alice",
            provider: "openai",
            keyIdentifier: "default",
            name: "Default",
            keyHash: "a".repeat(64),
          },
        ],
        providerOAuth: [
          {
            username: "alice",
            provider: "anthropic",
            accountName: "alice@example.com",
            accountEmail: "alice@example.com",
          },
        ],
      },
    });

    expect(prisma.providerKeyOwnership.update).toHaveBeenCalledWith({
      where: { id: "pk-1" },
      data: {
        provider: "openai",
        keyIdentifier: "default",
        name: "Default",
      },
    });
    expect(prisma.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "oauth-1" },
      data: {
        provider: "claude",
        accountEmail: "alice@example.com",
      },
    });
    expect(result.summary).toEqual({
      providerKeys: { created: 0, updated: 1, skipped: 0, failed: 0 },
      providerOAuth: { created: 0, updated: 1, skipped: 0, failed: 0 },
    });
  });

  it("creates new credentials and counts unknown usernames as failures", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "user-1", username: "alice" }]);
    (prisma.providerKeyOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.providerOAuthOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeys: [
          {
            username: "alice",
            provider: "openai",
            keyIdentifier: "default",
            name: "Default",
            keyHash: "a".repeat(64),
          },
          {
            username: "missing",
            provider: "openai",
            keyIdentifier: "secondary",
            name: "Secondary",
            keyHash: "b".repeat(64),
          },
        ],
        providerOAuth: [
          {
            username: "alice",
            provider: "claude",
            accountName: "alice@example.com",
            accountEmail: "alice@example.com",
          },
          {
            username: "missing",
            provider: "claude",
            accountName: "missing@example.com",
            accountEmail: "missing@example.com",
          },
        ],
      },
    });

    expect(prisma.providerKeyOwnership.create).toHaveBeenCalledTimes(1);
    expect(prisma.providerOAuthOwnership.create).toHaveBeenCalledTimes(1);
    expect(result.summary).toEqual({
      providerKeys: { created: 1, updated: 0, skipped: 0, failed: 1 },
      providerOAuth: { created: 1, updated: 0, skipped: 0, failed: 1 },
    });
  });

  it("creates a provider-scoped OAuth ownership when another provider already uses the same account name", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "user-1", username: "alice" }]);
    (prisma.providerKeyOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.providerOAuthOwnership.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "oauth-gemini-1",
        userId: "user-9",
        provider: "gemini",
        accountName: "shared@example.com",
        accountEmail: "shared@example.com",
      })
      .mockResolvedValueOnce(null);

    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeys: [],
        providerOAuth: [
          {
            username: "alice",
            provider: "gemini",
            accountName: "shared@example.com",
            accountEmail: "shared@example.com",
          },
          {
            username: "alice",
            provider: "claude",
            accountName: "shared@example.com",
            accountEmail: "shared@example.com",
          },
        ],
      },
    });

    expect(prisma.providerOAuthOwnership.findUnique).toHaveBeenNthCalledWith(1, {
      where: {
        provider_accountName: {
          provider: "gemini-cli",
          accountName: "shared@example.com",
        },
      },
    });
    expect(prisma.providerOAuthOwnership.findUnique).toHaveBeenNthCalledWith(2, {
      where: {
        provider_accountName: {
          provider: "claude",
          accountName: "shared@example.com",
        },
      },
    });
    expect(prisma.providerOAuthOwnership.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "claude",
        accountName: "shared@example.com",
        accountEmail: "shared@example.com",
      },
    });
    expect(result.summary).toEqual({
      providerKeys: { created: 0, updated: 0, skipped: 0, failed: 0 },
      providerOAuth: { created: 1, updated: 0, skipped: 1, failed: 0 },
    });
  });

  it("normalizes aliased OAuth providers before provider/account lookup and update decisions", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "user-1", username: "alice" }]);
    (prisma.providerOAuthOwnership.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "oauth-1",
      userId: "user-1",
      provider: "claude",
      accountName: "alice@example.com",
      accountEmail: "old@example.com",
    });

    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeys: [],
        providerOAuth: [
          {
            username: "alice",
            provider: "anthropic",
            accountName: "alice@example.com",
            accountEmail: "alice@example.com",
          },
        ],
      },
    });

    expect(prisma.providerOAuthOwnership.findUnique).toHaveBeenCalledWith({
      where: {
        provider_accountName: {
          provider: "claude",
          accountName: "alice@example.com",
        },
      },
    });
    expect(prisma.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "oauth-1" },
      data: {
        provider: "claude",
        accountEmail: "alice@example.com",
      },
    });
    expect(result.summary).toEqual({
      providerKeys: { created: 0, updated: 0, skipped: 0, failed: 0 },
      providerOAuth: { created: 0, updated: 1, skipped: 0, failed: 0 },
    });
  });

  it("normalizes mixed-case OAuth emails before create and update", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "user-1", username: "alice" }]);
    (prisma.providerOAuthOwnership.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "oauth-1",
        userId: "user-1",
        provider: "claude",
        accountName: "existing@example.com",
        accountEmail: "old@example.com",
      });

    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeys: [],
        providerOAuth: [
          {
            username: "alice",
            provider: "claude",
            accountName: "new@example.com",
            accountEmail: "  Alice@Example.COM  ",
          },
          {
            username: "alice",
            provider: "claude",
            accountName: "existing@example.com",
            accountEmail: "  Updated@Example.COM  ",
          },
        ],
      },
    });

    expect(prisma.providerOAuthOwnership.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        provider: "claude",
        accountName: "new@example.com",
        accountEmail: "alice@example.com",
      },
    });
    expect(prisma.providerOAuthOwnership.update).toHaveBeenCalledWith({
      where: { id: "oauth-1" },
      data: {
        provider: "claude",
        accountEmail: "updated@example.com",
      },
    });
    expect(result.summary).toEqual({
      providerKeys: { created: 0, updated: 0, skipped: 0, failed: 0 },
      providerOAuth: { created: 1, updated: 1, skipped: 0, failed: 0 },
    });
  });
});
