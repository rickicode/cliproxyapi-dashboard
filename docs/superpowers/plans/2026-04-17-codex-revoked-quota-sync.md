# Codex Revoked Quota Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync Codex account health into upstream auth-file status when quota checks detect 401/403 auth failures, while keeping quota responses non-fatal and existing connected-account UI contracts unchanged.

**Architecture:** Keep Codex detection in `dashboard/src/app/api/quota/route.ts`, classify outcomes in the Codex aggregation branch, and call a focused server-side helper that writes status to the management API. Reuse existing `/auth-files` consumption so connected-accounts UI updates automatically without new UI plumbing.

**Tech Stack:** Next.js App Router route handlers, TypeScript, Vitest, server-side fetch helpers, existing management API integration

---

## File Structure

- Modify: `dashboard/src/app/api/quota/route.ts`
  - Add Codex auth outcome classification.
  - Add short-interval dedupe for repeated identical status writes.
  - Call status sync from the Codex branch of `aggregateQuotaData()`.
- Modify: `dashboard/src/lib/providers/management-api.ts`
  - Add a focused helper to write auth-file status upstream.
  - Add small status-sync request/response types used by quota code.
- Modify: `dashboard/src/app/api/quota/route.test.ts`
  - Add behavior tests for 401, 403, recovery, sync failure, and dedupe.
- Create: `dashboard/src/lib/providers/__tests__/management-api.test.ts`
  - Add unit coverage for the new upstream write helper.
- Optional verify-only read path: `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts`
  - Only touch if an assertion is needed to prove the existing status contract remains intact.

### Task 1: Add the upstream auth-file status sync helper

**Files:**
- Modify: `dashboard/src/lib/providers/management-api.ts`
- Test: `dashboard/src/lib/providers/__tests__/management-api.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add `dashboard/src/lib/providers/__tests__/management-api.test.ts` with these tests:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.stubEnv("MANAGEMENT_API_KEY", "test-key");
vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://test:8317/v0/management");

describe("syncOAuthAccountStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("posts account status updates to auth-files/status", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
      text: () => Promise.resolve(""),
      body: { cancel: vi.fn() },
    });

    const { syncOAuthAccountStatus } = await import("../management-api");

    const result = await syncOAuthAccountStatus({
      accountName: "codex_user@example.com.json",
      provider: "codex",
      status: "error",
      statusMessage: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
      unavailable: true,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test:8317/v0/management/auth-files/status",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          name: "codex_user@example.com.json",
          provider: "codex",
          status: "error",
          status_message: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
          unavailable: true,
        }),
      })
    );
  });

  it("returns a non-ok result when upstream rejects the write", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
      body: { cancel: vi.fn() },
    });

    const { syncOAuthAccountStatus } = await import("../management-api");

    const result = await syncOAuthAccountStatus({
      accountName: "codex_user@example.com.json",
      provider: "codex",
      status: "active",
      statusMessage: null,
      unavailable: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 500");
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run:

```bash
npm run test -- src/lib/providers/__tests__/management-api.test.ts
```

Expected: FAIL with an error that `syncOAuthAccountStatus` is not exported yet.

- [ ] **Step 3: Add the helper types and implementation**

Update `dashboard/src/lib/providers/management-api.ts` by adding these exports near the existing result interfaces and helper functions:

```ts
export interface SyncOAuthAccountStatusInput {
  accountName: string;
  provider: string;
  status: "active" | "error" | "disabled" | string;
  statusMessage: string | null;
  unavailable: boolean;
}

export interface SyncOAuthAccountStatusResult {
  ok: boolean;
  error?: string;
}

export async function syncOAuthAccountStatus(
  input: SyncOAuthAccountStatusInput
): Promise<SyncOAuthAccountStatusResult> {
  const endpoint = `${MANAGEMENT_BASE_URL}/auth-files/status`;

  let response: Response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MANAGEMENT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: input.accountName,
        provider: input.provider,
        status: input.status,
        status_message: input.statusMessage,
        unavailable: input.unavailable,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error syncing OAuth account status",
    };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    await response.body?.cancel();
    return {
      ok: false,
      error: `Failed to sync OAuth account status: HTTP ${response.status}${errorBody ? ` - ${errorBody}` : ""}`,
    };
  }

  await response.body?.cancel();
  return { ok: true };
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run:

```bash
npm run test -- src/lib/providers/__tests__/management-api.test.ts
```

