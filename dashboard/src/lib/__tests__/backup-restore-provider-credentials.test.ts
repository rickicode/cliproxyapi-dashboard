import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/providers/management-api", () => ({
  MANAGEMENT_BASE_URL: "http://localhost:8317",
  MANAGEMENT_API_KEY: "test-key",
  fetchWithTimeout: vi.fn(),
}));

describe("restoreProviderCredentialsBackup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores oauth entries back to upstream auth-files", async () => {
    const { fetchWithTimeout } = await import("@/lib/providers/management-api");
    (fetchWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const { restoreProviderCredentialsBackup } = await import("@/lib/backup/restore-provider-credentials");
    const { BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup/types");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      format: "universal-credentials",
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
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
    });

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      "http://localhost:8317/auth-files?name=alice%40example.com&provider=codex",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(result.summary.entries).toEqual({ restored: 1, skipped: 0, failed: 0 });
  });

  it("fails entries missing required tokens", async () => {
    const { fetchWithTimeout } = await import("@/lib/providers/management-api");

    const { restoreProviderCredentialsBackup } = await import("@/lib/backup/restore-provider-credentials");
    const { BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup/types");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      format: "universal-credentials",
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      entries: [
        {
          id: "codex:alice@example.com:1",
          provider: "codex",
          authType: "oauth",
          name: "alice@example.com",
          priority: 1,
          isActive: true,
          accessToken: "",
          refreshToken: "rt",
          idToken: null,
          expiresAt: null,
          expiresIn: null,
        },
      ],
    });

    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(result.summary.entries).toEqual({ restored: 0, skipped: 0, failed: 1 });
  });

  it("skips non-oauth entries", async () => {
    const { fetchWithTimeout } = await import("@/lib/providers/management-api");

    const { restoreProviderCredentialsBackup } = await import("@/lib/backup/restore-provider-credentials");
    const { BACKUP_TYPE, BACKUP_VERSION } = await import("@/lib/backup/types");
    const result = await restoreProviderCredentialsBackup({
      type: BACKUP_TYPE.PROVIDER_CREDENTIALS,
      version: BACKUP_VERSION,
      format: "universal-credentials",
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      entries: [
        {
          id: "api-key:1",
          provider: "openai",
          authType: "api-key",
          name: "default",
          priority: 1,
          isActive: true,
          accessToken: null,
          refreshToken: null,
          idToken: null,
          expiresAt: null,
          expiresIn: null,
        },
      ],
    });

    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(result.summary.entries).toEqual({ restored: 0, skipped: 1, failed: 0 });
  });
});
