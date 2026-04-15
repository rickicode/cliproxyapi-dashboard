import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";
import {
  BACKUP_TYPE,
  MissingBackupUsersError,
  restoreProviderCredentialsBackup,
  restoreSettingsBackup,
} from "@/lib/backup";
import { prisma } from "@/lib/db";
import { Errors, apiSuccess } from "@/lib/errors";
import { BackupEnvelopeSchema } from "@/lib/validation/backup";

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

export async function POST(request: NextRequest) {
  const authResult = await requireAdmin();
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const originError = validateOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const body = await request.json();
    const result = BackupEnvelopeSchema.safeParse(body);

    if (!result.success) {
      return Errors.zodValidation(result.error.issues);
    }

    const restoreResult =
      result.data.type === BACKUP_TYPE.SETTINGS
        ? await restoreSettingsBackup(result.data)
        : await restoreProviderCredentialsBackup(result.data);

    logAuditAsync({
      userId: authResult.userId,
      action: AUDIT_ACTION.BACKUP_RESTORED,
      target: result.data.type,
      metadata: {
        mode: result.data.type,
        type: result.data.type,
        version: result.data.version,
        summary: restoreResult.summary,
      },
      ipAddress: extractIpAddress(request),
    });

    return apiSuccess({ result: restoreResult });
  } catch (error) {
    if (error instanceof MissingBackupUsersError) {
      return Errors.validation("Backup references usernames that do not exist on the target instance", {
        missingUsernames: error.missingUsernames,
      });
    }

    return Errors.internal("restore backup", error);
  }
}
