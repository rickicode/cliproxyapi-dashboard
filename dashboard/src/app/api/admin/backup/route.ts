import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";
import {
  BACKUP_TYPE,
  exportProviderCredentialsBackup,
  exportSettingsBackup,
} from "@/lib/backup";
import { prisma } from "@/lib/db";
import { Errors, apiSuccess } from "@/lib/errors";
import { BackupTypeSchema } from "@/lib/validation/backup";

function normalizeBackupQueryType(value: string | null): string | null {
  if (value === BACKUP_TYPE.SETTINGS) {
    return BACKUP_TYPE.SETTINGS;
  }

  if (value === BACKUP_TYPE.PROVIDER_CREDENTIALS || value === "provider-credentials") {
    return BACKUP_TYPE.PROVIDER_CREDENTIALS;
  }

  return null;
}

async function requireAdmin(): Promise<{ userId: string; username: string } | NextResponse> {
  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { isAdmin: true },
  });

  if (!user?.isAdmin) {
    return Errors.forbidden();
  }

  return { userId: session.userId, username: session.username };
}

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  try {
    const searchParams = new URL(request.url).searchParams;
    const typeResult = BackupTypeSchema.safeParse(
      normalizeBackupQueryType(searchParams.get("type") ?? searchParams.get("mode"))
    );
    if (!typeResult.success) {
      return Errors.zodValidation(typeResult.error.issues);
    }

    const backup =
      typeResult.data === BACKUP_TYPE.SETTINGS
        ? await exportSettingsBackup()
        : await exportProviderCredentialsBackup();

    const summary =
      backup.type === BACKUP_TYPE.SETTINGS
        ? {
            systemSettings: backup.payload.systemSettings.length,
            modelPreferences: backup.payload.modelPreferences.length,
            agentModelOverrides: backup.payload.agentModelOverrides.length,
          }
        : {
            entries: backup.entries.length,
          };

    logAuditAsync({
      userId: authResult.userId,
      action: AUDIT_ACTION.BACKUP_EXPORTED,
      target: backup.type,
      metadata: {
        mode: backup.type,
        type: backup.type,
        version: backup.version,
        summary,
      },
      ipAddress: extractIpAddress(request),
    });

    return apiSuccess({ backup });
  } catch (error) {
    return Errors.internal("export backup", error);
  }
}