Expected: PASS with 2 tests passing.

- [ ] **Step 5: Commit the helper**

```bash
git add dashboard/src/lib/providers/management-api.ts dashboard/src/lib/providers/__tests__/management-api.test.ts
git commit -m "feat(dashboard): add oauth account status sync helper"
```

### Task 2: Add Codex quota outcome classification and dedupe

**Files:**
- Modify: `dashboard/src/app/api/quota/route.ts`
- Test: `dashboard/src/app/api/quota/route.test.ts`

- [ ] **Step 1: Write the failing quota-route tests for 401 and 403**

Add these tests to `dashboard/src/app/api/quota/route.test.ts`:

```ts
it("syncs Codex status to error when quota probe returns 401", async () => {
  const authFilesResponse = {
    files: [
      {
        auth_index: 0,
        name: "codex_user@example.com.json",
        provider: "codex",
        email: "codex_user@example.com",
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
          status_code: 401,
          body: JSON.stringify({ error: { message: "Unauthorized" } }),
        }),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
      body: { cancel: vi.fn() },
    });

  const { GET } = await import("./route");
  const response = await GET(new Request("http://localhost/api/quota", { headers: { cookie: "session=test" } }) as unknown as NextRequest);
  const data = await response.json();

  expect(data.accounts[0].error).toBe("Codex OAuth token expired - re-authenticate in CLIProxyAPI");
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "http://test:8317/v0/management/auth-files/status",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "codex_user@example.com.json",
        provider: "codex",
        status: "error",
        status_message: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
        unavailable: true,
      }),
    })
  );
});

it("syncs Codex status conservatively when quota probe returns 403", async () => {
  const authFilesResponse = {
    files: [
      {
        auth_index: 0,
        name: "codex_user@example.com.json",
        provider: "codex",
        email: "codex_user@example.com",
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
          status_code: 403,
          body: JSON.stringify({ detail: "phone verification required" }),
        }),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
      body: { cancel: vi.fn() },
    });

  const { GET } = await import("./route");
  const response = await GET(new Request("http://localhost/api/quota", { headers: { cookie: "session=test" } }) as unknown as NextRequest);
  const data = await response.json();

  expect(data.accounts[0].error).toContain("Codex access denied");
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "http://test:8317/v0/management/auth-files/status",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "codex_user@example.com.json",
        provider: "codex",
        status: "error",
        status_message: "Codex access denied - account may need verification",
        unavailable: true,
      }),
    })
  );
});
```

- [ ] **Step 2: Run the new quota-route tests to verify they fail**

Run:

```bash
npm run test -- src/app/api/quota/route.test.ts
```

Expected: FAIL because no sync write is issued yet and the third fetch call expectation is unmet.

- [ ] **Step 3: Add the classification types and helper functions**

Update `dashboard/src/app/api/quota/route.ts` near the top-level constants with these additions:

```ts
import { logger } from "@/lib/logger";
import { quotaCache, CACHE_TTL } from "@/lib/cache";
import {
  syncOAuthAccountStatus,
  type SyncOAuthAccountStatusInput,
} from "@/lib/providers/management-api";

const CODEX_STATUS_SYNC_DEDUPE_TTL_MS = 30_000;

type CodexQuotaSyncTarget = Pick<
  SyncOAuthAccountStatusInput,
  "status" | "statusMessage" | "unavailable"
>;

const recentCodexStatusSyncs = new Map<string, number>();

function classifyCodexQuotaResult(result: QuotaGroup[] | { error: string }): CodexQuotaSyncTarget | null {
  if (!("error" in result)) {
    return {
      status: "active",
      statusMessage: null,
      unavailable: false,
    };
  }

  if (result.error === "Codex OAuth token expired - re-authenticate in CLIProxyAPI") {
    return {
      status: "error",
      statusMessage: "Codex OAuth token expired - re-authenticate in CLIProxyAPI",
      unavailable: true,
    };
  }

  if (result.error.startsWith("Codex access denied")) {
    return {
      status: "error",
      statusMessage: "Codex access denied - account may need verification",
      unavailable: true,
    };
  }

  return null;
}

function shouldSyncCodexStatus(accountName: string, target: CodexQuotaSyncTarget): boolean {
  const key = JSON.stringify([accountName, target.status, target.statusMessage, target.unavailable]);
  const now = Date.now();
  const previous = recentCodexStatusSyncs.get(key);

  if (previous && now - previous < CODEX_STATUS_SYNC_DEDUPE_TTL_MS) {
    return false;
  }

  recentCodexStatusSyncs.set(key, now);
  return true;
}
```

