import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { SettingsBackupEnvelope, RestoreSettingsResult } from "@/lib/backup/types";
import { BACKUP_TYPE, BACKUP_VERSION } from "@/lib/backup/types";
import { findMissingUsernames, getUserIdMapByUsername } from "@/lib/backup/user-mapping";

const SETTINGS_REPLACED_DOMAINS = [
  "systemSettings",
  "modelPreferences",
  "agentModelOverrides",
] as const;

export class MissingBackupUsersError extends Error {
  missingUsernames: string[];

  constructor(missingUsernames: string[]) {
    super(`Missing required users: ${missingUsernames.join(", ")}`);
    this.name = "MissingBackupUsersError";
    this.missingUsernames = missingUsernames;
  }
}

function toInputJson(value: Prisma.JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function restoreSettingsBackup(
  backup: SettingsBackupEnvelope
): Promise<RestoreSettingsResult> {
  const referencedUsernames = [
    ...backup.payload.modelPreferences.map((item) => item.username),
    ...backup.payload.agentModelOverrides.map((item) => item.username),
  ];

  const userIdMap = await getUserIdMapByUsername(referencedUsernames);
  const missingUsernames = findMissingUsernames(referencedUsernames, userIdMap);

  if (missingUsernames.length > 0) {
    throw new MissingBackupUsersError(missingUsernames);
  }

  await prisma.$transaction(async (tx) => {
    await tx.agentModelOverride.deleteMany({});
    await tx.modelPreference.deleteMany({});
    await tx.systemSetting.deleteMany({});

    if (backup.payload.systemSettings.length > 0) {
      await tx.systemSetting.createMany({ data: backup.payload.systemSettings });
    }

    if (backup.payload.modelPreferences.length > 0) {
      await tx.modelPreference.createMany({
        data: backup.payload.modelPreferences.map((item) => ({
          userId: userIdMap.get(item.username)!,
          excludedModels: item.excludedModels,
        })),
      });
    }

    for (const item of backup.payload.agentModelOverrides) {
      await tx.agentModelOverride.create({
        data: {
          userId: userIdMap.get(item.username)!,
          overrides: toInputJson(item.overrides),
          slimOverrides: toInputJson(item.slimOverrides),
        },
      });
    }
  });

  return {
    type: BACKUP_TYPE.SETTINGS,
    version: BACKUP_VERSION,
    summary: {
      systemSettings: backup.payload.systemSettings.length,
      modelPreferences: backup.payload.modelPreferences.length,
      agentModelOverrides: backup.payload.agentModelOverrides.length,
      replacedDomains: [...SETTINGS_REPLACED_DOMAINS],
    },
  };
}
