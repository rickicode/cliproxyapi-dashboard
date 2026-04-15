import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

describe("restoreSettingsBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails fast when referenced usernames are missing", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { restoreSettingsBackup, BACKUP_TYPE, BACKUP_VERSION, MissingBackupUsersError } = await import("@/lib/backup");

    await expect(
      restoreSettingsBackup({
        type: BACKUP_TYPE.SETTINGS,
        version: BACKUP_VERSION,
        exportedAt: "2026-04-14T12:00:00.000Z",
        sourceApp: "cliproxyapi-dashboard",
        payload: {
          systemSettings: [],
          modelPreferences: [{ username: "missing", excludedModels: [] }],
          agentModelOverrides: [],
        },
      })
    ).rejects.toBeInstanceOf(MissingBackupUsersError);
  });

  it("replaces the supported settings domain", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "user-1", username: "alice" }]);

    const deleteMany = vi.fn();
    const createMany = vi.fn();
    const create = vi.fn();
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        agentModelOverride: { deleteMany, create },
        modelPreference: { deleteMany, createMany },
        systemSetting: { deleteMany, createMany },
      })
    );

    const { restoreSettingsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreSettingsBackup({
      type: BACKUP_TYPE.SETTINGS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        systemSettings: [{ key: "telegram_bot_token", value: "secret" }],
        modelPreferences: [{ username: "alice", excludedModels: ["gpt-4.1"] }],
        agentModelOverrides: [{ username: "alice", overrides: { foo: true }, slimOverrides: {} }],
      },
    });

    expect(deleteMany).toHaveBeenCalled();
    expect(createMany).toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
    expect(result.summary).toEqual({
      systemSettings: 1,
      modelPreferences: 1,
      agentModelOverrides: 1,
      replacedDomains: ["systemSettings", "modelPreferences", "agentModelOverrides"],
    });
  });

  it("returns replaced domains even when backup payload is empty", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const deleteMany = vi.fn();
    const createMany = vi.fn();
    const create = vi.fn();
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        agentModelOverride: { deleteMany, create },
        modelPreference: { deleteMany, createMany },
        systemSetting: { deleteMany, createMany },
      })
    );

    const { restoreSettingsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await restoreSettingsBackup({
      type: BACKUP_TYPE.SETTINGS,
      version: BACKUP_VERSION,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        systemSettings: [],
        modelPreferences: [],
        agentModelOverrides: [],
      },
    });

    expect(deleteMany).toHaveBeenCalled();
    expect(result.summary.replacedDomains).toEqual([
      "systemSettings",
      "modelPreferences",
      "agentModelOverrides",
    ]);
  });
});