- [ ] **Step 4: Wire the sync call into the Codex branch**

Update the Codex branch inside `aggregateQuotaData()` in `dashboard/src/app/api/quota/route.ts` like this:

```ts
if (providerNorm === "codex") {
  const result = await fetchCodexQuota(authIndex);
  const syncTarget = classifyCodexQuotaResult(result);

  if (account.name && syncTarget && shouldSyncCodexStatus(account.name, syncTarget)) {
    const syncResult = await syncOAuthAccountStatus({
      accountName: account.name,
      provider: "codex",
      status: syncTarget.status,
      statusMessage: syncTarget.statusMessage,
      unavailable: syncTarget.unavailable,
    });

    if (!syncResult.ok) {
      logger.warn(
        {
          provider: "codex",
          auth_index: authIndex,
          accountName: account.name,
          error: syncResult.error,
        },
        "Failed to sync Codex account status"
      );
    }
  }

  if ("error" in result) {
    return finalizeAccount({
      auth_index: authIndex,
      provider: providerForResponse,
      email: displayEmail,
      supported: true,
      error: result.error,
    });
  }

  return finalizeAccount({
    auth_index: authIndex,
    provider: providerForResponse,
    email: displayEmail,
    supported: true,
    groups: result,
  });
}
```

- [ ] **Step 5: Run the quota-route tests to verify they pass**

Run:

```bash
npm run test -- src/app/api/quota/route.test.ts
```

Expected: PASS for the new 401/403 tests and all pre-existing quota route tests.

- [ ] **Step 6: Commit the classification and sync wiring**

```bash
git add dashboard/src/app/api/quota/route.ts dashboard/src/app/api/quota/route.test.ts
git commit -m "feat(dashboard): sync codex auth failures to account status"
```

### Task 3: Add recovery, non-fatal sync failure, and dedupe coverage

**Files:**
- Modify: `dashboard/src/app/api/quota/route.test.ts`

- [ ] **Step 1: Add the failing recovery and non-fatal behavior tests**

Append these tests to `dashboard/src/app/api/quota/route.test.ts`:

```ts
it("restores Codex status to active after a successful quota probe", async () => {
  const authFilesResponse = {
    files: [
      {
        auth_index: 0,
        name: "codex_user@example.com.json",
        provider: "codex",
        email: "codex_user@example.com",
        disabled: false,
        status: "error",
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
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
      body: { cancel: vi.fn() },
    });

  const { GET } = await import("./route");
  const response = await GET(new Request("http://localhost/api/quota", { headers: { cookie: "session=test" } }) as unknown as NextRequest);
  const data = await response.json();

  expect(data.accounts[0].groups).toBeDefined();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "http://test:8317/v0/management/auth-files/status",
    expect.objectContaining({
      body: JSON.stringify({
        name: "codex_user@example.com.json",
        provider: "codex",
        status: "active",
        status_message: null,
        unavailable: false,
      }),
    })
  );
});

it("does not fail quota response when Codex status sync fails", async () => {
  const authFilesResponse = {
    files: [
      {
        auth_index: 0,
        name: "codex_user@example.com.json",
        provider: "codex",
        email: "codex_user@example.com",
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
          status_code: 401,
          body: JSON.stringify({ error: { message: "Unauthorized" } }),
        }),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("sync failed"),
      body: { cancel: vi.fn() },
    });

  const { GET } = await import("./route");
  const response = await GET(new Request("http://localhost/api/quota", { headers: { cookie: "session=test" } }) as unknown as NextRequest);
  const data = await response.json();

  expect(response.status).toBe(200);
  expect(data.accounts[0].error).toBe("Codex OAuth token expired - re-authenticate in CLIProxyAPI");
});
```

- [ ] **Step 2: Add the failing dedupe test**

Add this test to `dashboard/src/app/api/quota/route.test.ts`:

