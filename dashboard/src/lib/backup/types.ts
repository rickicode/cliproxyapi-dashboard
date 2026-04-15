import type { Prisma } from "@/generated/prisma/client";

export const BACKUP_TYPE = {
  SETTINGS: "settings",
  PROVIDER_CREDENTIALS: "providerCredentials",
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
  providerKeys: Array<{
    username: string;
    provider: string;
    keyIdentifier: string;
    name: string;
    keyHash: string;
  }>;
  providerOAuth: Array<{
    username: string;
    provider: string;
    accountName: string;
    accountEmail: string | null;
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

export type ProviderCredentialsBackupEnvelope = BackupEnvelope<
  typeof BACKUP_TYPE.PROVIDER_CREDENTIALS,
  ProviderCredentialsBackupPayload
>;

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
    providerKeys: {
      created: number;
      updated: number;
      skipped: number;
      failed: number;
    };
    providerOAuth: {
      created: number;
      updated: number;
      skipped: number;
      failed: number;
    };
  };
}
