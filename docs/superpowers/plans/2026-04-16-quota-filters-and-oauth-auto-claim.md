# Quota Filters/Pagination and OAuth Auto-Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add search, provider/status filters, and pagination to `/dashboard/quota`, while strengthening and clarifying automatic OAuth ownership claiming for newly created accounts on `/dashboard/providers`.

**Architecture:** Keep quota filtering and pagination client-side with URL-backed query state so the existing quota API contract stays unchanged. Extract OAuth auto-claim classification into a shared helper used by the management callback flow, and return a normalized result that the providers UI can present consistently without expanding into general ownership-management UI.

**Tech Stack:** Next.js App Router, React 19, TypeScript, next-intl, SWR, Vitest

---

## File Map

### Quota page

**Create**
- `dashboard/src/components/quota/quota-toolbar.tsx` — search/filter toolbar for quota accounts.
- `dashboard/src/lib/quota/query-state.ts` — parse, normalize, and serialize quota URL query state.
- `dashboard/src/lib/quota/__tests__/query-state.test.ts` — pure unit coverage for URL query-state handling.

**Modify**
- `dashboard/src/app/dashboard/quota/page.tsx` — own query state, filtering, aggregation, and pagination wiring.
- `dashboard/src/components/quota/quota-details.tsx` — render paginated subset and distinct empty states.
- `dashboard/src/app/dashboard/quota/page.test.tsx` — page-level filtering/pagination/aggregate tests.
- `dashboard/src/components/quota/__tests__/quota-details.test.tsx` — empty-state behavior tests.
- `dashboard/messages/en.json` — new quota toolbar/filter/pagination strings.
- `dashboard/messages/de.json` — German translation parity.

### OAuth auto-claim reliability

**Create**
- `dashboard/src/lib/providers/oauth-auto-claim.ts` — shared helper for classifying auto-claim outcomes.
- `dashboard/src/lib/providers/__tests__/oauth-auto-claim.test.ts` — pure unit coverage for auto-claim classification.
- `dashboard/src/app/api/management/oauth-callback/route.test.ts` — route-level callback/claim result tests.
- `dashboard/src/components/providers/__tests__/oauth-section.test.tsx` — frontend result feedback tests if UI branching becomes non-trivial.

**Modify**
- `dashboard/src/app/api/management/oauth-callback/route.ts` — delegate to shared helper and normalize outcome shape.
- `dashboard/src/components/providers/oauth-section.tsx` — consume normalized result and show clearer feedback.
- `dashboard/messages/en.json` — new providers auto-claim outcome strings.
- `dashboard/messages/de.json` — translation parity.

### Existing patterns to follow
- `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
- `dashboard/src/components/connected-accounts/connected-accounts-toolbar.tsx`
- `dashboard/src/components/connected-accounts/connected-accounts-pagination.tsx`
- `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`
- `dashboard/src/lib/__tests__/oauth-callback-snapshot-timing.test.ts`

---

### Task 1: Add quota query-state helpers

**Files:**
- Create: `dashboard/src/lib/quota/query-state.ts`
- Test: `dashboard/src/lib/quota/__tests__/query-state.test.ts`

- [ ] **Step 1: Write the failing query-state tests**

```ts
import { describe, expect, it } from "vitest";
import {
  buildQuotaSearch,
  normalizeQuotaQuery,
  parseQuotaQuery,
} from "../query-state";

