# Quota Summary/Detail Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/dashboard/quota` render the top summary content without waiting for the full per-account quota detail payload.

**Architecture:** Keep the existing quota API route but add `view=summary` and `view=detail` query modes with separate cache and single-flight state. Move summary shaping to the server, expose separate SWR hooks for summary and detail, and update the quota page so the top cards/chart use summary while `QuotaDetails` loads independently.

**Tech Stack:** Next.js App Router, React 19, TypeScript, SWR, Vitest

---

### Task 1: Add failing API tests for summary/detail view routing

**Files:**
- Modify: `dashboard/src/app/api/quota/route.test.ts`
- Modify: `dashboard/src/app/api/quota/route.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("returns a summary payload for view=summary without accounts", async () => {
  const authFilesResponse = {
    files: [
      {
        auth_index: 0,
        provider: "codex",
        email: "summary@example.com",
        disabled: false,
        status: "active",
      },
    ],
  };

  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(authFilesResponse),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          status_code: 200,
          body: JSON.stringify({
            rate_limit: {
              primary_window: {
                limit_window_seconds: 300,
                used_percent: 50,
                reset_at: 1774039200,
              },
            },
          }),
        }),
      body: { cancel: vi.fn() },
    });

  const { GET } = await import("./route");

  const response = await GET(
    new Request("http://localhost/api/quota?view=summary", {
      headers: { cookie: "session=test" },
    }) as any
  );
  const data = await response.json();

  expect(data.accounts).toBeUndefined();
  expect(data.providers).toBeDefined();
  expect(data.totals).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm run test -- src/app/api/quota/route.test.ts`
Expected: FAIL because the route still returns the full detail payload for every request

- [ ] **Step 3: Write minimal implementation**

```ts
type QuotaView = "summary" | "detail";

function getQuotaView(request: NextRequest): QuotaView {
  return new URL(request.url).searchParams.get("view") === "summary" ? "summary" : "detail";
}

const CACHE_KEYS = {
  summary: "quota:summary",
  detail: "quota:detail",
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm run test -- src/app/api/quota/route.test.ts`
Expected: PASS for the new `view=summary` test

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/quota/route.test.ts dashboard/src/app/api/quota/route.ts
git commit -m "test: cover quota summary view routing"
```

### Task 2: Build server-side summary response and isolate cache/single-flight by view

**Files:**
- Modify: `dashboard/src/app/api/quota/route.ts`
- Modify: `dashboard/src/app/api/quota/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("does not reuse detail in-flight state for a summary request", async () => {
  let resolveAuthFiles: ((value: { ok: boolean; json: () => Promise<unknown>; body: { cancel: ReturnType<typeof vi.fn> } }) => void) | null = null;

  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveAuthFiles = resolve;
      })
  );

  const { GET } = await import("./route");

  const detailPromise = GET(
    new Request("http://localhost/api/quota?view=detail", {
      headers: { cookie: "session=test" },
    }) as any
  );

  await Promise.resolve();

  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ files: [] }),
    body: { cancel: vi.fn() },
  });

  const summaryResponse = await GET(
    new Request("http://localhost/api/quota?view=summary", {
      headers: { cookie: "session=test" },
    }) as any
  );

  resolveAuthFiles?.({
    ok: true,
    json: () => Promise.resolve({ files: [] }),
    body: { cancel: vi.fn() },
  });

  await detailPromise;
  await summaryResponse.json();

  expect(fetchMock).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm run test -- src/app/api/quota/route.test.ts`
Expected: FAIL because the route currently uses one shared in-flight slot/cache path

- [ ] **Step 3: Write minimal implementation**

```ts
interface QuotaSummaryResponse {
  providers: Array<{
    provider: string;
    monitorMode: "window-based" | "model-first";
    totalAccounts: number;
    healthyAccounts: number;
    errorAccounts: number;
  }>;
  totals: {
    activeAccounts: number;
    providerCount: number;
    lowCapacityCount: number;
  };
  warnings: Array<{
    provider: string;
    count: number;
  }>;
  generatedAt: string;
}

