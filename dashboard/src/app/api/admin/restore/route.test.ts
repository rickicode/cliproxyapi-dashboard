import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn() }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: vi.fn(() => null) }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: { BACKUP_RESTORED: "BACKUP_RESTORED" },
  extractIpAddress: vi.fn(() => "127.0.0.1"),
  logAuditAsync: vi.fn(),
}));
vi.mock("@/lib/backup", () => ({
  BACKUP_TYPE: { SETTINGS: "settings", PROVIDER_CREDENTIALS: "providerCredentials" },
  BACKUP_VERSION: 1,
  MissingBackupUsersError: class MissingBackupUsersError extends Error {
    missingUsernames: string[];

    constructor(missingUsernames: string[]) {
      super("Missing required users");
      this.missingUsernames = missingUsernames;
    }
  },
  restoreSettingsBackup: vi.fn(),
  restoreProviderCredentialsBackup: vi.fn(),
}));

describe("POST /api/admin/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for non-admin users", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    const { prisma } = await import("@/lib/db");
    vi.mocked(verifySession).mockResolvedValue({ userId: "user-1", username: "user" } as never);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isAdmin: false });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/admin/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(403);
  });

  it("restores a settings backup for admins", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    const { prisma } = await import("@/lib/db");
    const { restoreSettingsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");

    vi.mocked(verifySession).mockResolvedValue({ userId: "admin-1", username: "admin" } as never);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isAdmin: true });
    vi.mocked(restoreSettingsBackup).mockResolvedValue({
      type: BACKUP_TYPE.SETTINGS,
      version: BACKUP_VERSION,
      summary: {
        systemSettings: 1,
        modelPreferences: 0,
        agentModelOverrides: 0,
        replacedDomains: ["systemSettings", "modelPreferences", "agentModelOverrides"],
      },
    } as never);

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/admin/restore", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          type: BACKUP_TYPE.SETTINGS,
          version: BACKUP_VERSION,
          exportedAt: "2026-04-14T12:00:00.000Z",
          sourceApp: "cliproxyapi-dashboard",
          payload: {
            systemSettings: [{ key: "telegram_bot_token", value: "secret" }],
            modelPreferences: [],
            agentModelOverrides: [],
          },
        }),
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.result.type).toBe(BACKUP_TYPE.SETTINGS);
    expect(data.result.summary.replacedDomains).toEqual([
      "systemSettings",
      "modelPreferences",
      "agentModelOverrides",
    ]);
  });

  it("returns provider credential counters without remapping", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    const { prisma } = await import("@/lib/db");
    const { restoreProviderCredentialsBackup, BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup");

    vi.mocked(verifySession).mockResolvedValue({ userId: "admin-1", username: "admin" } as never);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isAdmin: true });
    vi.mocked(restoreProviderCredentialsBackup).mockResolvedValue({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      summary: {
        entries: { restored: 1, skipped: 2, failed: 3 },
      },
    } as never);

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/admin/restore", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({
          type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
          version: BACKUP_VERSION,
          exportedAt: "2026-04-14T12:00:00.000Z",
          sourceApp: "cliproxyapi-dashboard",
          payload: {
            format: "universal-credentials",
            exportedAt: "2026-04-14T12:00:00.000Z",
            entries: [
              {
                id: "codex:alice@example.com:1",
                provider: "codex",
                authType: "oauth",
                name: "alice@example.com",
                priority: 1,
                isActive: true,
                accessToken: "at",
                refreshToken: "rt",
                idToken: null,
                expiresAt: null,
                expiresIn: null,
              },
            ],
          },
        }),
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.result.summary).toEqual({
      entries: { restored: 1, skipped: 2, failed: 3 },
    });
  });
});
