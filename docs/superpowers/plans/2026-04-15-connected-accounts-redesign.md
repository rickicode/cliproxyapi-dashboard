# Connected Accounts Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split large-scale OAuth account management out of the Providers page into a top-level Connected Accounts screen with server-side search, status filtering, numbered pagination, and v1 bulk actions.

**Architecture:** Keep the current OAuth connect/import flows, but separate onboarding from large-list operations. Introduce a dedicated OAuth query/mutation layer that returns paginated list metadata and stable action identifiers, let the Providers page consume a 10-row preview from the same backend contract, and build the new full-page Connected Accounts UI on top of URL-backed server state.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma 7, next-intl, Vitest

---

## File Structure

- `dashboard/src/components/dashboard-nav.tsx` — add the new top-level Connected Accounts navigation item.
- `dashboard/messages/en.json` — source-of-truth copy for nav, providers preview, connected-accounts toolbar/table/bulk states.
- `dashboard/messages/de.json` — German mirror of the new copy keys.
- `dashboard/src/lib/api-endpoints.ts` — add constants for the new bulk OAuth endpoint and reuse the existing OAuth list endpoint for both preview and full-page reads.
- `dashboard/src/lib/providers/oauth-ops.ts` — existing ownership + management API integration; keep existing single-row mutations but extract/extend list and bulk logic into focused helpers.
- `dashboard/src/lib/providers/oauth-listing.ts` — new query/mapping layer for server-side list requests, preview mode, status discovery, and page fallback metadata.
- `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts` — unit coverage for list filtering, pagination, unknown statuses, and bulk partial-success summaries.
- `dashboard/src/app/api/providers/oauth/route.ts` — upgrade GET contract to accept `q`, `status`, `page`, `pageSize`, and `preview`.
- `dashboard/src/app/api/providers/oauth/bulk/route.ts` — new bulk enable/disable/disconnect route with permission revalidation and partial-success responses.
- `dashboard/src/app/api/providers/oauth/route.test.ts` — route tests for list contract and preview behavior.
- `dashboard/src/app/api/providers/oauth/bulk/route.test.ts` — route tests for bulk mutation success, skips, and partial failures.
- `dashboard/src/components/providers/oauth-actions.tsx` — keep this focused on onboarding actions only.
- `dashboard/src/components/providers/oauth-credential-list.tsx` — either slim down into a preview-only list or extract shared row helpers while fixing unknown-status rendering.
- `dashboard/src/components/providers/oauth-preview-card.tsx` — new Providers-page preview wrapper around the capped 10-row connected-account list and View All CTA.
- `dashboard/src/components/providers/oauth-section.tsx` — remove fetch-all list ownership, host onboarding UI, and mount the lightweight preview card.
- `dashboard/src/app/dashboard/providers/page.tsx` — keep stats, reorder OAuth onboarding under API Key Providers, and preserve preview count updates.
- `dashboard/src/app/dashboard/connected-accounts/page.tsx` — new route entrypoint for the full management screen.
- `dashboard/src/components/connected-accounts/connected-accounts-page.tsx` — client container coordinating toolbar, URL state, table, bulk actions, and refresh behavior.
- `dashboard/src/components/connected-accounts/connected-accounts-toolbar.tsx` — search, status filter, page size selector, result summary.
- `dashboard/src/components/connected-accounts/connected-accounts-table.tsx` — table rows, row actions, selection, unknown-status display.
- `dashboard/src/components/connected-accounts/connected-accounts-bulk-bar.tsx` — visible-selection-only bulk action controls and confirmation handling.
- `dashboard/src/components/connected-accounts/connected-accounts-pagination.tsx` — numbered pagination synced to query string.
- `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx` — UI behavior tests for query-string state, preview cap, fallback page behavior, and mutation refresh preservation.
- `dashboard/prisma/schema.prisma` — add only the indexes that support ownership/provider/account identity lookups used by the new server-side filtering path.

### Task 1: Add backend list-query primitives and failing tests

**Files:**
- Create: `dashboard/src/lib/providers/oauth-listing.ts`
- Create: `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts`
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
- Modify: `dashboard/prisma/schema.prisma`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildOAuthListResponse } from "@/lib/providers/oauth-listing";

