import type { Prisma } from "@/generated/prisma/client";

export const BACKUP_TYPE = {
  SETTINGS: "settings",
  PROVIDER_CREDENTIALS: "providerCredentials",
} as const;

export const BACKUP_FORMAT = {
  UNIVERSAL_CREDENTIALS: "universal-credentials",
} as const;

export const BACKUP_VERSION = 1 as const;
export const BACKUP_SOURCE_APP = "cliproxyapi-dashboard" as const;

export type BackupType = (typeof BACKUP_TYPE)[keyof typeof BACKUP_TYPE];

export interface SettingsBackupPayload {
  systemSettings: Array<{
    key: string;
    value: string;
  }>;
  modelPreferences: Array<{
    username: string;
    excludedModels: string[];
  }>;
  agentModelOverrides: Array<{
    username: string;
    overrides: Prisma.JsonValue;
    slimOverrides: Prisma.JsonValue;
  }>;
}

export interface ProviderCredentialsBackupPayload {
  type: typeof BACKUP_TYPE.PROVIDER_CREDENTIALS;
  version: typeof BACKUP_VERSION;
  format: typeof BACKUP_FORMAT.UNIVERSAL_CREDENTIALS;
  exportedAt: string;
  sourceApp: string;
  entries: Array<UniversalCredentialEntry>;
}

export interface UniversalCredentialEntry extends Record<string, unknown> {
  id: string;
  provider: string;
  authType: string;
  name: string;
  priority: number;
  isActive: boolean;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: string | null;
  expiresIn: number | null;
}

export interface LegacyBackupInfo {
  isLegacy: boolean;
  reason: string | null;
  format?: string;
  exportedAt?: string;
  entries?: Array<UniversalCredentialEntry>;
  providerOAuth?: Array<{
    username: string;
    provider: string;
    accountName: string;
    accountEmail: string | null;
    credentialContent?: Record<string, unknown>;
  }>;
}

export interface BackupEnvelope<TType extends BackupType, TPayload> {
  type: TType;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  sourceApp: string;
  payload: TPayload;
}

export type SettingsBackupEnvelope = BackupEnvelope<
  typeof BACKUP_TYPE.SETTINGS,
  SettingsBackupPayload
>;

export type ProviderCredentialsBackupEnvelope = ProviderCredentialsBackupPayload;

export type AnyBackupEnvelope =
  | SettingsBackupEnvelope
  | ProviderCredentialsBackupEnvelope;

export interface RestoreSettingsResult {
  type: typeof BACKUP_TYPE.SETTINGS;
  version: typeof BACKUP_VERSION;
  summary: {
    systemSettings: number;
    modelPreferences: number;
    agentModelOverrides: number;
    replacedDomains: Array<"systemSettings" | "modelPreferences" | "agentModelOverrides">;
  };
}

export interface RestoreProviderCredentialsResult {
  type: typeof BACKUP_TYPE.PROVIDER_CREDENTIALS;
  version: typeof BACKUP_VERSION;
  summary: {
    entries: {
      restored: number;
      skipped: number;
      failed: number;
    };
  };
}
