# Manual Claim and Mandatory OAuth Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claim button on `/dashboard/providers` work, and enforce one shared ownership-resolution flow so add/connect/import automatically claim or merge safe duplicates while preferring the newest auth data.

**Architecture:** Introduce a shared server-side ownership resolver in `dashboard/src/lib/providers/` and route manual claim, callback auto-claim, add/register, and import flows through it. Keep candidate discovery in existing flow-specific code, but centralize identity matching, duplicate merge decisions, normalized outcome mapping, and transaction-safe ownership writes in one helper.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Prisma 7, next-intl, Vitest

---

## File Map

### Create
- `dashboard/src/lib/providers/oauth-ownership-resolver.ts` — shared identity matching, merge policy, and normalized ownership result writer.
- `dashboard/src/lib/providers/__tests__/oauth-ownership-resolver.test.ts` — pure unit coverage for create/merge/ambiguous/owned outcomes.
- `dashboard/src/app/api/providers/oauth/claim/route.test.ts` — route coverage for real manual claim behavior.

### Modify
- `dashboard/src/lib/providers/oauth-auto-claim.ts` — keep candidate classification aligned with the new normalized outcome union if needed.
- `dashboard/src/lib/providers/oauth-ops.ts` — replace direct ownership create/conflict logic in add/import paths with the shared resolver.
- `dashboard/src/lib/providers/dual-write.ts` — preserve re-exports if any signatures change.
- `dashboard/src/app/api/providers/oauth/claim/route.ts` — route manual claim through the shared resolver.
- `dashboard/src/app/api/providers/oauth/route.ts` — keep add/register response contract aligned with merge success semantics.
- `dashboard/src/app/api/management/oauth-callback/route.ts` — replace direct auto-claim create logic with the shared resolver.
- `dashboard/src/app/api/management/oauth-callback/route.test.ts` — add merged-result coverage.
- `dashboard/src/app/api/providers/oauth/import/route.test.ts` — add merged import result coverage.
- `dashboard/src/components/providers/oauth-preview-card.tsx` — wire real claim action and refresh preview state.
- `dashboard/src/components/providers/oauth-credential-list.tsx` — render Claim from `canClaim` semantics and honor loading state.
- `dashboard/src/components/providers/oauth-section.tsx` — accept new normalized ownership outcomes in provider feedback.
- `dashboard/src/components/providers/__tests__/oauth-credential-list.test.tsx` — claim button rendering/loading tests.
- `dashboard/src/components/providers/__tests__/oauth-section.test.tsx` — merged-result feedback tests.
- `dashboard/messages/en.json` — new/updated claim and merge messaging.
- `dashboard/messages/de.json` — translation parity.

### Existing patterns to follow
- `dashboard/src/lib/providers/oauth-auto-claim.ts`
- `dashboard/src/app/api/management/oauth-callback/route.test.ts`
- `dashboard/src/components/providers/__tests__/oauth-section.test.tsx`
- `dashboard/src/app/api/providers/oauth/import/route.ts`
- `dashboard/src/lib/providers/dual-write.ts`

---

### Task 1: Add the shared ownership resolver

**Files:**
- Create: `dashboard/src/lib/providers/oauth-ownership-resolver.ts`
- Test: `dashboard/src/lib/providers/__tests__/oauth-ownership-resolver.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

```ts
import { describe, expect, it, vi } from "vitest";

const {
  findFirstMock,
  findManyMock,
  createMock,
  updateMock,
  transactionMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findManyMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    providerOAuthOwnership: {
      findFirst: findFirstMock,
      findMany: findManyMock,
      create: createMock,
      update: updateMock,
    },
    $transaction: transactionMock,
  },
}));

import { resolveOAuthOwnership } from "../oauth-ownership-resolver";