const inFlightQuotaRequests: Record<QuotaView, Promise<QuotaSummaryResponse | QuotaResponse> | null> = {
  summary: null,
  detail: null,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm run test -- src/app/api/quota/route.test.ts`
Expected: PASS for summary/detail cache isolation coverage

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/quota/route.ts dashboard/src/app/api/quota/route.test.ts
git commit -m "feat: split quota summary and detail responses"
```

### Task 3: Add separate summary/detail quota hooks

**Files:**
- Modify: `dashboard/src/hooks/use-quota-data.ts`
- Modify: `dashboard/src/hooks/__tests__/use-quota-data.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("uses separate SWR keys for summary and detail quota data", async () => {
  useSWRMock.mockReturnValue({ data: null, mutate: vi.fn() });

  const { useQuotaSummaryData, useQuotaDetailData } = await import("@/hooks/use-quota-data");

  useQuotaSummaryData();
  useQuotaDetailData();

  expect(useSWRMock).toHaveBeenNthCalledWith(
    1,
    "/api/quota?view=summary",
    expect.any(Function),
    expect.any(Object)
  );
  expect(useSWRMock).toHaveBeenNthCalledWith(
    2,
    "/api/quota?view=detail",
    expect.any(Function),
    expect.any(Object)
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm run test -- src/hooks/__tests__/use-quota-data.test.ts`
Expected: FAIL because only the current single hook/key exists

- [ ] **Step 3: Write minimal implementation**

```ts
export const QUOTA_SUMMARY_SWR_KEY = `${API_ENDPOINTS.QUOTA.BASE}?view=summary`;
export const QUOTA_DETAIL_SWR_KEY = `${API_ENDPOINTS.QUOTA.BASE}?view=detail`;

export function useQuotaSummaryData(options: UseQuotaDataOptions = {}) {
  return useQuotaSWR(QUOTA_SUMMARY_SWR_KEY, options);
}

export function useQuotaDetailData(options: UseQuotaDataOptions = {}) {
  return useQuotaSWR(QUOTA_DETAIL_SWR_KEY, options);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm run test -- src/hooks/__tests__/use-quota-data.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/hooks/use-quota-data.ts dashboard/src/hooks/__tests__/use-quota-data.test.ts
git commit -m "feat: add separate quota summary and detail hooks"
```

### Task 4: Update quota page and header notifications to consume summary/detail separately

**Files:**
- Modify: `dashboard/src/app/dashboard/quota/page.tsx`
- Modify: `dashboard/src/hooks/use-header-notifications.ts`
- Test: `dashboard/src/hooks/__tests__/use-quota-data.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("refreshes quota summary and detail independently with bust URLs", async () => {
  const mutateMock = vi.fn();
  useSWRMock.mockReturnValue({ data: null, mutate: mutateMock });

  const { useQuotaSummaryData, useQuotaDetailData } = await import("@/hooks/use-quota-data");

  const summary = useQuotaSummaryData();
  const detail = useQuotaDetailData();

  await summary.refresh(true);
  await detail.refresh(true);

  expect(mutateMock).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm run test -- src/hooks/__tests__/use-quota-data.test.ts`
Expected: FAIL until the hooks expose distinct refresh paths

- [ ] **Step 3: Write minimal implementation**

```ts
const {
  data: quotaSummary,
  isLoading: summaryLoading,
  refresh: refreshSummary,
} = useQuotaSummaryData({ refreshInterval: 120_000 });

const {
  data: quotaDetail,
  isLoading: detailLoading,
  refresh: refreshDetail,
} = useQuotaDetailData({ refreshInterval: 120_000 });

const refreshAll = async () => {
  await Promise.all([refreshSummary(true), refreshDetail(true)]);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm run test -- src/hooks/__tests__/use-quota-data.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/dashboard/quota/page.tsx dashboard/src/hooks/use-header-notifications.ts dashboard/src/hooks/use-quota-data.ts dashboard/src/hooks/__tests__/use-quota-data.test.ts
git commit -m "feat: load quota summary before detail"
```

### Task 5: Verify end-to-end safety and update docs if shape changes

**Files:**
- Modify: `docs/superpowers/specs/2026-04-15-quota-summary-detail-split-design.md`
- Modify: `docs/superpowers/plans/2026-04-15-quota-summary-detail-split.md`

- [ ] **Step 1: Run focused API and hook tests**

Run: `cd dashboard && npm run test -- src/app/api/quota/route.test.ts src/hooks/__tests__/use-quota-data.test.ts`
Expected: PASS

- [ ] **Step 2: Run broader safety checks**

Run: `cd dashboard && npm run typecheck`
Expected: PASS, or only pre-existing unrelated failures documented explicitly

- [ ] **Step 3: Record any deviations from the design**

```md
If the final summary response names, counters, or warning shape differ from the approved design, update both the design doc and this plan so future readers see the final contract.

Final implemented summary contract notes:
- `providers` now includes `monitorMode`, `totalAccounts`, `activeAccounts`, `healthyAccounts`, `errorAccounts`, `windowCapacities`, optional `modelFirstSummary`, and `lowCapacity` so the existing top cards/chart can render from summary alone.
- `warnings` are reserved for model-first summary/banner warnings, not generic low-quota account notifications.
- Page-level refresh now uses a rejection-safe settled flow so summary/detail refreshes stay independent even if one request fails.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-15-quota-summary-detail-split-design.md docs/superpowers/plans/2026-04-15-quota-summary-detail-split.md
git commit -m "docs: finalize quota summary detail split plan"
```
