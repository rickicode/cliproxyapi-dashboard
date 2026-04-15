import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/audit", () => ({
  AUDIT_ACTION: { BACKUP_EXPORTED: "BACKUP_EXPORTED" },
  extractIpAddress: vi.fn(() => "127.0.0.1"),
  logAuditAsync: vi.fn(),
}));
vi.mock("@/lib/backup", () => ({
  BACKUP_TYPE: { SETTINGS: "settings", PROVIDER_CREDENTIALS: "providerCredentials" },
  BACKUP_VERSION: 1,
  MissingBackupUsersError: class MissingBackupUsersError extends Error {},
  exportSettingsBackup: vi.fn(),
  exportProviderCredentialsBackup: vi.fn(),
  restoreSettingsBackup: vi.fn(),
  restoreProviderCredentialsBackup: vi.fn(),
}));

describe("GET /api/admin/backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    vi.mocked(verifySession).mockResolvedValue(null as never);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/admin/backup?type=settings"));

    expect(response.status).toBe(401);
  });

  it("returns a settings backup for admins", async () => {
    const { verifySession } = await import("@/lib/auth/session");
    const { prisma } = await import("@/lib/db");
    const { exportSettingsBackup } = await import("@/lib/backup");

    vi.mocked(verifySession).mockResolvedValue({ userId: "admin-1", username: "admin" } as never);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isAdmin: true });
    vi.mocked(exportSettingsBackup).mockResolvedValue({
      type: "settings",
      version: 1,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: { systemSettings: [], modelPreferences: [], agentModelOverrides: [] },
    } as never);

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/admin/backup?type=settings"));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.backup.type).toBe("settings");
  });
});