describe("quota query state", () => {
  it("parses and normalizes valid params", () => {
    const query = parseQuotaQuery(
      new URLSearchParams("q=gmail&provider=claude&status=active&page=2")
    );

    expect(query).toEqual({
      q: "gmail",
      provider: "claude",
      status: "active",
      page: 2,
    });
  });

  it("normalizes invalid params to safe defaults", () => {
    expect(
      normalizeQuotaQuery({
        q: "",
        provider: "unknown",
        status: "weird",
        page: -5,
      })
    ).toEqual({
      q: "",
      provider: "all",
      status: "all",
      page: 1,
    });
  });

  it("omits default params when building search strings", () => {
    expect(
      buildQuotaSearch({ q: "", provider: "all", status: "all", page: 1 })
    ).toBe("");

    expect(
      buildQuotaSearch({ q: "gmail", provider: "claude", status: "active", page: 2 })
    ).toBe("?q=gmail&provider=claude&status=active&page=2");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/quota/__tests__/query-state.test.ts`

Expected: FAIL because `../query-state` does not exist yet.

- [ ] **Step 3: Write the minimal query-state implementation**

```ts
export type QuotaProviderFilter = "all" | "antigravity" | "claude" | "codex" | "github-copilot" | "kimi";
export type QuotaStatusFilter = "all" | "active" | "warning" | "error" | "disabled";

export interface QuotaQueryState {
  q: string;
  provider: QuotaProviderFilter;
  status: QuotaStatusFilter;
  page: number;
}

const VALID_PROVIDERS: QuotaProviderFilter[] = [
  "all",
  "antigravity",
  "claude",
  "codex",
  "github-copilot",
  "kimi",
];

const VALID_STATUSES: QuotaStatusFilter[] = ["all", "active", "warning", "error", "disabled"];

export function normalizeQuotaQuery(input: Partial<QuotaQueryState>): QuotaQueryState {
  const provider = VALID_PROVIDERS.includes((input.provider ?? "all") as QuotaProviderFilter)
    ? (input.provider as QuotaProviderFilter)
    : "all";
  const status = VALID_STATUSES.includes((input.status ?? "all") as QuotaStatusFilter)
    ? (input.status as QuotaStatusFilter)
    : "all";
  const page = Number.isInteger(input.page) && (input.page ?? 0) > 0 ? (input.page as number) : 1;

  return {
    q: (input.q ?? "").trim(),
    provider,
    status,
    page,
  };
}

export function parseQuotaQuery(searchParams: URLSearchParams): QuotaQueryState {
  return normalizeQuotaQuery({
    q: searchParams.get("q") ?? "",
    provider: (searchParams.get("provider") ?? "all") as QuotaProviderFilter,
    status: (searchParams.get("status") ?? "all") as QuotaStatusFilter,
    page: Number(searchParams.get("page") ?? "1"),
  });
}

export function buildQuotaSearch(query: QuotaQueryState): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.provider !== "all") params.set("provider", query.provider);
  if (query.status !== "all") params.set("status", query.status);
  if (query.page > 1) params.set("page", String(query.page));
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/quota/__tests__/query-state.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/quota/query-state.ts dashboard/src/lib/quota/__tests__/query-state.test.ts
git commit -m "feat(quota): add URL query state helpers"
```

### Task 2: Add quota toolbar and client-side list controls

**Files:**
- Create: `dashboard/src/components/quota/quota-toolbar.tsx`
- Modify: `dashboard/src/app/dashboard/quota/page.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`
- Test: `dashboard/src/app/dashboard/quota/page.test.tsx`

- [ ] **Step 1: Write the failing page test for search/filter reset behavior**

```tsx
it("applies email/provider/status filters and resets page to 1 when filters change", async () => {
  render(<QuotaPage />);

  await user.type(screen.getByRole("searchbox", { name: /search accounts/i }), "gmail");
  await user.selectOptions(screen.getByLabelText(/provider/i), "claude");
  await user.selectOptions(screen.getByLabelText(/status/i), "active");

  expect(screen.getByText(/page 1/i)).toBeInTheDocument();
  expect(screen.queryByText(/other-provider@example.com/i)).not.toBeInTheDocument();
  expect(screen.getByText(/claude-user@gmail.com/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/dashboard/quota/page.test.tsx`

Expected: FAIL because the quota page does not yet render the toolbar or pagination state.

- [ ] **Step 3: Create the toolbar component**

```tsx
"use client";

import { useTranslations } from "next-intl";

interface QuotaToolbarProps {
  search: string;
  provider: string;
  status: string;
  resultCount: number;
  onSearchChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onReset: () => void;
}

export function QuotaToolbar({
  search,
  provider,
  status,
  resultCount,
  onSearchChange,
  onProviderChange,
  onStatusChange,
  onReset,
}: QuotaToolbarProps) {
  const t = useTranslations("quota");

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="space-y-2">
          <span className="text-sm font-medium">{t("toolbar.searchLabel")}</span>
          <input
            aria-label={t("toolbar.searchLabel")}
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("toolbar.searchPlaceholder")}
            className="w-full rounded-md border px-3 py-2"
          />
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium">{t("toolbar.providerLabel")}</span>
          <select
            aria-label={t("toolbar.providerLabel")}
            value={provider}
            onChange={(event) => onProviderChange(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
          >
            <option value="all">{t("toolbar.allProviders")}</option>
            <option value="antigravity">Antigravity</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="github-copilot">GitHub Copilot</option>
            <option value="kimi">Kimi</option>
          </select>
        </label>

        <label className="space-y-2">
          <span className="text-sm font-medium">{t("toolbar.statusLabel")}</span>
          <select
            aria-label={t("toolbar.statusLabel")}
            value={status}
            onChange={(event) => onStatusChange(event.target.value)}
            className="w-full rounded-md border px-3 py-2"
          >
            <option value="all">{t("toolbar.allStatuses")}</option>
            <option value="active">{t("toolbar.statusActive")}</option>
            <option value="warning">{t("toolbar.statusWarning")}</option>
            <option value="error">{t("toolbar.statusError")}</option>
            <option value="disabled">{t("toolbar.statusDisabled")}</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{t("toolbar.resultCount", { count: resultCount })}</span>
        <button type="button" onClick={onReset} className="underline underline-offset-4">
          {t("toolbar.clearFilters")}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update the page to use URL-backed query state and toolbar filters**

```tsx
const PAGE_SIZE = 10;

const searchParams = useSearchParams();
const router = useRouter();
const pathname = usePathname();
const query = parseQuotaQuery(searchParams);

const filteredAccounts = useMemo(() => {
  return accounts.filter((account) => {
    const matchesProvider = query.provider === "all" || account.provider === query.provider;
    const matchesStatus = query.status === "all" || deriveQuotaStatus(account) === query.status;
    const email = account.email?.toLowerCase() ?? "";
    const matchesSearch = !query.q || email.includes(query.q.toLowerCase());
    return matchesProvider && matchesStatus && matchesSearch;
  });
}, [accounts, query]);

const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
const currentPage = Math.min(query.page, totalPages);
const pageAccounts = filteredAccounts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

function updateQuery(next: Partial<QuotaQueryState>, resetPage = false) {
  const normalized = normalizeQuotaQuery({
    ...query,
    ...next,
    page: resetPage ? 1 : next.page ?? query.page,
  });
  router.replace(`${pathname}${buildQuotaSearch(normalized)}`, { scroll: false });
}
```

- [ ] **Step 5: Add translation keys used by the toolbar**

```json
{
  "quota": {
    "toolbar": {
      "searchLabel": "Search accounts",
      "searchPlaceholder": "Search by email",
      "providerLabel": "Provider",
      "statusLabel": "Status",
      "allProviders": "All providers",
      "allStatuses": "All statuses",
      "statusActive": "Active",
      "statusWarning": "Warning",
      "statusError": "Error",
      "statusDisabled": "Disabled",
      "clearFilters": "Clear filters",
      "resultCount": "{count, plural, one {# account} other {# accounts}}"
    }
  }
}
```

- [ ] **Step 6: Run the page test to verify it passes**

Run: `npx vitest run src/app/dashboard/quota/page.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/app/dashboard/quota/page.tsx dashboard/src/components/quota/quota-toolbar.tsx dashboard/src/app/dashboard/quota/page.test.tsx dashboard/messages/en.json dashboard/messages/de.json dashboard/src/lib/quota/query-state.ts dashboard/src/lib/quota/__tests__/query-state.test.ts
git commit -m "feat(quota): add search and filter controls"
```

### Task 3: Add quota pagination and distinct empty states

**Files:**
- Modify: `dashboard/src/components/quota/quota-details.tsx`
- Modify: `dashboard/src/components/quota/__tests__/quota-details.test.tsx`
- Modify: `dashboard/src/app/dashboard/quota/page.tsx`

- [ ] **Step 1: Write the failing details test for empty-state distinction**

```tsx
it("renders no-results copy when filters remove all accounts", () => {
  render(
    <QuotaDetails
      accounts={[]}
      hasAnyAccounts
    />
  );

  expect(screen.getByText(/no accounts match the current filters/i)).toBeInTheDocument();
});

it("renders no-data copy when no quota data exists", () => {
  render(
    <QuotaDetails
      accounts={[]}
      hasAnyAccounts={false}
    />
  );

  expect(screen.getByText(/no quota accounts available yet/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the details test to verify it fails**

Run: `npx vitest run src/components/quota/__tests__/quota-details.test.tsx`

Expected: FAIL because `QuotaDetails` does not yet differentiate the empty states.

- [ ] **Step 3: Update `QuotaDetails` to support paginated input and separate empty states**

```tsx
interface QuotaDetailsProps {
  accounts: QuotaAccount[];
  hasAnyAccounts?: boolean;
}

if (accounts.length === 0) {
  return (
    <div className="rounded-lg border p-6 text-sm text-muted-foreground">
      {hasAnyAccounts
        ? t("details.noResults")
        : t("details.noData")}
    </div>
  );
}
```

- [ ] **Step 4: Add page-level pagination controls and test page slicing**

```tsx
it("shows only the current page accounts while keeping aggregates based on the filtered set", async () => {
  render(<QuotaPage />);

  await user.click(screen.getByRole("button", { name: /next page/i }));

  expect(screen.queryByText(/first-page-user@example.com/i)).not.toBeInTheDocument();
  expect(screen.getByText(/second-page-user@example.com/i)).toBeInTheDocument();
  expect(screen.getByText(/23 accounts/i)).toBeInTheDocument();
});
```

- [ ] **Step 5: Run the quota tests to verify they pass**

Run: `npx vitest run src/app/dashboard/quota/page.test.tsx src/components/quota/__tests__/quota-details.test.tsx`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/app/dashboard/quota/page.tsx dashboard/src/components/quota/quota-details.tsx dashboard/src/components/quota/__tests__/quota-details.test.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat(quota): paginate accounts list"
```

### Task 4: Extract OAuth auto-claim classification helper

**Files:**
- Create: `dashboard/src/lib/providers/oauth-auto-claim.ts`
- Test: `dashboard/src/lib/providers/__tests__/oauth-auto-claim.test.ts`

- [ ] **Step 1: Write the failing auto-claim helper tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyOAuthAutoClaimResult } from "../oauth-auto-claim";

describe("classifyOAuthAutoClaimResult", () => {
  it("returns claimed for a single unowned candidate", () => {
    expect(
      classifyOAuthAutoClaimResult({
        candidates: [{ accountName: "acct-1", ownerUserId: null }],
      })
    ).toMatchObject({ kind: "claimed", accountName: "acct-1" });
  });

  it("returns already_claimed when the only candidate already has an owner", () => {
    expect(
      classifyOAuthAutoClaimResult({
        candidates: [{ accountName: "acct-1", ownerUserId: "user-2" }],
      })
    ).toMatchObject({ kind: "already_claimed", accountName: "acct-1" });
  });

  it("returns ambiguous when more than one candidate is plausible", () => {
    expect(
      classifyOAuthAutoClaimResult({
        candidates: [
          { accountName: "acct-1", ownerUserId: null },
          { accountName: "acct-2", ownerUserId: null },
        ],
      })
    ).toMatchObject({ kind: "ambiguous" });
  });

  it("returns no_match when no candidates exist", () => {
    expect(classifyOAuthAutoClaimResult({ candidates: [] })).toMatchObject({ kind: "no_match" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/providers/__tests__/oauth-auto-claim.test.ts`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Write the minimal helper implementation**

```ts
export type OAuthAutoClaimResult =
  | { kind: "claimed"; accountName: string }
  | { kind: "already_claimed"; accountName: string }
  | { kind: "no_match" }
  | { kind: "ambiguous" }
  | { kind: "error"; message: string };

interface ClaimCandidate {
  accountName: string;
  ownerUserId: string | null;
}

export function classifyOAuthAutoClaimResult({
  candidates,
}: {
  candidates: ClaimCandidate[];
}): OAuthAutoClaimResult {
  if (candidates.length === 0) return { kind: "no_match" };
  if (candidates.length > 1) return { kind: "ambiguous" };

  const [candidate] = candidates;
  if (candidate.ownerUserId) {
    return { kind: "already_claimed", accountName: candidate.accountName };
  }

  return { kind: "claimed", accountName: candidate.accountName };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/providers/__tests__/oauth-auto-claim.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/oauth-auto-claim.ts dashboard/src/lib/providers/__tests__/oauth-auto-claim.test.ts
git commit -m "feat(providers): add oauth auto-claim classifier"
```

### Task 5: Normalize OAuth callback auto-claim results

**Files:**
- Modify: `dashboard/src/app/api/management/oauth-callback/route.ts`
- Create: `dashboard/src/app/api/management/oauth-callback/route.test.ts`
- Test: `dashboard/src/lib/__tests__/oauth-callback-snapshot-timing.test.ts`

- [ ] **Step 1: Write the failing route test for successful connect with non-claim outcomes**

```ts
it("returns connection success with no_match auto-claim outcome when no unique auth file can be identified", async () => {
  const response = await POST(buildOAuthCallbackRequest());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    success: true,
    autoClaim: { kind: "no_match" },
  });
});
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `npx vitest run src/app/api/management/oauth-callback/route.test.ts`

Expected: FAIL because the route does not yet return a normalized `autoClaim` shape.

- [ ] **Step 3: Refactor the route to use the shared helper and keep connect success separate from claim outcome**

```ts
const autoClaim = classifyOAuthAutoClaimResult({ candidates });

if (autoClaim.kind === "claimed") {
  await createOwnership(...);
}

return apiSuccess({
  success: true,
  provider,
  autoClaim,
});
```

- [ ] **Step 4: Update snapshot-timing regression coverage to assert the normalized outcome**

Run: `npx vitest run src/app/api/management/oauth-callback/route.test.ts src/lib/__tests__/oauth-callback-snapshot-timing.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/management/oauth-callback/route.ts dashboard/src/app/api/management/oauth-callback/route.test.ts dashboard/src/lib/providers/oauth-auto-claim.ts dashboard/src/lib/providers/__tests__/oauth-auto-claim.test.ts dashboard/src/lib/__tests__/oauth-callback-snapshot-timing.test.ts
git commit -m "feat(providers): normalize oauth auto-claim outcomes"
```

### Task 6: Surface clearer auto-claim feedback in providers UI

**Files:**
- Modify: `dashboard/src/components/providers/oauth-section.tsx`
- Create: `dashboard/src/components/providers/__tests__/oauth-section.test.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`

- [ ] **Step 1: Write the failing frontend test for auto-claim result messaging**

```tsx
it("shows partial-success feedback when connect succeeds but auto-claim returns no_match", async () => {
  render(<OAuthSection />);

  completeOAuthFlowWithResult({
    success: true,
    autoClaim: { kind: "no_match" },
  });

  expect(await screen.findByText(/connected, but ownership could not be determined automatically/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/providers/__tests__/oauth-section.test.tsx`

Expected: FAIL because the UI does not yet branch on normalized auto-claim outcomes.

- [ ] **Step 3: Update `oauth-section.tsx` to map auto-claim kinds to explicit user feedback**

```ts
function getAutoClaimMessage(result: OAuthAutoClaimResult) {
  switch (result.kind) {
    case "claimed":
      return t("autoClaim.claimed");
    case "already_claimed":
      return t("autoClaim.alreadyClaimed");
    case "no_match":
      return t("autoClaim.noMatch");
    case "ambiguous":
      return t("autoClaim.ambiguous");
    case "error":
      return t("autoClaim.error");
  }
}
```

- [ ] **Step 4: Add translation keys for the new providers feedback**

```json
{
  "providers": {
    "autoClaim": {
      "claimed": "Connected and claimed successfully.",
      "alreadyClaimed": "Connected, but the account was already claimed.",
      "noMatch": "Connected, but ownership could not be determined automatically.",
      "ambiguous": "Connected, but more than one claim candidate was found.",
      "error": "Connected, but automatic claiming could not be completed."
    }
  }
}
```

- [ ] **Step 5: Run the UI test to verify it passes**

Run: `npx vitest run src/components/providers/__tests__/oauth-section.test.tsx`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/providers/oauth-section.tsx dashboard/src/components/providers/__tests__/oauth-section.test.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat(providers): clarify oauth auto-claim feedback"
```

### Task 7: Final verification

**Files:**
- Verify all changed files from Tasks 1-6

- [ ] **Step 1: Run focused test suite for this work**

Run: `npx vitest run src/lib/quota/__tests__/query-state.test.ts src/app/dashboard/quota/page.test.tsx src/components/quota/__tests__/quota-details.test.tsx src/lib/providers/__tests__/oauth-auto-claim.test.ts src/app/api/management/oauth-callback/route.test.ts src/components/providers/__tests__/oauth-section.test.tsx src/lib/__tests__/oauth-callback-snapshot-timing.test.ts`

Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`

Expected: PASS

- [ ] **Step 3: Re-read the spec and confirm each requirement is implemented**

Checklist:
- `/dashboard/quota` supports email search, provider filter, status filter, and pagination
- quota state is URL-backed and normalized safely
- quota summary/chart use filtered pre-pagination data
- quota distinguishes no-data vs no-results
- OAuth auto-claim remains limited to newly created accounts
- callback and no-callback flows expose normalized claim outcomes
- providers UI shows clearer post-connect auto-claim messages
- auto-claim ambiguity/no-match does not incorrectly mark connect as failed

- [ ] **Step 4: Commit final verification-only adjustments if needed**

```bash
git add dashboard/src app/src docs/superpowers/specs/2026-04-16-quota-filters-and-oauth-auto-claim-design.md
git commit -m "test: finalize quota and oauth auto-claim coverage"
```
