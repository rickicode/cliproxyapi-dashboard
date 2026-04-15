import "server-only";
import { prisma } from "@/lib/db";
import {
  BACKUP_SOURCE_APP,
  BACKUP_TYPE,
  BACKUP_VERSION,
  type SettingsBackupEnvelope,
} from "@/lib/backup/types";

export async function exportSettingsBackup(): Promise<SettingsBackupEnvelope> {
  const [systemSettings, modelPreferences, agentModelOverrides] = await Promise.all([
    prisma.systemSetting.findMany({
      select: { key: true, value: true },
      orderBy: { key: "asc" },
    }),
    prisma.modelPreference.findMany({
      select: {
        excludedModels: true,
        user: { select: { username: true } },
      },
      orderBy: { user: { username: "asc" } },
    }),
    prisma.agentModelOverride.findMany({
      select: {
        overrides: true,
        slimOverrides: true,
        user: { select: { username: true } },
      },
      orderBy: { user: { username: "asc" } },
    }),
  ]);

  return {
    type: BACKUP_TYPE.SETTINGS,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceApp: BACKUP_SOURCE_APP,
    payload: {
      systemSettings,
      modelPreferences: modelPreferences.map((item) => ({
        username: item.user.username,
        excludedModels: item.excludedModels,
      })),
      agentModelOverrides: agentModelOverrides.map((item) => ({
        username: item.user.username,
        overrides: item.overrides,
        slimOverrides: item.slimOverrides,
      })),
    },
  };
}
