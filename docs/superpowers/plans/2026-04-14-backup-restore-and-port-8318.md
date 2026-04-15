# Backup Restore and Port 8318 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-only backup/restore for dashboard settings and provider credentials (with mode-specific restore semantics) and change local/dashboard default port from 3000 to 8318.

**Architecture:** Implement thin admin API routes for export/restore that delegate to typed backup services in `src/lib/backup`. Add a dedicated admin UI page with four action cards and strict mode/type validation. Use JSON versioned backup formats with username-based portability. Apply port changes consistently across compose/dev scripts/docs while preserving internal service port behavior where required.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma, Zod, Vitest, Playwright

---

### Task 1: Add backup domain types and validation schemas

**Files:**
- Create: `dashboard/src/lib/backup/types.ts`
- Create: `dashboard/src/lib/validation/backup.ts`
- Create: `dashboard/src/lib/__tests__/backup-validation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  BackupModeQuerySchema,
  SettingsBackupSchema,
  ProviderCredentialsBackupSchema,
  RestoreBackupRequestSchema,
} from "@/lib/validation/backup";

describe("backup validation", () => {
  it("accepts settings backup payload v1", () => {
    const parsed = SettingsBackupSchema.safeParse({
      type: "dashboard-settings-backup",
      version: 1,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        systemSettings: [],
        customProviders: [],
        providerGroups: [],
        customProviderModels: [],
        customProviderExcludedModels: [],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts provider credentials backup payload v1", () => {
    const parsed = ProviderCredentialsBackupSchema.safeParse({
      type: "provider-credentials-backup",
      version: 1,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: {
        providerKeyOwnership: [],
        providerOAuthOwnership: [],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown backup mode query", () => {
    const parsed = BackupModeQuerySchema.safeParse({ mode: "all" });
    expect(parsed.success).toBe(false);
  });

  it("accepts restore wrapper with backup object", () => {
    const parsed = RestoreBackupRequestSchema.safeParse({ backup: { type: "dashboard-settings-backup", version: 1 } });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-validation.test.ts`
Expected: FAIL because `validation/backup.ts` and backup schemas do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/lib/backup/types.ts
export type BackupMode = "settings" | "provider-credentials";

export interface SettingsBackup {
  type: "dashboard-settings-backup";
  version: 1;
  exportedAt: string;
  sourceApp: "cliproxyapi-dashboard";
  payload: {
    systemSettings: Array<{ key: string; value: string }>;
    customProviders: Array<Record<string, unknown>>;
    providerGroups: Array<Record<string, unknown>>;
    customProviderModels: Array<Record<string, unknown>>;
    customProviderExcludedModels: Array<Record<string, unknown>>;
  };
}

export interface ProviderCredentialsBackup {
  type: "provider-credentials-backup";
  version: 1;
  exportedAt: string;
  sourceApp: "cliproxyapi-dashboard";
  payload: {
    providerKeyOwnership: Array<Record<string, unknown>>;
    providerOAuthOwnership: Array<Record<string, unknown>>;
  };
}

// dashboard/src/lib/validation/backup.ts
import { z } from "zod";

export const BackupModeQuerySchema = z.object({
  mode: z.enum(["settings", "provider-credentials"]),
});

const BaseBackupSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  sourceApp: z.literal("cliproxyapi-dashboard"),
});

export const SettingsBackupSchema = BaseBackupSchema.extend({
  type: z.literal("dashboard-settings-backup"),
  payload: z.object({
    systemSettings: z.array(z.object({ key: z.string(), value: z.string() })),
    customProviders: z.array(z.record(z.string(), z.unknown())),
    providerGroups: z.array(z.record(z.string(), z.unknown())),
    customProviderModels: z.array(z.record(z.string(), z.unknown())),
    customProviderExcludedModels: z.array(z.record(z.string(), z.unknown())),
  }),
});

export const ProviderCredentialsBackupSchema = BaseBackupSchema.extend({
  type: z.literal("provider-credentials-backup"),
  payload: z.object({
    providerKeyOwnership: z.array(z.record(z.string(), z.unknown())),
    providerOAuthOwnership: z.array(z.record(z.string(), z.unknown())),
  }),
});

export const AnyBackupSchema = z.discriminatedUnion("type", [
  SettingsBackupSchema,
  ProviderCredentialsBackupSchema,
]);

