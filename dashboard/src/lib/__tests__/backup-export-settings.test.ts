import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  prisma: {
    systemSetting: { findMany: vi.fn() },
    modelPreference: { findMany: vi.fn() },
    agentModelOverride: { findMany: vi.fn() },
  },
}));

describe("exportSettingsBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports settings with username references", async () => {
    const { prisma } = await import("@/lib/db");
    (prisma.systemSetting.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: "telegram_bot_token", value: "secret" },
    ]);
    (prisma.modelPreference.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user: { username: "alice" }, excludedModels: ["gpt-4.1"] },
    ]);
    (prisma.agentModelOverride.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user: { username: "bob" }, overrides: { enabled: true }, slimOverrides: { mode: "slim" } },
    ]);

    const { exportSettingsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");
    const result = await exportSettingsBackup();

    expect(result.type).toBe(BACKUP_TYPE.SETTINGS);
    expect(result.version).toBe(BACKUP_VERSION);
    expect(result.payload.modelPreferences[0]).toEqual({
      username: "alice",
      excludedModels: ["gpt-4.1"],
    });
    expect(result.payload.agentModelOverrides[0].username).toBe("bob");
  });
});