describe("buildOAuthListResponse", () => {
  const rows = [
    {
      id: "auth-1",
      accountName: "claude_user@example.com.json",
      accountEmail: "user@example.com",
      provider: "claude",
      ownerUsername: "ricki",
      ownerUserId: "user-1",
      isOwn: true,
      status: "active",
      statusMessage: null,
      unavailable: false,
      actionKey: "claude_user@example.com.json",
      canToggle: true,
      canDelete: true,
      canClaim: false,
    },
    {
      id: "auth-2",
      accountName: "cursor_other@example.com.json",
      accountEmail: "other@example.com",
      provider: "cursor",
      ownerUsername: null,
      ownerUserId: null,
      isOwn: false,
      status: "expired",
      statusMessage: '{"message":"Token expired"}',
      unavailable: true,
      actionKey: "cursor_other@example.com.json",
      canToggle: false,
      canDelete: false,
      canClaim: true,
    },
  ];

  it("filters by query and returns unknown statuses in availableStatuses", () => {
    const result = buildOAuthListResponse(rows, {
      q: "cursor",
      status: "all",
      page: 1,
      pageSize: 50,
      preview: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.provider).toBe("cursor");
    expect(result.availableStatuses).toEqual(["active", "expired"]);
  });

  it("caps preview responses to ten items without slicing on the client", () => {
    const previewRows = Array.from({ length: 12 }, (_, index) => ({
      ...rows[0],
      id: `auth-${index + 1}`,
      accountName: `account-${index + 1}.json`,
      actionKey: `account-${index + 1}.json`,
    }));

    const result = buildOAuthListResponse(previewRows, {
      q: "",
      status: "all",
      page: 1,
      pageSize: 50,
      preview: true,
    });

    expect(result.items).toHaveLength(10);
    expect(result.total).toBe(12);
    expect(result.totalPages).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-listing.test.ts`
Expected: FAIL because `oauth-listing.ts` and `buildOAuthListResponse` do not exist yet

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/lib/providers/oauth-listing.ts
import type { OAuthAccountWithOwnership } from "@/lib/providers/management-api";

export interface OAuthListItem extends OAuthAccountWithOwnership {
  actionKey: string;
  canToggle: boolean;
  canDelete: boolean;
  canClaim: boolean;
}

export interface OAuthListQuery {
  q: string;
  status: string;
  page: number;
  pageSize: number;
  preview: boolean;
}

export interface OAuthListResponseData {
  items: OAuthListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  availableStatuses: string[];
}

function parseStatusSearchText(statusMessage: string | null): string {
  if (!statusMessage) return "";
  try {
    const parsed = JSON.parse(statusMessage) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? statusMessage;
  } catch {
    return statusMessage;
  }
}

export function buildOAuthListResponse(rows: OAuthListItem[], query: OAuthListQuery): OAuthListResponseData {
  const normalizedQuery = query.q.trim().toLowerCase();
  const availableStatuses = Array.from(new Set(rows.map((row) => row.status))).sort();
  const filtered = rows.filter((row) => {
    const matchesStatus = query.status === "all" || row.status === query.status;
    if (!matchesStatus) return false;
    if (!normalizedQuery) return true;

    const haystack = [
      row.accountName,
      row.accountEmail ?? "",
      row.provider,
      row.status,
      parseStatusSearchText(row.statusMessage),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });

  const cappedPageSize = query.preview ? 10 : query.pageSize;
  const total = filtered.length;
  const totalPages = query.preview ? 1 : Math.max(1, Math.ceil(total / cappedPageSize));
  const safePage = query.preview ? 1 : Math.min(Math.max(1, query.page), totalPages);
  const start = query.preview ? 0 : (safePage - 1) * cappedPageSize;
  const items = filtered.slice(start, start + cappedPageSize);

  return {
    items,
    page: safePage,
    pageSize: cappedPageSize,
    total,
    totalPages,
    availableStatuses,
  };
}
```

```prisma
model ProviderOAuthOwnership {
  id           String    @id @default(cuid())
  userId       String
  provider     String
  accountName  String    @unique
  accountEmail String?
  createdAt    DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([provider])
  @@index([userId, provider])
  @@index([accountEmail])
  @@map("provider_oauth_ownerships")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-listing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/oauth-listing.ts dashboard/src/lib/providers/__tests__/oauth-listing.test.ts dashboard/prisma/schema.prisma dashboard/src/lib/providers/oauth-ops.ts
git commit -m "test: add oauth listing query primitives"
```

### Task 2: Upgrade the OAuth list API contract and add bulk route coverage

**Files:**
- Create: `dashboard/src/app/api/providers/oauth/route.test.ts`
- Create: `dashboard/src/app/api/providers/oauth/bulk/route.ts`
- Create: `dashboard/src/app/api/providers/oauth/bulk/route.test.ts`
- Modify: `dashboard/src/app/api/providers/oauth/route.ts`
- Modify: `dashboard/src/lib/api-endpoints.ts`
- Modify: `dashboard/src/lib/providers/oauth-listing.ts`
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`

- [ ] **Step 1: Write the failing list-route tests**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionMock = vi.fn();
const listOAuthAccountsMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: false }) } },
}));
vi.mock("@/lib/providers/dual-write", () => ({
  contributeOAuthAccount: vi.fn(),
  listOAuthAccounts: listOAuthAccountsMock,
}));

describe("GET /api/providers/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
  });

  it("returns paginated oauth list metadata", async () => {
    listOAuthAccountsMock.mockResolvedValue({
      ok: true,
      data: {
        items: [{ id: "auth-1", actionKey: "auth-1", status: "active" }],
        page: 2,
        pageSize: 50,
        total: 101,
        totalPages: 3,
        availableStatuses: ["active", "disabled"],
      },
    });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/providers/oauth?q=claude&status=active&page=2&pageSize=50"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.totalPages).toBe(3);
    expect(listOAuthAccountsMock).toHaveBeenCalledWith("user-1", false, {
      q: "claude",
      status: "active",
      page: 2,
      pageSize: 50,
      preview: false,
    });
  });
});
```

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionMock = vi.fn();
const bulkUpdateOAuthAccountsMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: vi.fn().mockReturnValue(null) }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn().mockResolvedValue({ isAdmin: true }) } },
}));
vi.mock("@/lib/providers/dual-write", () => ({ bulkUpdateOAuthAccounts: bulkUpdateOAuthAccountsMock }));