export const RestoreBackupRequestSchema = z.object({
  backup: z.unknown(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/backup/types.ts dashboard/src/lib/validation/backup.ts dashboard/src/lib/__tests__/backup-validation.test.ts
git commit -m "feat(backup): add backup schemas and domain types"
```

### Task 2: Implement backup export services and tests

**Files:**
- Create: `dashboard/src/lib/backup/export-settings.ts`
- Create: `dashboard/src/lib/backup/export-provider-credentials.ts`
- Create: `dashboard/src/lib/backup/index.ts`
- Create: `dashboard/src/lib/__tests__/backup-export-settings.test.ts`
- Create: `dashboard/src/lib/__tests__/backup-export-provider-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    systemSetting: { findMany: vi.fn().mockResolvedValue([{ key: "k", value: "v" }]) },
    customProvider: { findMany: vi.fn().mockResolvedValue([]) },
    providerGroup: { findMany: vi.fn().mockResolvedValue([]) },
    customProviderModel: { findMany: vi.fn().mockResolvedValue([]) },
    customProviderExcludedModel: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { exportSettingsBackup } from "@/lib/backup/export-settings";

describe("exportSettingsBackup", () => {
  it("returns settings backup envelope", async () => {
    const result = await exportSettingsBackup();
    expect(result.backup.type).toBe("dashboard-settings-backup");
    expect(result.backup.version).toBe(1);
    expect(result.fileName).toContain("dashboard-settings-backup");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-export-settings.test.ts src/lib/__tests__/backup-export-provider-credentials.test.ts`
Expected: FAIL because export service files do not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/lib/backup/export-settings.ts
import { prisma } from "@/lib/db";

export async function exportSettingsBackup() {
  const [systemSettings, customProviders, providerGroups, customProviderModels, customProviderExcludedModels] = await Promise.all([
    prisma.systemSetting.findMany({ orderBy: { key: "asc" } }),
    prisma.customProvider.findMany(),
    prisma.providerGroup.findMany(),
    prisma.customProviderModel.findMany(),
    prisma.customProviderExcludedModel.findMany(),
  ]);

  const backup = {
    type: "dashboard-settings-backup" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    sourceApp: "cliproxyapi-dashboard" as const,
    payload: { systemSettings, customProviders, providerGroups, customProviderModels, customProviderExcludedModels },
  };

  return { fileName: `dashboard-settings-backup-${new Date().toISOString()}.json`, backup };
}

// dashboard/src/lib/backup/export-provider-credentials.ts
import { prisma } from "@/lib/db";

export async function exportProviderCredentialsBackup() {
  const [providerKeyOwnership, providerOAuthOwnership] = await Promise.all([
    prisma.providerKeyOwnership.findMany(),
    prisma.providerOAuthOwnership.findMany(),
  ]);

  const backup = {
    type: "provider-credentials-backup" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    sourceApp: "cliproxyapi-dashboard" as const,
    payload: { providerKeyOwnership, providerOAuthOwnership },
  };

  return { fileName: `provider-credentials-backup-${new Date().toISOString()}.json`, backup };
}

// dashboard/src/lib/backup/index.ts
export * from "./types";
export * from "./export-settings";
export * from "./export-provider-credentials";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-export-settings.test.ts src/lib/__tests__/backup-export-provider-credentials.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/backup/export-settings.ts dashboard/src/lib/backup/export-provider-credentials.ts dashboard/src/lib/backup/index.ts dashboard/src/lib/__tests__/backup-export-settings.test.ts dashboard/src/lib/__tests__/backup-export-provider-credentials.test.ts
git commit -m "feat(backup): add export services for settings and provider credentials"
```

### Task 3: Implement restore services and tests

**Files:**
- Create: `dashboard/src/lib/backup/user-mapping.ts`
- Create: `dashboard/src/lib/backup/restore-settings.ts`
- Create: `dashboard/src/lib/backup/restore-provider-credentials.ts`
- Create: `dashboard/src/lib/__tests__/backup-restore-settings.test.ts`
- Create: `dashboard/src/lib/__tests__/backup-restore-provider-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { restoreProviderCredentialsBackup } from "@/lib/backup/restore-provider-credentials";

describe("restoreProviderCredentialsBackup", () => {
  it("returns merge summary counters", async () => {
    const result = await restoreProviderCredentialsBackup({
      type: "provider-credentials-backup",
      version: 1,
      exportedAt: "2026-04-14T12:00:00.000Z",
      sourceApp: "cliproxyapi-dashboard",
      payload: { providerKeyOwnership: [], providerOAuthOwnership: [] },
    } as any);
    expect(result).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-restore-settings.test.ts src/lib/__tests__/backup-restore-provider-credentials.test.ts`
Expected: FAIL because restore services do not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/lib/backup/user-mapping.ts
import { prisma } from "@/lib/db";

export async function resolveUsernamesOrThrow(usernames: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(usernames.map((u) => u.trim()).filter(Boolean))];
  if (uniq.length === 0) return new Map();

  const users = await prisma.user.findMany({ where: { username: { in: uniq } }, select: { id: true, username: true } });
  const map = new Map(users.map((u) => [u.username, u.id]));
  const missing = uniq.filter((u) => !map.has(u));
  if (missing.length > 0) {
    throw new Error(`Missing users in target system: ${missing.join(", ")}`);
  }
  return map;
}

export async function resolveUsernameOrNull(username: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  return user?.id ?? null;
}

// dashboard/src/lib/backup/restore-settings.ts
import { prisma } from "@/lib/db";
import type { SettingsBackup } from "./types";

export async function restoreSettingsBackup(backup: SettingsBackup): Promise<{ replacedDomains: string[] }> {
  await prisma.$transaction(async (tx) => {
    await tx.customProviderExcludedModel.deleteMany({});
    await tx.customProviderModel.deleteMany({});
    await tx.customProvider.deleteMany({});
    await tx.providerGroup.deleteMany({});
    await tx.systemSetting.deleteMany({});

    if (backup.payload.systemSettings.length) await tx.systemSetting.createMany({ data: backup.payload.systemSettings });
    if (backup.payload.providerGroups.length) await tx.providerGroup.createMany({ data: backup.payload.providerGroups as any });
    if (backup.payload.customProviders.length) await tx.customProvider.createMany({ data: backup.payload.customProviders as any });
    if (backup.payload.customProviderModels.length) await tx.customProviderModel.createMany({ data: backup.payload.customProviderModels as any });
    if (backup.payload.customProviderExcludedModels.length) await tx.customProviderExcludedModel.createMany({ data: backup.payload.customProviderExcludedModels as any });
  });

  return { replacedDomains: ["systemSettings", "providerGroups", "customProviders", "customProviderModels", "customProviderExcludedModels"] };
}

// dashboard/src/lib/backup/restore-provider-credentials.ts
import { prisma } from "@/lib/db";
import type { ProviderCredentialsBackup } from "./types";

export async function restoreProviderCredentialsBackup(
  backup: ProviderCredentialsBackup
): Promise<{ created: number; updated: number; skipped: number; failed: number }> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of backup.payload.providerKeyOwnership) {
    try {
      await prisma.providerKeyOwnership.upsert({
        where: { keyHash: String((item as any).keyHash) },
        create: item as any,
        update: item as any,
      });
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  for (const item of backup.payload.providerOAuthOwnership) {
    try {
      await prisma.providerOAuthOwnership.upsert({
        where: { accountName: String((item as any).accountName) },
        create: item as any,
        update: item as any,
      });
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  return { created, updated, skipped, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-restore-settings.test.ts src/lib/__tests__/backup-restore-provider-credentials.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/backup/user-mapping.ts dashboard/src/lib/backup/restore-settings.ts dashboard/src/lib/backup/restore-provider-credentials.ts dashboard/src/lib/__tests__/backup-restore-settings.test.ts dashboard/src/lib/__tests__/backup-restore-provider-credentials.test.ts
git commit -m "feat(backup): add restore services for settings replace and credential merge"
```

### Task 4: Add admin backup/restore API routes with auth, origin checks, and audit logs

**Files:**
- Modify: `dashboard/src/lib/api-endpoints.ts`
- Modify: `dashboard/src/lib/audit.ts`
- Create: `dashboard/src/app/api/admin/backup/route.ts`
- Create: `dashboard/src/app/api/admin/restore/route.ts`
- Create: `dashboard/src/app/api/admin/backup/route.test.ts`
- Create: `dashboard/src/app/api/admin/restore/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const exportSettingsBackupMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: validateOriginMock }));
vi.mock("@/lib/backup", () => ({ exportSettingsBackup: exportSettingsBackupMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: true }) } } }));

describe("GET /api/admin/backup", () => {
  beforeEach(() => {
    verifySessionMock.mockResolvedValue({ userId: "admin-1", username: "admin" });
  });

  it("returns settings backup envelope for mode=settings", async () => {
    exportSettingsBackupMock.mockResolvedValue({
      fileName: "dashboard-settings-backup-2026-04-14.json",
      backup: { type: "dashboard-settings-backup", version: 1, exportedAt: "2026-04-14T12:00:00.000Z", sourceApp: "cliproxyapi-dashboard", payload: { systemSettings: [], customProviders: [], providerGroups: [], customProviderModels: [], customProviderExcludedModels: [] } },
    });

    const { GET } = await import("./route");
    const req = new NextRequest("http://localhost/api/admin/backup?mode=settings");
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/app/api/admin/backup/route.test.ts src/app/api/admin/restore/route.test.ts`
Expected: FAIL because routes/constants/actions do not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/lib/api-endpoints.ts (ADMIN block)
BACKUP: "/api/admin/backup",
RESTORE: "/api/admin/restore",

// dashboard/src/lib/audit.ts (AUDIT_ACTION)
BACKUP_EXPORTED: "BACKUP_EXPORTED",
BACKUP_RESTORED: "BACKUP_RESTORED",

// dashboard/src/app/api/admin/backup/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { apiSuccess, Errors } from "@/lib/errors";
import { BackupModeQuerySchema } from "@/lib/validation/backup";
import { exportSettingsBackup, exportProviderCredentialsBackup } from "@/lib/backup";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";

async function requireAdmin() {
  const session = await verifySession();
  if (!session) return { response: Errors.unauthorized() as NextResponse };
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { isAdmin: true } });
  if (!user?.isAdmin) return { response: Errors.forbidden() as NextResponse };
  return { session };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const mode = new URL(request.url).searchParams.get("mode");
  const parsed = BackupModeQuerySchema.safeParse({ mode });
  if (!parsed.success) return Errors.zodValidation(parsed.error.issues);

  const data = parsed.data.mode === "settings"
    ? await exportSettingsBackup()
    : await exportProviderCredentialsBackup();

  logAuditAsync({
    userId: auth.session.userId,
    action: AUDIT_ACTION.BACKUP_EXPORTED,
    target: parsed.data.mode,
    metadata: { mode: parsed.data.mode, version: 1, fileName: data.fileName },
    ipAddress: extractIpAddress(request),
  });

  return apiSuccess({ data });
}

// dashboard/src/app/api/admin/restore/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { apiSuccess, Errors } from "@/lib/errors";
import { AnyBackupSchema, RestoreBackupRequestSchema } from "@/lib/validation/backup";
import { restoreSettingsBackup, restoreProviderCredentialsBackup } from "@/lib/backup";
import { AUDIT_ACTION, extractIpAddress, logAuditAsync } from "@/lib/audit";

async function requireAdmin() {
  const session = await verifySession();
  if (!session) return { response: Errors.unauthorized() as NextResponse };
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { isAdmin: true } });
  if (!user?.isAdmin) return { response: Errors.forbidden() as NextResponse };
  return { session };
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if ("response" in auth) return auth.response;

  const originError = validateOrigin(request);
  if (originError) return originError;

  const body = await request.json().catch(() => null);
  const wrapped = RestoreBackupRequestSchema.safeParse(body);
  if (!wrapped.success) return Errors.zodValidation(wrapped.error.issues);

  const parsedBackup = AnyBackupSchema.safeParse(wrapped.data.backup);
  if (!parsedBackup.success) return Errors.zodValidation(parsedBackup.error.issues);

  if (parsedBackup.data.type === "dashboard-settings-backup") {
    const result = await restoreSettingsBackup(parsedBackup.data);
    logAuditAsync({
      userId: auth.session.userId,
      action: AUDIT_ACTION.BACKUP_RESTORED,
      target: "settings",
      metadata: { mode: "settings", version: parsedBackup.data.version, ...result },
      ipAddress: extractIpAddress(request),
    });
    return apiSuccess({ data: { mode: "settings", ...result } });
  }

  const result = await restoreProviderCredentialsBackup(parsedBackup.data);
  logAuditAsync({
    userId: auth.session.userId,
    action: AUDIT_ACTION.BACKUP_RESTORED,
    target: "provider-credentials",
    metadata: { mode: "provider-credentials", version: parsedBackup.data.version, ...result },
    ipAddress: extractIpAddress(request),
  });

  return apiSuccess({ data: { mode: "provider-credentials", ...result } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/app/api/admin/backup/route.test.ts src/app/api/admin/restore/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/api-endpoints.ts dashboard/src/lib/audit.ts dashboard/src/app/api/admin/backup/route.ts dashboard/src/app/api/admin/restore/route.ts dashboard/src/app/api/admin/backup/route.test.ts dashboard/src/app/api/admin/restore/route.test.ts
git commit -m "feat(admin): add backup and restore API routes"
```

### Task 5: Build admin backup/restore page and admin nav integration

**Files:**
- Create: `dashboard/src/app/dashboard/admin/backup/page.tsx`
- Create: `dashboard/src/app/dashboard/admin/backup/loading.tsx`
- Modify: `dashboard/src/components/dashboard-nav.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";

test("admin backup page is reachable from nav", async ({ page }) => {
  await page.goto("/dashboard/admin/backup");
  await expect(page.getByRole("heading", { name: /backup/i })).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm run test:e2e -- tests/e2e/admin-backup-restore.spec.ts`
Expected: FAIL because page/nav/strings do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/src/app/dashboard/admin/backup/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { API_ENDPOINTS } from "@/lib/api-endpoints";

export default function AdminBackupRestorePage() {
  const t = useTranslations("backupRestore");
  const tc = useTranslations("common");
  const { showToast } = useToast();
  const router = useRouter();
  const [showSettingsConfirm, setShowSettingsConfirm] = useState(false);

  async function exportBackup(mode: "settings" | "provider-credentials") {
    const res = await fetch(`${API_ENDPOINTS.ADMIN.BACKUP}?mode=${mode}`);
    if (res.status === 401) return router.push("/login");
    if (res.status === 403) return router.push("/dashboard");
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data.data.backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.data.fileName;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t("exportSuccess"), "success");
  }

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[{ label: tc("dashboard"), href: "/dashboard" }, { label: tc("admin") }, { label: t("breadcrumbLabel") }]} />
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t("title")}</h1>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{t("description")}</p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-sm font-semibold">{t("backupSettingsTitle")}</h2>
          <Button className="mt-3" onClick={() => void exportBackup("settings")}>{t("downloadButton")}</Button>
        </div>

        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-sm font-semibold">{t("restoreSettingsTitle")}</h2>
          <Button className="mt-3" variant="danger" onClick={() => setShowSettingsConfirm(true)}>{t("restoreButton")}</Button>
        </div>

        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-sm font-semibold">{t("backupCredentialsTitle")}</h2>
          <Button className="mt-3" onClick={() => void exportBackup("provider-credentials")}>{t("downloadButton")}</Button>
        </div>

        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-4">
          <h2 className="text-sm font-semibold">{t("restoreCredentialsTitle")}</h2>
          <p className="mt-2 text-xs text-[var(--text-muted)]">{t("mergeWarning")}</p>
        </div>
      </section>

      <ConfirmDialog
        isOpen={showSettingsConfirm}
        onClose={() => setShowSettingsConfirm(false)}
        onConfirm={() => setShowSettingsConfirm(false)}
        title={t("confirmSettingsRestoreTitle")}
        message={t("confirmSettingsRestoreMessage")}
        confirmText={t("confirmSettingsRestoreAction")}
        cancelText={tc("cancel")}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm run test:e2e -- tests/e2e/admin-backup-restore.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/dashboard/admin/backup/page.tsx dashboard/src/app/dashboard/admin/backup/loading.tsx dashboard/src/components/dashboard-nav.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat(admin-ui): add backup restore admin page"
```

### Task 6: Add restore upload flows in UI (settings replace + credentials merge)

**Files:**
- Modify: `dashboard/src/app/dashboard/admin/backup/page.tsx`
- Create: `dashboard/tests/e2e/admin-backup-restore.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";

test("settings restore requires confirmation", async ({ page }) => {
  await page.goto("/dashboard/admin/backup");
  await expect(page.getByText(/replace total/i)).toBeVisible();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm run test:e2e -- tests/e2e/admin-backup-restore.spec.ts`
Expected: FAIL because restore upload and summary flows are not complete.

- [ ] **Step 3: Write minimal implementation**

```tsx
// In admin backup page:
// - Add file inputs for settings restore and credentials restore.
// - Parse JSON on client with try/catch.
// - POST to API_ENDPOINTS.ADMIN.RESTORE with { backup }.
// - Settings restore goes through ConfirmDialog.
// - Credentials restore executes directly and shows summary counters.
// - Show result blocks for { replacedDomains } or { created/updated/skipped/failed }.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm run test:e2e -- tests/e2e/admin-backup-restore.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/dashboard/admin/backup/page.tsx dashboard/tests/e2e/admin-backup-restore.spec.ts
git commit -m "feat(admin-ui): implement restore uploads and result summaries"
```

### Task 7: Change dashboard default port to 8318 across compose/scripts/docs

**Files:**
- Modify: `docker-compose.local.yml`
- Modify: `docker-compose.yml`
- Modify: `setup-local.sh`
- Modify: `setup-local.ps1`
- Modify: `dashboard/dev-local.sh`
- Modify: `dashboard/dev-local.ps1`
- Modify: `dashboard/.env.development`
- Modify: `dashboard/playwright.config.ts`
- Modify: `README.md`
- Modify: `docs/INSTALLATION.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/ENV.md`
- Modify: `docs/CONTRIBUTING.md`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("default dashboard port docs", () => {
  it("uses 8318 in local docs", () => {
    const readme = readFileSync("../README.md", "utf8");
    expect(readme.includes("http://localhost:8318")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/__tests__/dashboard-port-docs.test.ts`
Expected: FAIL because references still point at 3000.

- [ ] **Step 3: Write minimal implementation**

```txt
Apply replacements for dashboard default/local references:
- localhost:3000 -> localhost:8318 in local setup docs and scripts
- 127.0.0.1:3000:3000 -> 127.0.0.1:8318:3000 in compose files
- DASHBOARD_URL=http://localhost:3000 -> DASHBOARD_URL=http://localhost:8318

Do NOT change internal container listen port 3000 where it is intentionally container-internal,
including Dockerfile EXPOSE 3000, container healthcheck localhost:3000, Caddy/sidecar upstream dashboard:3000.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/__tests__/dashboard-port-docs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docker-compose.local.yml docker-compose.yml setup-local.sh setup-local.ps1 dashboard/dev-local.sh dashboard/dev-local.ps1 dashboard/.env.development dashboard/playwright.config.ts README.md docs/INSTALLATION.md docs/CONFIGURATION.md docs/ENV.md docs/CONTRIBUTING.md
git commit -m "chore(port): change dashboard default local port to 8318"
```

### Task 8: Verify end-to-end behavior and finalize docs/spec alignment

**Files:**
- Modify: `docs/superpowers/specs/2026-04-14-backup-restore-design.md`
- Modify: `docs/superpowers/plans/2026-04-14-backup-restore-and-port-8318.md`

- [ ] **Step 1: Run focused unit/API tests**

Run: `cd dashboard && npm test -- src/lib/__tests__/backup-validation.test.ts src/lib/__tests__/backup-export-settings.test.ts src/lib/__tests__/backup-export-provider-credentials.test.ts src/lib/__tests__/backup-restore-settings.test.ts src/lib/__tests__/backup-restore-provider-credentials.test.ts src/app/api/admin/backup/route.test.ts src/app/api/admin/restore/route.test.ts`
Expected: PASS

- [ ] **Step 2: Run quality gates**

Run: `cd dashboard && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 3: Run E2E for admin page**

Run: `cd dashboard && npm run test:e2e -- tests/e2e/admin-backup-restore.spec.ts`
Expected: PASS

- [ ] **Step 4: Record any deviations from spec/plan**

```md
Update spec/plan docs if exact field names, route response envelope, or test scope changed during implementation.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-14-backup-restore-design.md docs/superpowers/plans/2026-04-14-backup-restore-and-port-8318.md
git commit -m "docs: finalize backup restore and port 8318 implementation notes"
```
