import { vi } from "vitest";
vi.mock("server-only", () => ({}));

import { describe, expect, it } from "vitest";
import { BACKUP_TYPE, BACKUP_VERSION } from "@/lib/backup/types";
import { BackupEnvelopeSchema } from "@/lib/validation/backup";

describe("backup validation", () => {
  it("accepts a valid settings backup envelope", () => {
    const result = BackupEnvelopeSchema.safeParse({
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

    expect(result.success).toBe(true);
  });

  it("accepts universal credentials provider backups with tokens", () => {
    const result = BackupEnvelopeSchema.safeParse({
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
    });

    expect(result.success).toBe(true);
  });

  it("rejects universal credentials provider backups without tokens", () => {
    const result = BackupEnvelopeSchema.safeParse({
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
            accessToken: "",
            refreshToken: null,
            idToken: null,
            expiresAt: null,
            expiresIn: null,
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects envelopes with unsupported versions", () => {
    const result = BackupEnvelopeSchema.safeParse({
      type: BACKUP_TYPE.SETTINGS,
      version: 2,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        systemSettings: [],
        modelPreferences: [],
        agentModelOverrides: [],
      },
    });

    expect(result.success).toBe(false);
  });
});
