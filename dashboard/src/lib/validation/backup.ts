import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { BACKUP_FORMAT, BACKUP_SOURCE_APP, BACKUP_TYPE, BACKUP_VERSION } from "@/lib/backup/types";

const UsernameReferenceSchema = z.string().min(1).max(255);
const JsonSchema: z.ZodType<Prisma.JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ])
);

export const BackupTypeSchema = z.enum([
  BACKUP_TYPE.SETTINGS,
  BACKUP_TYPE.PROVIDER_CREDENTIALS,
]);

export const SettingsBackupPayloadSchema = z.object({
  systemSettings: z.array(
    z.object({
      key: z.string().min(1).max(255),
      value: z.string().max(10_000),
    })
  ),
  modelPreferences: z.array(
    z.object({
      username: UsernameReferenceSchema,
      excludedModels: z.array(z.string().min(1).max(200)).max(500),
    })
  ),
  agentModelOverrides: z.array(
    z.object({
      username: UsernameReferenceSchema,
      overrides: JsonSchema,
      slimOverrides: JsonSchema,
    })
  ),
});

export const ProviderCredentialsBackupPayloadSchema = z.object({
  format: z.literal(BACKUP_FORMAT.UNIVERSAL_CREDENTIALS),
  exportedAt: z.string().datetime(),
  entries: z.array(
    z.object({
      id: z.string().min(1).max(255),
      provider: z.string().min(1).max(255),
      authType: z.string().min(1).max(255),
      name: z.string().min(1).max(255),
      priority: z.number().int(),
      isActive: z.boolean(),
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      idToken: z.string().nullable(),
      expiresAt: z.string().datetime().nullable(),
      expiresIn: z.number().int().nullable(),
    }).passthrough()
  ),
});

const BackupEnvelopeBaseSchema = z.object({
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string().datetime(),
  sourceApp: z.string().min(1).max(255).default(BACKUP_SOURCE_APP),
});

export const SettingsBackupEnvelopeSchema = BackupEnvelopeBaseSchema.extend({
  type: z.literal(BACKUP_TYPE.SETTINGS),
  payload: SettingsBackupPayloadSchema,
});

export const ProviderCredentialsBackupEnvelopeSchema = BackupEnvelopeBaseSchema.extend({
  type: z.literal(BACKUP_TYPE.PROVIDER_CREDENTIALS),
  payload: ProviderCredentialsBackupPayloadSchema,
});

export const BackupEnvelopeSchema = z.discriminatedUnion("type", [
  SettingsBackupEnvelopeSchema,
  ProviderCredentialsBackupEnvelopeSchema,
]);

export type BackupEnvelopeInput = z.infer<typeof BackupEnvelopeSchema>;