describe("resolveOAuthOwnership", () => {
  it("creates a new ownership when no match exists", async () => {
    findFirstMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([]);
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ providerOAuthOwnership: { create: createMock, update: updateMock } })
    );
    createMock.mockResolvedValue({
      id: "ownership-1",
      userId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "user@example.com",
    });

    const result = await resolveOAuthOwnership({
      currentUserId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "user@example.com",
    });

    expect(result.kind).toBe("claimed");
    expect(createMock).toHaveBeenCalled();
  });

  it("merges when the same accountName already exists", async () => {
    findFirstMock.mockResolvedValue({
      id: "ownership-1",
      userId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "old@example.com",
      user: { username: "ricki" },
    });
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ providerOAuthOwnership: { create: createMock, update: updateMock } })
    );
    updateMock.mockResolvedValue({
      id: "ownership-1",
      userId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "new@example.com",
    });

    const result = await resolveOAuthOwnership({
      currentUserId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "new@example.com",
    });

    expect(result.kind).toBe("merged_with_existing");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "ownership-1" },
      data: expect.objectContaining({ accountEmail: "new@example.com" }),
    });
  });

  it("merges by provider and email when accountName changes but match is unique", async () => {
    findFirstMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([
      {
        id: "ownership-2",
        userId: "user-1",
        provider: "claude",
        accountName: "old-name.json",
        accountEmail: "user@example.com",
        user: { username: "ricki" },
      },
    ]);
    transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ providerOAuthOwnership: { create: createMock, update: updateMock } })
    );
    updateMock.mockResolvedValue({
      id: "ownership-2",
      userId: "user-1",
      provider: "claude",
      accountName: "new-name.json",
      accountEmail: "user@example.com",
    });

    const result = await resolveOAuthOwnership({
      currentUserId: "user-1",
      provider: "claude",
      accountName: "new-name.json",
      accountEmail: "user@example.com",
    });

    expect(result.kind).toBe("merged_with_existing");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "ownership-2" },
      data: expect.objectContaining({ accountName: "new-name.json" }),
    });
  });

  it("returns ambiguous when provider and email match multiple rows", async () => {
    findFirstMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([
      { id: "ownership-1", userId: "user-1", provider: "claude", accountName: "a.json", accountEmail: "user@example.com", user: { username: "ricki" } },
      { id: "ownership-2", userId: "user-2", provider: "claude", accountName: "b.json", accountEmail: "user@example.com", user: { username: "other" } },
    ]);

    const result = await resolveOAuthOwnership({
      currentUserId: "user-1",
      provider: "claude",
      accountName: "new-name.json",
      accountEmail: "user@example.com",
    });

    expect(result.kind).toBe("ambiguous");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/providers/__tests__/oauth-ownership-resolver.test.ts`

Expected: FAIL because `../oauth-ownership-resolver` does not exist yet.

- [ ] **Step 3: Write the minimal shared resolver implementation**

```ts
import { prisma } from "@/lib/db";

export interface ResolveOAuthOwnershipInput {
  currentUserId: string;
  provider: string;
  accountName: string;
  accountEmail?: string | null;
}

type OAuthOwnershipCandidate = {
  id: string;
  userId: string;
  provider: string;
  accountName: string;
  accountEmail: string | null;
  user?: { username: string | null } | null;
};

export type OAuthOwnershipResolution =
  | { kind: "claimed"; candidate: { accountName: string; accountEmail?: string | null; ownerUserId: string; ownerUsername: string | null } }
  | { kind: "already_owned_by_current_user"; candidate: { accountName: string; accountEmail?: string | null; ownerUserId: string; ownerUsername: string | null } }
  | { kind: "claimed_by_other_user"; candidate: { accountName: string; accountEmail?: string | null; ownerUserId: string; ownerUsername: string | null } }
  | { kind: "merged_with_existing"; candidate: { accountName: string; accountEmail?: string | null; ownerUserId: string; ownerUsername: string | null } }
  | { kind: "ambiguous"; candidates: Array<{ accountName: string; accountEmail?: string | null; ownerUserId?: string | null; ownerUsername?: string | null }> }
  | { kind: "error"; failure: { code: string; message: string } };

function toCandidate(row: OAuthOwnershipCandidate) {
  return {
    accountName: row.accountName,
    accountEmail: row.accountEmail,
    ownerUserId: row.userId,
    ownerUsername: row.user?.username ?? null,
  };
}

export async function resolveOAuthOwnership(
  input: ResolveOAuthOwnershipInput
): Promise<OAuthOwnershipResolution> {
  try {
    const exactMatch = await prisma.providerOAuthOwnership.findFirst({
      where: { accountName: input.accountName },
      include: { user: { select: { username: true } } },
    });

    if (exactMatch) {
      if (exactMatch.userId === input.currentUserId) {
        const updated = await prisma.$transaction((tx) =>
          tx.providerOAuthOwnership.update({
            where: { id: exactMatch.id },
            data: {
              provider: input.provider,
              accountName: input.accountName,
              accountEmail: input.accountEmail ?? exactMatch.accountEmail,
            },
            include: { user: { select: { username: true } } },
          })
        );

        return { kind: "merged_with_existing", candidate: toCandidate(updated) };
      }

      return { kind: "claimed_by_other_user", candidate: toCandidate(exactMatch) };
    }

    const normalizedEmail = input.accountEmail?.trim().toLowerCase();
    const emailMatches = normalizedEmail
      ? await prisma.providerOAuthOwnership.findMany({
          where: { provider: input.provider, accountEmail: normalizedEmail },
          include: { user: { select: { username: true } } },
        })
      : [];

    if (emailMatches.length > 1) {
      return { kind: "ambiguous", candidates: emailMatches.map(toCandidate) };
    }

    if (emailMatches.length === 1) {
      const [match] = emailMatches;
      const updated = await prisma.$transaction((tx) =>
        tx.providerOAuthOwnership.update({
          where: { id: match.id },
          data: {
            userId: match.userId,
            provider: input.provider,
            accountName: input.accountName,
            accountEmail: normalizedEmail ?? match.accountEmail,
          },
          include: { user: { select: { username: true } } },
        })
      );

      return {
        kind: match.userId === input.currentUserId ? "merged_with_existing" : "claimed_by_other_user",
        candidate: toCandidate(updated),
      };
    }

    const created = await prisma.$transaction((tx) =>
      tx.providerOAuthOwnership.create({
        data: {
          userId: input.currentUserId,
          provider: input.provider,
          accountName: input.accountName,
          accountEmail: normalizedEmail ?? null,
        },
        include: { user: { select: { username: true } } },
      })
    );

    return { kind: "claimed", candidate: toCandidate(created) };
  } catch (error) {
    return {
      kind: "error",
      failure: {
        code: "ownership_resolver_failed",
        message: error instanceof Error ? error.message : "Unknown ownership resolution error",
      },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/providers/__tests__/oauth-ownership-resolver.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/oauth-ownership-resolver.ts dashboard/src/lib/providers/__tests__/oauth-ownership-resolver.test.ts
git commit -m "feat(oauth): add shared ownership resolver"
```

### Task 2: Route manual claim through the shared resolver and wire the preview Claim button

**Files:**
- Create: `dashboard/src/app/api/providers/oauth/claim/route.test.ts`
- Modify: `dashboard/src/app/api/providers/oauth/claim/route.ts`
- Modify: `dashboard/src/components/providers/oauth-preview-card.tsx`
- Modify: `dashboard/src/components/providers/oauth-credential-list.tsx`
- Modify: `dashboard/src/components/providers/__tests__/oauth-credential-list.test.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`

- [ ] **Step 1: Write the failing tests for manual claim route and preview list behavior**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const checkRateLimitWithPresetMock = vi.fn();
const findUniqueMock = vi.fn();
const resolveOAuthOwnershipMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: validateOriginMock }));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimitWithPreset: checkRateLimitWithPresetMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: findUniqueMock } } }));
vi.mock("@/lib/providers/oauth-ownership-resolver", () => ({ resolveOAuthOwnership: resolveOAuthOwnershipMock }));
vi.stubGlobal("fetch", fetchMock);

describe("POST /api/providers/oauth/claim", () => {
  beforeEach(() => {
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitWithPresetMock.mockReturnValue({ allowed: true });
    findUniqueMock.mockResolvedValue({ isAdmin: true });
  });

  it("returns 201 when manual claim resolves through the ownership resolver", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ files: [{ name: "claude-user@example.com.json", provider: "claude", email: "user@example.com" }] }), { status: 200 })
    );
    resolveOAuthOwnershipMock.mockResolvedValue({
      kind: "claimed",
      candidate: {
        accountName: "claude-user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-1",
        ownerUsername: null,
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/providers/oauth/claim", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ accountName: "claude-user@example.com.json" }),
      })
    );

    expect(response.status).toBe(201);
    expect(resolveOAuthOwnershipMock).toHaveBeenCalledWith({
      currentUserId: "user-1",
      provider: "claude",
      accountName: "claude-user@example.com.json",
      accountEmail: "user@example.com",
    });
  });
});
```

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../messages/en.json";
import { OAuthCredentialList } from "@/components/providers/oauth-credential-list";

describe("OAuthCredentialList", () => {
  it("renders a Claim button for admin-view unowned accounts", () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <OAuthCredentialList
          accounts={[{
            id: "account-1",
            accountName: "claude-user@example.com.json",
            accountEmail: "user@example.com",
            provider: "Claude Code",
            ownerUsername: null,
            ownerUserId: null,
            isOwn: false,
            status: "active",
            statusMessage: null,
            unavailable: false,
          }]}
          loading={false}
          currentUser={{ id: "admin-1", username: "admin", isAdmin: true }}
          togglingAccountId={null}
          claimingAccountName={null}
          onToggle={vi.fn()}
          onDelete={vi.fn()}
          onClaim={vi.fn()}
        />
      </NextIntlClientProvider>
    );

    expect(markup).toContain("Claim");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/providers/oauth/claim/route.test.ts src/components/providers/__tests__/oauth-credential-list.test.tsx`

Expected: FAIL because the route has no resolver integration test coverage yet and the current list behavior is not asserted against the intended contract.

- [ ] **Step 3: Implement the manual claim route and preview-card wiring**

```ts
// dashboard/src/app/api/providers/oauth/claim/route.ts
import { resolveOAuthOwnership } from "@/lib/providers/oauth-ownership-resolver";

// inside POST after matchingFile/provider resolution
const result = await resolveOAuthOwnership({
  currentUserId: session.userId,
  provider,
  accountName,
  accountEmail: matchingFile.email || null,
});

if (result.kind === "claimed" || result.kind === "merged_with_existing") {
  return NextResponse.json(
    {
      accountName: result.candidate.accountName,
      provider,
      result,
    },
    { status: 201 }
  );
}

if (result.kind === "already_owned_by_current_user") {
  return NextResponse.json({ accountName: result.candidate.accountName, provider, result }, { status: 200 });
}

if (result.kind === "claimed_by_other_user") {
  return Errors.conflict("Account already has an owner");
}

if (result.kind === "ambiguous") {
  return Errors.conflict("Multiple matching OAuth accounts require manual review");
}

return Errors.internal("Failed to claim OAuth account");
```

```tsx
// dashboard/src/components/providers/oauth-preview-card.tsx
const [claimingAccountName, setClaimingAccountName] = useState<string | null>(null);

const handleClaim = useCallback(async (accountName: string) => {
  setClaimingAccountName(accountName);
  try {
    const response = await fetch(API_ENDPOINTS.PROVIDERS.OAUTH_CLAIM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountName }),
    });

    if (!response.ok) {
      throw new Error(t("toastOAuthClaimFailed"));
    }

    await loadPreview();
  } finally {
    setClaimingAccountName(null);
  }
}, [loadPreview, t]);

<OAuthCredentialList
  accounts={accounts}
  loading={loading}
  currentUser={currentUser}
  togglingAccountId={null}
  claimingAccountName={claimingAccountName}
  onToggle={() => undefined}
  onDelete={() => undefined}
  onClaim={handleClaim}
  showHeader={false}
  description={t("connectedAccountsPreviewDescription")}
  emptyMessage={t("connectedAccountsPreviewEmpty")}
/>
```

```ts
// dashboard/src/components/providers/oauth-credential-list.tsx
// keep the render gate aligned with listing semantics
{currentUser?.isAdmin && !account.ownerUserId ? (
  <Button
    variant="secondary"
    className="px-2.5 py-1 text-xs"
    disabled={claimingAccountName === account.accountName}
    onClick={() => onClaim(account.accountName)}
  >
    {claimingAccountName === account.accountName ? "..." : t("claimButton")}
  </Button>
) : null}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/providers/oauth/claim/route.test.ts src/components/providers/__tests__/oauth-credential-list.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/providers/oauth/claim/route.ts dashboard/src/app/api/providers/oauth/claim/route.test.ts dashboard/src/components/providers/oauth-preview-card.tsx dashboard/src/components/providers/oauth-credential-list.tsx dashboard/src/components/providers/__tests__/oauth-credential-list.test.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat(providers): wire manual OAuth claim in preview"
```

### Task 3: Use the shared resolver in callback auto-claim and update success messaging

**Files:**
- Modify: `dashboard/src/app/api/management/oauth-callback/route.ts`
- Modify: `dashboard/src/lib/providers/oauth-auto-claim.ts`
- Modify: `dashboard/src/components/providers/oauth-section.tsx`
- Modify: `dashboard/src/app/api/management/oauth-callback/route.test.ts`
- Modify: `dashboard/src/components/providers/__tests__/oauth-section.test.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`

- [ ] **Step 1: Write the failing tests for merged callback and merged success feedback**

```ts
it("returns merged_with_existing when callback detects a safe duplicate", async () => {
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ files: [] }))
    .mockResolvedValueOnce(jsonResponse({}, 200))
    .mockResolvedValueOnce(
      jsonResponse({
        files: [{ name: "claude-new.json", provider: "claude", email: "user@example.com" }],
      })
    );
  findManyMock.mockResolvedValueOnce([]);
  resolveOAuthOwnershipMock.mockResolvedValueOnce({
    kind: "merged_with_existing",
    candidate: {
      accountName: "claude-new.json",
      accountEmail: "user@example.com",
      ownerUserId: "user-1",
      ownerUsername: "ricki",
    },
  });

  const response = await postOAuthCallback({
    provider: "claude",
    callbackUrl: "http://localhost/callback?code=abc&state=state-merge",
  });
  const body = await response.json();

  expect(body.autoClaim.kind).toBe("merged_with_existing");
});
```

```ts
it("shows merged success feedback when connect replaces an older auth", () => {
  const feedback = getOAuthConnectSuccessFeedback(
    {
      kind: "merged_with_existing",
      candidate: {
        accountName: "claude-new.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-1",
        ownerUsername: "ricki",
      },
    },
    t
  );

  expect(feedback.toastMessage).toBe("OAuth account connected and merged with your existing account");
  expect(feedback.strongClaimSuccess).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/management/oauth-callback/route.test.ts src/components/providers/__tests__/oauth-section.test.tsx`

Expected: FAIL because merged outcomes are not yet produced or rendered.

- [ ] **Step 3: Implement merged callback resolution and UI messaging**

```ts
// dashboard/src/app/api/management/oauth-callback/route.ts
import { resolveOAuthOwnership } from "@/lib/providers/oauth-ownership-resolver";

// replace direct create/classification branch with:
const resolution = await resolveOAuthOwnership({
  currentUserId: session.userId,
  provider,
  accountName: classification.candidate.accountName,
  accountEmail: classification.candidate.accountEmail ?? null,
});

if (resolution.kind === "claimed" || resolution.kind === "merged_with_existing") {
  return NextResponse.json({ status: 200, autoClaim: resolution });
}

return NextResponse.json({ status: 200, autoClaim: resolution });
```

```ts
// dashboard/src/components/providers/oauth-section.tsx
export type OAuthAutoClaimResult =
  | { kind: "claimed"; candidate: OAuthAutoClaimCandidate }
  | { kind: "merged_with_existing"; candidate: OAuthAutoClaimCandidate }
  | { kind: "already_owned_by_current_user"; candidate: OAuthAutoClaimCandidate }
  | { kind: "claimed_by_other_user"; candidate: OAuthAutoClaimCandidate }
  | { kind: "ambiguous"; candidates: OAuthAutoClaimCandidate[] }
  | { kind: "no_match" }
  | { kind: "error"; failure: OAuthAutoClaimFailure };

case "merged_with_existing":
  return {
    toastMessage: t("toastOAuthConnectedMerged"),
    detailMessage: t("oauthSuccessMergedMsg"),
    strongClaimSuccess: true,
  };
```

```json
// dashboard/messages/en.json
{
  "providers": {
    "toastOAuthConnectedMerged": "OAuth account connected and merged with your existing account",
    "oauthSuccessMergedMsg": "Connected successfully. We detected the same logical account and replaced the older auth with the new one."
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/management/oauth-callback/route.test.ts src/components/providers/__tests__/oauth-section.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/management/oauth-callback/route.ts dashboard/src/lib/providers/oauth-auto-claim.ts dashboard/src/components/providers/oauth-section.tsx dashboard/src/app/api/management/oauth-callback/route.test.ts dashboard/src/components/providers/__tests__/oauth-section.test.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat(oauth): merge duplicate auth during auto-claim"
```

### Task 4: Route add/register and import through the shared resolver

**Files:**
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
- Modify: `dashboard/src/lib/providers/dual-write.ts`
- Modify: `dashboard/src/app/api/providers/oauth/route.ts`
- Modify: `dashboard/src/app/api/providers/oauth/import/route.test.ts`

- [ ] **Step 1: Write the failing tests for import merge and add/register merge semantics**

```ts
it("returns success when import detects a safe duplicate and merges to the new auth", async () => {
  importOAuthCredentialMock.mockResolvedValue({
    ok: true,
    accountName: "claude-new.json",
    ownershipResult: {
      kind: "merged_with_existing",
      candidate: {
        accountName: "claude-new.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-1",
        ownerUsername: "ricki",
      },
    },
  });

  const { POST } = await import("./route");
  const response = await POST(
    new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", fileName: "claude-new.json", fileContent: "{}" }),
    })
  );

  expect(response.status).toBe(200);
});
```

```ts
// add to an oauth-ops or route test file already covering POST /api/providers/oauth
expect(result.ok).toBe(true);
expect(result.ownershipResult?.kind).toBe("merged_with_existing");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/providers/oauth/import/route.test.ts`

Expected: FAIL because merged import success is not yet represented in the route contract.

- [ ] **Step 3: Implement shared resolver usage in import and add/register paths**

```ts
// dashboard/src/lib/providers/oauth-ops.ts
import { resolveOAuthOwnership } from "./oauth-ownership-resolver";

export async function contributeOAuthAccount(
  userId: string,
  provider: OAuthProvider,
  accountName: string,
  accountEmail?: string
): Promise<ContributeOAuthResult> {
  const result = await resolveOAuthOwnership({
    currentUserId: userId,
    provider,
    accountName,
    accountEmail: accountEmail ?? null,
  });

  if (result.kind === "claimed" || result.kind === "merged_with_existing" || result.kind === "already_owned_by_current_user") {
    return { ok: true, id: result.candidate.accountName };
  }

  if (result.kind === "claimed_by_other_user") {
    return { ok: false, error: "OAuth account already registered to another user" };
  }

  if (result.kind === "ambiguous") {
    return { ok: false, error: "Multiple matching OAuth accounts require manual review" };
  }

  return { ok: false, error: result.failure.message };
}
```

```ts
// inside importOAuthCredential after claimedAccountName/provider/email are known
const ownershipResult = await resolveOAuthOwnership({
  currentUserId: userId,
  provider,
  accountName: claimedAccountName,
  accountEmail: inferredEmail ?? null,
});

if (ownershipResult.kind === "claimed" || ownershipResult.kind === "merged_with_existing" || ownershipResult.kind === "already_owned_by_current_user") {
  return {
    ok: true,
    accountName: ownershipResult.candidate.accountName,
    ownershipResult,
  };
}
```

```ts
// dashboard/src/app/api/providers/oauth/route.ts
if (!result.ok) {
  if (result.error?.includes("another user")) {
    return Errors.conflict(result.error);
  }
  if (result.error?.includes("manual review")) {
    return Errors.conflict(result.error);
  }
  return apiError(ERROR_CODE.PROVIDER_ERROR, result.error ?? "Provider error", 500);
}

return NextResponse.json({ id: result.id }, { status: 201 });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/providers/oauth/import/route.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/oauth-ops.ts dashboard/src/lib/providers/dual-write.ts dashboard/src/app/api/providers/oauth/route.ts dashboard/src/app/api/providers/oauth/import/route.test.ts
git commit -m "feat(oauth): use shared ownership resolver in add and import flows"
```

### Task 5: Full verification

**Files:**
- Modify: none
- Test: `dashboard/src/lib/providers/__tests__/oauth-ownership-resolver.test.ts`
- Test: `dashboard/src/app/api/providers/oauth/claim/route.test.ts`
- Test: `dashboard/src/app/api/management/oauth-callback/route.test.ts`
- Test: `dashboard/src/app/api/providers/oauth/import/route.test.ts`
- Test: `dashboard/src/components/providers/__tests__/oauth-credential-list.test.tsx`
- Test: `dashboard/src/components/providers/__tests__/oauth-section.test.tsx`

- [ ] **Step 1: Run targeted OAuth tests**

Run: `npx vitest run src/lib/providers/__tests__/oauth-ownership-resolver.test.ts src/app/api/providers/oauth/claim/route.test.ts src/app/api/management/oauth-callback/route.test.ts src/app/api/providers/oauth/import/route.test.ts src/components/providers/__tests__/oauth-credential-list.test.tsx src/components/providers/__tests__/oauth-section.test.tsx`

Expected: PASS

- [ ] **Step 2: Run typecheck for the dashboard app**

Run: `npm run typecheck`

Expected: PASS

- [ ] **Step 3: Run lint for the dashboard app**

Run: `npm run lint`

Expected: PASS

- [ ] **Step 4: Inspect git diff before final handoff**

Run: `git diff --stat`

Expected: Only the planned OAuth claim/merge files and translation updates are present.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/__tests__/oauth-ownership-resolver.test.ts dashboard/src/app/api/providers/oauth/claim/route.test.ts dashboard/src/app/api/management/oauth-callback/route.test.ts dashboard/src/app/api/providers/oauth/import/route.test.ts dashboard/src/components/providers/__tests__/oauth-credential-list.test.tsx dashboard/src/components/providers/__tests__/oauth-section.test.tsx dashboard/src/lib/providers/oauth-ownership-resolver.ts dashboard/src/lib/providers/oauth-auto-claim.ts dashboard/src/lib/providers/oauth-ops.ts dashboard/src/app/api/providers/oauth/claim/route.ts dashboard/src/app/api/management/oauth-callback/route.ts dashboard/src/app/api/providers/oauth/route.ts dashboard/src/components/providers/oauth-preview-card.tsx dashboard/src/components/providers/oauth-credential-list.tsx dashboard/src/components/providers/oauth-section.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat(oauth): enforce claim and merge duplicate auth"
```

---

## Self-Review

- **Spec coverage:** This plan covers manual Claim wiring, shared resolver extraction, callback/no-callback auto-claim normalization, import/add/register merge semantics, translations, and targeted verification. No spec requirement was left without a task.
- **Placeholder scan:** No `TODO`, `TBD`, or “implement later” placeholders remain. Every task includes explicit files, commands, and code examples.
- **Type consistency:** The plan consistently uses `resolveOAuthOwnership`, `merged_with_existing`, and the same ownership result union across route, lib, and UI tasks.