```ts
it("dedupes repeated identical Codex status sync writes", async () => {
  const authFilesResponse = {
    files: [
      {
        auth_index: 0,
        name: "codex_user@example.com.json",
        provider: "codex",
        email: "codex_user@example.com",
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
      json: () => Promise.resolve({ status_code: 401, body: JSON.stringify({}) }),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(authFilesResponse),
      body: { cancel: vi.fn() },
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status_code: 401, body: JSON.stringify({}) }),
      body: { cancel: vi.fn() },
    });

  const { GET } = await import("./route");

  const first = await GET(new Request("http://localhost/api/quota", { headers: { cookie: "session=test" } }) as unknown as NextRequest);
  await first.json();

  vi.resetModules();
  const { GET: GETAgain } = await import("./route");
  const second = await GETAgain(new Request("http://localhost/api/quota", { headers: { cookie: "session=test" } }) as unknown as NextRequest);
  await second.json();

  const statusWrites = fetchMock.mock.calls.filter(([url, options]) => {
    return url === "http://test:8317/v0/management/auth-files/status" && options?.method === "POST";
  });

  expect(statusWrites).toHaveLength(1);
});
```

- [ ] **Step 3: Make the dedupe test deterministic**

If the module reset interferes with in-memory state, switch the test to control time instead of resetting modules. Use this deterministic pattern inside the same test file:

```ts
vi.useFakeTimers();
vi.setSystemTime(new Date("2026-04-17T10:00:00Z"));
// first GET
vi.setSystemTime(new Date("2026-04-17T10:00:05Z"));
// second GET inside dedupe window
vi.useRealTimers();
```

The finished assertion still needs to prove that identical sync writes only happen once within the dedupe interval.

- [ ] **Step 4: Run the quota-route tests again**

Run:

```bash
npm run test -- src/app/api/quota/route.test.ts
```

Expected: PASS with the new recovery, non-fatal sync failure, and dedupe scenarios included.

- [ ] **Step 5: Commit the extended coverage**

```bash
git add dashboard/src/app/api/quota/route.test.ts
git commit -m "test(dashboard): cover codex status sync recovery and dedupe"
```

### Task 4: Verify read-path compatibility and final checks

**Files:**
- Test: `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts`
- Verify: `dashboard/src/app/api/quota/route.ts`
- Verify: `dashboard/src/lib/providers/management-api.ts`

- [ ] **Step 1: Confirm no listing contract change is needed**

Inspect `dashboard/src/lib/providers/__tests__/oauth-listing.test.ts` for existing assertions like:

```ts
expect(row.status).toBe("expired");
expect(row.statusMessage).toBe('{"message":"Token expired"}');
expect(row.unavailable).toBe(true);
```

If those assertions already exist and still pass, do not add redundant test code. If coverage is missing, add one regression test that constructs a row with `status`, `statusMessage`, and `unavailable` and proves the values remain visible to the listing layer.

- [ ] **Step 2: Run focused provider tests**

Run:

```bash
npm run test -- src/lib/providers/__tests__/management-api.test.ts src/lib/providers/__tests__/oauth-listing.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run diagnostics on touched source files**

Run language-server diagnostics for:

```text
dashboard/src/app/api/quota/route.ts
dashboard/src/lib/providers/management-api.ts
dashboard/src/app/api/quota/route.test.ts
dashboard/src/lib/providers/__tests__/management-api.test.ts
```

Expected: no errors.

- [ ] **Step 4: Run the full targeted verification batch**

Run:

```bash
npm run test -- src/app/api/quota/route.test.ts src/lib/providers/__tests__/management-api.test.ts src/lib/providers/__tests__/oauth-listing.test.ts
```

Expected: PASS for all targeted tests.

- [ ] **Step 5: Commit the verified implementation**

```bash
git add dashboard/src/app/api/quota/route.ts dashboard/src/lib/providers/management-api.ts dashboard/src/app/api/quota/route.test.ts dashboard/src/lib/providers/__tests__/management-api.test.ts
git commit -m "feat(dashboard): sync codex quota auth failures to oauth status"
```

## Self-Review Checklist

- Spec coverage:
  - 401 handling covered in Task 2.
  - 403 conservative handling covered in Task 2.
  - success recovery covered in Task 3.
  - best-effort non-fatal sync covered in Task 3.
  - dedupe covered in Task 3.
  - unchanged listing contract covered in Task 4.
- Placeholder scan:
  - No `TODO`, `TBD`, or unspecified “add tests later” steps remain.
- Type consistency:
  - `syncOAuthAccountStatus`, `SyncOAuthAccountStatusInput`, `statusMessage`, and `unavailable` are named consistently across helper and quota route steps.