describe("POST /api/providers/oauth/bulk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "admin-1" });
  });

  it("returns partial-success summaries for mixed selections", async () => {
    bulkUpdateOAuthAccountsMock.mockResolvedValue({
      ok: true,
      summary: { total: 2, successCount: 1, failureCount: 1 },
      failures: [{ actionKey: "auth-2", reason: "Access denied" }],
    });

    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost/api/providers/oauth/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", actionKeys: ["auth-1", "auth-2"] }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(207);
    expect(body.data.summary.failureCount).toBe(1);
    expect(body.data.failures[0]).toEqual({ actionKey: "auth-2", reason: "Access denied" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npm test -- src/app/api/providers/oauth/route.test.ts src/app/api/providers/oauth/bulk/route.test.ts`
Expected: FAIL because the paginated list route and bulk route do not exist yet

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/app/api/providers/oauth/route.ts
import { apiSuccess } from "@/lib/errors";

function parseListQuery(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  return {
    q: searchParams.get("q") ?? "",
    status: searchParams.get("status") ?? "all",
    page: Number(searchParams.get("page") ?? "1"),
    pageSize: Number(searchParams.get("pageSize") ?? "50"),
    preview: searchParams.get("preview") === "true",
  };
}

export async function GET(request: NextRequest) {
  const session = await verifySession();
  if (!session) return Errors.unauthorized();

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { isAdmin: true } });
  const query = parseListQuery(request);
  const result = await listOAuthAccounts(session.userId, user?.isAdmin ?? false, query);

  if (!result.ok) {
    return Errors.internal("Failed to list OAuth accounts", result.error ? new Error(result.error) : undefined);
  }

  return apiSuccess(result.data);
}
```

```ts
// dashboard/src/app/api/providers/oauth/bulk/route.ts
import { NextRequest } from "next/server";
import { verifySession } from "@/lib/auth/session";
import { validateOrigin } from "@/lib/auth/origin";
import { prisma } from "@/lib/db";
import { Errors, apiSuccess } from "@/lib/errors";
import { bulkUpdateOAuthAccounts } from "@/lib/providers/dual-write";

export async function POST(request: NextRequest) {
  const session = await verifySession();
  if (!session) return Errors.unauthorized();

  const originError = validateOrigin(request);
  if (originError) return originError;

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.actionKeys) || typeof body.action !== "string") {
    return Errors.validation("Request body must include 'action' and 'actionKeys'");
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { isAdmin: true } });
  const result = await bulkUpdateOAuthAccounts(session.userId, user?.isAdmin ?? false, {
    action: body.action,
    actionKeys: body.actionKeys,
  });

  if (!result.ok) {
    return Errors.internal("Failed to bulk update OAuth accounts", result.error ? new Error(result.error) : undefined);
  }

  return apiSuccess(result, result.summary.failureCount > 0 ? 207 : 200);
}
```

```ts
// dashboard/src/lib/api-endpoints.ts
PROVIDERS: {
  KEYS: "/api/providers/keys",
  OAUTH: "/api/providers/oauth",
  OAUTH_BULK: "/api/providers/oauth/bulk",
  OAUTH_IMPORT: "/api/providers/oauth/import",
  OAUTH_CLAIM: "/api/providers/oauth/claim",
  PERPLEXITY_COOKIE: "/api/providers/perplexity-cookie",
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npm test -- src/app/api/providers/oauth/route.test.ts src/app/api/providers/oauth/bulk/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/providers/oauth/route.test.ts dashboard/src/app/api/providers/oauth/bulk/route.ts dashboard/src/app/api/providers/oauth/bulk/route.test.ts dashboard/src/app/api/providers/oauth/route.ts dashboard/src/lib/api-endpoints.ts dashboard/src/lib/providers/oauth-listing.ts dashboard/src/lib/providers/oauth-ops.ts
git commit -m "feat: add paginated oauth list and bulk api routes"
```

### Task 3: Implement provider-layer list mapping, stable action keys, and bulk mutations

**Files:**
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
- Modify: `dashboard/src/lib/providers/oauth-listing.ts`
- Modify: `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts`

- [ ] **Step 1: Write the failing provider-layer test**

```ts
import { describe, expect, it, vi } from "vitest";
import { bulkUpdateOAuthAccounts, listOAuthAccounts } from "@/lib/providers/oauth-ops";

describe("bulkUpdateOAuthAccounts", () => {
  it("skips ineligible rows and reports partial success", async () => {
    const result = await bulkUpdateOAuthAccounts("user-1", false, {
      action: "disconnect",
      actionKeys: ["owned.json", "unowned.json"],
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ total: 2, successCount: 1, failureCount: 1 });
    expect(result.failures).toContainEqual({ actionKey: "unowned.json", reason: "Access denied" });
  });
});

describe("listOAuthAccounts", () => {
  it("returns action keys for visible rows without exposing synthetic ids as mutation targets", async () => {
    const result = await listOAuthAccounts("user-1", false, {
      q: "",
      status: "all",
      page: 1,
      pageSize: 50,
      preview: false,
    });

    expect(result.ok).toBe(true);
    expect(result.data.items[0]).toHaveProperty("actionKey");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-listing.test.ts`
Expected: FAIL because list/action-key and bulk orchestration helpers are incomplete

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/lib/providers/oauth-ops.ts
import { buildOAuthListResponse, type OAuthListItem, type OAuthListQuery } from "./oauth-listing";

export async function listOAuthAccounts(userId: string, isAdmin: boolean, query: OAuthListQuery) {
  const result = await listOAuthWithOwnership(userId, isAdmin);
  if (!result.ok) return { ok: false, error: result.error };

  const rows: OAuthListItem[] = result.accounts.map((row) => ({
    ...row,
    actionKey: row.isOwn || isAdmin ? row.accountName : "",
    canToggle: row.isOwn || isAdmin,
    canDelete: row.isOwn || isAdmin,
    canClaim: Boolean(isAdmin && !row.ownerUserId && row.accountName && (row.isOwn || isAdmin)),
  }));

  return { ok: true, data: buildOAuthListResponse(rows, query) };
}

export async function bulkUpdateOAuthAccounts(
  userId: string,
  isAdmin: boolean,
  input: { action: "enable" | "disable" | "disconnect"; actionKeys: string[] }
) {
  const failures: Array<{ actionKey: string; reason: string }> = [];
  let successCount = 0;

  for (const actionKey of input.actionKeys) {
    if (!actionKey) {
      failures.push({ actionKey, reason: "Missing action key" });
      continue;
    }

    const result =
      input.action === "disconnect"
        ? await removeOAuthAccountByIdOrName(userId, actionKey, isAdmin)
        : await toggleOAuthAccountByIdOrName(userId, actionKey, input.action === "disable", isAdmin);

    if (result.ok) {
      successCount += 1;
    } else {
      failures.push({ actionKey, reason: result.error ?? "Unknown error" });
    }
  }

  return {
    ok: true,
    summary: {
      total: input.actionKeys.length,
      successCount,
      failureCount: failures.length,
    },
    failures,
  };
}
```

```ts
// when mapping list rows inside listOAuthWithOwnership
return {
  id: canSeeDetails ? file.id : `account-${index + 1}`,
  accountName: canSeeDetails ? file.name : `Account ${index + 1}`,
  accountEmail: canSeeDetails ? file.email || null : null,
  provider: inferredProvider || "unknown",
  ownerUsername: canSeeDetails ? ownership?.user.username || null : null,
  ownerUserId: canSeeDetails ? ownership?.user.id || null : null,
  isOwn,
  status: file.status || "active",
  statusMessage: file.status_message || null,
  unavailable: file.unavailable ?? false,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-listing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/oauth-ops.ts dashboard/src/lib/providers/oauth-listing.ts dashboard/src/lib/providers/__tests__/oauth-listing.test.ts
git commit -m "feat: add oauth list mapping and bulk provider ops"
```

### Task 4: Add navigation, translations, Providers preview split, and preview-safe status rendering

**Files:**
- Modify: `dashboard/src/components/dashboard-nav.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`
- Create: `dashboard/src/components/providers/__tests__/oauth-credential-list.test.tsx`
- Create: `dashboard/src/components/providers/oauth-preview-card.tsx`
- Modify: `dashboard/src/components/providers/oauth-credential-list.tsx`
- Modify: `dashboard/src/components/providers/oauth-section.tsx`
- Modify: `dashboard/src/app/dashboard/providers/page.tsx`

- [ ] **Step 1: Write the failing UI test**

```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OAuthCredentialList } from "@/components/providers/oauth-credential-list";

describe("OAuthCredentialList", () => {
  it("renders unknown statuses instead of dropping the badge", () => {
    render(
      <OAuthCredentialList
        accounts={[
          {
            id: "auth-1",
            accountName: "cursor_user.json",
            accountEmail: "user@example.com",
            provider: "cursor",
            ownerUsername: "ricki",
            ownerUserId: "user-1",
            isOwn: true,
            status: "expired",
            statusMessage: null,
            unavailable: false,
          },
        ]}
        loading={false}
        currentUser={{ id: "user-1", username: "ricki", isAdmin: false }}
        togglingAccountId={null}
        claimingAccountName={null}
        onToggle={() => {}}
        onDelete={() => {}}
        onClaim={() => {}}
      />
    );

    expect(screen.getByText("expired")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/components/providers/__tests__/oauth-credential-list.test.tsx`
Expected: FAIL because unknown statuses currently return `null`

- [ ] **Step 3: Write minimal implementation**

```ts
// dashboard/src/components/providers/oauth-credential-list.tsx
if (status === "disabled") {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
      <span className="size-1.5 rounded-full bg-[#999]" />
      {t("statusDisabled")}
    </span>
  );
}

return (
  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">
    <span className="size-1.5 rounded-full bg-amber-500" />
    {status}
  </span>
);
```

```ts
// dashboard/src/components/dashboard-nav.tsx
const NAV_ITEMS = [
  { href: "/dashboard", labelKey: "quickStart", icon: IconPlayCircle, adminOnly: false, section: "general" },
  { href: "/dashboard/providers", labelKey: "providers", icon: IconLayers, adminOnly: false, section: "general" },
  { href: "/dashboard/connected-accounts", labelKey: "connectedAccounts", icon: IconUsers, adminOnly: false, section: "general" },
  { href: "/dashboard/usage", labelKey: "usage", icon: IconBarChart, adminOnly: false, section: "general" },
];
```

```ts
// dashboard/src/components/providers/oauth-preview-card.tsx
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { OAuthCredentialList, type OAuthAccountWithOwnership } from "@/components/providers/oauth-credential-list";

interface OAuthPreviewCardProps {
  currentUser: CurrentUserLike | null;
  refreshProviders: () => Promise<void>;
  onAccountCountChange: (count: number) => void;
}

interface PreviewResponse {
  data: {
    items: OAuthAccountWithOwnership[];
    total: number;
  };
}

export function OAuthPreviewCard({ currentUser, onAccountCountChange }: OAuthPreviewCardProps) {
  const t = useTranslations("providers");
  const [accounts, setAccounts] = useState<OAuthAccountWithOwnership[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      setLoading(true);
      const response = await fetch(`${API_ENDPOINTS.PROVIDERS.OAUTH}?preview=true&page=1&pageSize=10`);
      const body = (await response.json()) as PreviewResponse;
      if (cancelled) return;
      setAccounts(body.data.items);
      onAccountCountChange(body.data.total);
      setLoading(false);
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [onAccountCountChange]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t("connectedAccountsPreviewTitle")}</h3>
          <p className="text-xs text-[var(--text-muted)]">{t("connectedAccountsPreviewDescription")}</p>
        </div>
        <Link href="/dashboard/connected-accounts" className="text-sm font-medium text-blue-600 hover:underline">
          {t("viewAllConnectedAccounts")}
        </Link>
      </div>

      <OAuthCredentialList
        accounts={accounts}
        loading={loading}
        currentUser={currentUser}
        togglingAccountId={null}
        claimingAccountName={null}
        onToggle={() => {}}
        onDelete={() => {}}
        onClaim={() => {}}
      />
    </div>
  );
}
```

```ts
// dashboard/src/app/dashboard/providers/page.tsx
<section className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6 space-y-6">
  <ApiKeySection
    showToast={showToast}
    currentUser={currentUser}
    configs={configs}
    maxKeysPerUser={maxKeysPerUser}
    refreshProviders={refreshProviders}
  />

  <div className="border-t border-[var(--surface-border)] pt-6">
    <OAuthSection
      showToast={showToast}
      currentUser={currentUser}
      refreshProviders={refreshProviders}
      onAccountCountChange={setOauthAccountCount}
      incognitoBrowserEnabled={incognitoBrowserEnabled}
    />
  </div>

  <div className="border-t border-[var(--surface-border)] pt-6">
    <OAuthPreviewCard
      currentUser={currentUser}
      refreshProviders={refreshProviders}
      onAccountCountChange={setOauthAccountCount}
    />
  </div>
</section>
```

Add matching copy keys to `messages/en.json` first, then mirror them into `messages/de.json`:

```json
{
  "nav": {
    "connectedAccounts": "Connected Accounts"
  },
  "providers": {
    "connectedAccountsPreviewTitle": "Connected Accounts",
    "connectedAccountsPreviewDescription": "Showing the first 10 connected OAuth accounts.",
    "viewAllConnectedAccounts": "View All Connected Accounts",
    "unknownStatusLabel": "Unknown status"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/components/providers/__tests__/oauth-credential-list.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/dashboard-nav.tsx dashboard/messages/en.json dashboard/messages/de.json dashboard/src/components/providers/oauth-preview-card.tsx dashboard/src/components/providers/oauth-credential-list.tsx dashboard/src/components/providers/oauth-section.tsx dashboard/src/app/dashboard/providers/page.tsx
git commit -m "feat: split oauth preview from providers onboarding"
```

### Task 5: Build the Connected Accounts page, URL-backed controls, and row/bulk interaction flow

> Implementation note: the final branch may keep Task 5 tests in a Node-only Vitest environment instead of the illustrative `@testing-library/react` examples below, because this repo/worktree does not ship `jsdom`, `@testing-library/react`, `@testing-library/user-event`, or `react-test-renderer`. If so, preserve behavioral coverage by testing helper/runtime seams for URL-state canonicalization, refresh preservation, page fallback, and stale-response protection.

**Files:**
- Create: `dashboard/src/app/dashboard/connected-accounts/page.tsx`
- Create: `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
- Create: `dashboard/src/components/connected-accounts/connected-accounts-toolbar.tsx`
- Create: `dashboard/src/components/connected-accounts/connected-accounts-table.tsx`
- Create: `dashboard/src/components/connected-accounts/connected-accounts-bulk-bar.tsx`
- Create: `dashboard/src/components/connected-accounts/connected-accounts-pagination.tsx`
- Create: `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`

- [ ] **Step 1: Write the failing page test (or equivalent failing helper/runtime tests in Node-only Vitest if DOM tooling is unavailable)**

```ts
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectedAccountsPage } from "@/components/connected-accounts/connected-accounts-page";

const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/dashboard/connected-accounts",
  useSearchParams: () => new URLSearchParams("q=claude&status=active&page=3&pageSize=50"),
}));

describe("ConnectedAccountsPage", () => {
  it("preserves query-string filters when refreshing after a row action", async () => {
    render(<ConnectedAccountsPage />);
    await userEvent.click(screen.getByRole("button", { name: /disable/i }));

    await waitFor(() => {
      expect(replaceMock).not.toHaveBeenCalledWith("/dashboard/connected-accounts?page=1");
    });
  });

  it("falls back to the nearest valid page when a filtered page becomes empty", async () => {
    render(<ConnectedAccountsPage />);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/dashboard/connected-accounts?q=claude&status=active&page=2&pageSize=50",
        { scroll: false }
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`
Expected: FAIL because the Connected Accounts page and its URL-state logic do not exist yet

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/src/app/dashboard/connected-accounts/page.tsx
import { ConnectedAccountsPage } from "@/components/connected-accounts/connected-accounts-page";

export default function ConnectedAccountsRoute() {
  return <ConnectedAccountsPage />;
}
```

```tsx
// dashboard/src/components/connected-accounts/connected-accounts-page.tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { API_ENDPOINTS } from "@/lib/api-endpoints";

export function ConnectedAccountsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [data, setData] = useState(null);
  const [selectedActionKeys, setSelectedActionKeys] = useState<string[]>([]);

  const query = useMemo(() => ({
    q: searchParams.get("q") ?? "",
    status: searchParams.get("status") ?? "all",
    page: Number(searchParams.get("page") ?? "1"),
    pageSize: Number(searchParams.get("pageSize") ?? "50"),
  }), [searchParams]);

  const syncQuery = useCallback((next: Partial<typeof query>) => {
    const params = new URLSearchParams(searchParams.toString());
    const merged = { ...query, ...next };
    params.set("q", merged.q);
    params.set("status", merged.status);
    params.set("page", String(merged.page));
    params.set("pageSize", String(merged.pageSize));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, query, router, searchParams]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      q: query.q,
      status: query.status,
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    const response = await fetch(`${API_ENDPOINTS.PROVIDERS.OAUTH}?${params.toString()}`);
    const body = await response.json();
    setData(body.data);

    if (body.data.totalPages > 0 && query.page > body.data.totalPages) {
      syncQuery({ page: body.data.totalPages });
    }
  }, [query, syncQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBulkAction = async (action: "enable" | "disable" | "disconnect") => {
    await fetch(API_ENDPOINTS.PROVIDERS.OAUTH_BULK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, actionKeys: selectedActionKeys }),
    });
    setSelectedActionKeys([]);
    await load();
  };

  return (
    <div className="space-y-6">
      <ConnectedAccountsToolbar query={query} onQueryChange={syncQuery} data={data} />
      <ConnectedAccountsBulkBar selectedCount={selectedActionKeys.length} onSubmit={handleBulkAction} />
      <ConnectedAccountsTable data={data} selectedActionKeys={selectedActionKeys} onSelectionChange={setSelectedActionKeys} onMutated={load} />
      <ConnectedAccountsPagination data={data} onPageChange={(page) => syncQuery({ page })} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/dashboard/connected-accounts/page.tsx dashboard/src/components/connected-accounts/connected-accounts-page.tsx dashboard/src/components/connected-accounts/connected-accounts-toolbar.tsx dashboard/src/components/connected-accounts/connected-accounts-table.tsx dashboard/src/components/connected-accounts/connected-accounts-bulk-bar.tsx dashboard/src/components/connected-accounts/connected-accounts-pagination.tsx dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
git commit -m "feat: add connected accounts management page"
```

### Task 6: Run verification and document any implementation drift

**Files:**
- Modify: `docs/superpowers/specs/2026-04-15-connected-accounts-redesign-design.md`
- Modify: `docs/superpowers/plans/2026-04-15-connected-accounts-redesign.md`

- [ ] **Step 1: Run focused tests for the new backend and UI paths**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-listing.test.ts src/app/api/providers/oauth/route.test.ts src/app/api/providers/oauth/bulk/route.test.ts src/components/providers/__tests__/oauth-credential-list.test.tsx src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`
Expected: PASS

- [ ] **Step 2: Run broader safety checks**

Run: `cd dashboard && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 3: Run a production build to catch App Router and next-intl regressions**

Run: `cd dashboard && npm run build`
Expected: PASS

- [ ] **Step 4: Record any deviations from the plan**

```md
If the implementation ends up reusing an existing component path, changing route payload names, or choosing a different index combination, update this plan and the approved spec in the same branch so the final docs match the shipped behavior.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-15-connected-accounts-redesign-design.md docs/superpowers/plans/2026-04-15-connected-accounts-redesign.md
git commit -m "docs: finalize connected accounts redesign plan"
```
