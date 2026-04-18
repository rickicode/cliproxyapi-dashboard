# Usage Collector Internal Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move periodic usage collection from external cron into the dashboard app itself so local and production both sync usage automatically.

**Architecture:** Extract the current `/api/usage/collect` business logic into a shared server-only collector module, then call that module from both the route wrapper and a new Node-runtime scheduler in `instrumentation-node.ts`. Keep the existing DB-backed collector lease as the cross-process guard, keep manual route-triggered collection working, and remove installer-managed cron as the primary sync mechanism.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Prisma 7, Vitest, Node runtime instrumentation

---

## File Map

### Create
- `dashboard/src/lib/usage/collector.ts` — shared server-only usage collector core used by route and scheduler
- `dashboard/src/lib/usage/__tests__/collector.test.ts` — unit tests for collector core behavior and result mapping
- `dashboard/src/app/api/usage/collect/route.test.ts` — route auth/origin/result-mapping tests
- `dashboard/src/instrumentation-node.test.ts` — scheduler registration and timer behavior tests

### Modify
- `dashboard/src/app/api/usage/collect/route.ts` — reduce to auth/origin wrapper + HTTP mapping
- `dashboard/src/instrumentation-node.ts` — register and run internal usage collector scheduler
- `install.sh` — stop creating usage collector cron and remove old cron if present
- `docs/CONFIGURATION.md` — explain internal scheduler and optional `COLLECTOR_API_KEY`
- `docs/INSTALLATION.md` — explain periodic usage sync no longer depends on cron
- `docs/CODEMAPS/backend.md` — update backend flow to mention shared collector core and scheduler

### Existing references to follow
- `dashboard/src/lib/quota-alerts.ts` — shared core pattern used by route + scheduler
- `dashboard/src/instrumentation-node.ts` — current startup/idempotent scheduler pattern
- `dashboard/src/app/api/quota/route.test.ts` — route test style reference
- `dashboard/src/lib/__tests__/async-pool.test.ts` — unit test style reference

---

### Task 1: Extract the shared usage collector core

**Files:**
- Create: `dashboard/src/lib/usage/collector.ts`
- Modify: `dashboard/src/app/api/usage/collect/route.ts`
- Test: `dashboard/src/lib/usage/__tests__/collector.test.ts`

- [ ] **Step 1: Write the failing collector-core test skeleton**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/providers/management-api", () => ({ syncKeysToCliProxyApi: vi.fn() }));

describe("runUsageCollector", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns skipped when collector lease is already held", async () => {
    const { runUsageCollector } = await import("@/lib/usage/collector");

    await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
      ok: false,
      skipped: true,
      reason: "collector-already-running",
    });
  });
});
```

- [ ] **Step 2: Run the new test to confirm it fails because the module does not exist yet**

Run: `npm run test -- src/lib/usage/__tests__/collector.test.ts`

Expected: FAIL with a module resolution error for `@/lib/usage/collector`.

- [ ] **Step 3: Create the shared collector module with explicit result types and a public entrypoint**

Create `dashboard/src/lib/usage/collector.ts` with this initial structure:

```ts
import "server-only";

import { randomUUID, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { syncKeysToCliProxyApi } from "@/lib/providers/management-api";

const CLIPROXYAPI_MANAGEMENT_URL = process.env.CLIPROXYAPI_MANAGEMENT_URL ?? "http://cliproxyapi:28317/v0/management";
const MANAGEMENT_API_KEY = process.env.MANAGEMENT_API_KEY ?? "";
const COLLECTOR_LEASE_STALE_MS = 15 * 60 * 1000;

export type UsageCollectorTrigger = "manual" | "scheduler" | "external";

export type UsageCollectorResult =
  | { ok: true; skipped: false; runId: string; collectedAt: string }
  | { ok: false; skipped: true; runId: string; reason: "collector-already-running" }
  | { ok: false; skipped: false; runId: string; reason: string; status: "error" };

export async function runUsageCollector(input: { trigger: UsageCollectorTrigger }): Promise<UsageCollectorResult> {
  const runId = randomUUID();

  if (!MANAGEMENT_API_KEY) {
    logger.error({ runId, trigger: input.trigger }, "MANAGEMENT_API_KEY is not configured");
    return { ok: false, skipped: false, runId, reason: "missing-management-api-key", status: "error" };
  }

  const leaseAcquired = await tryAcquireCollectorLease(new Date());
  if (!leaseAcquired) {
    logger.warn({ runId, trigger: input.trigger }, "Usage collection skipped: collector already running");
    return { ok: false, skipped: true, runId, reason: "collector-already-running" };
  }

  return { ok: true, skipped: false, runId, collectedAt: new Date().toISOString() };
}

async function tryAcquireCollectorLease(now: Date) {
  const staleBefore = new Date(now.getTime() - COLLECTOR_LEASE_STALE_MS);
  await prisma.collectorState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, lastStatus: "idle" },
  });

  const claim = await prisma.collectorState.updateMany({
    where: {
      id: 1,
      OR: [{ lastStatus: { not: "running" } }, { updatedAt: { lt: staleBefore } }],
    },
    data: { lastStatus: "running", errorMessage: null },
  });

  return claim.count === 1;
}
```

- [ ] **Step 4: Move route-private helpers into the shared module without changing behavior**

While editing `dashboard/src/lib/usage/collector.ts`, move these helpers out of `route.ts` and keep their logic intact:

```ts
async function markCollectorError(runId: string, errorMessage: string) {
  await prisma.collectorState.upsert({
    where: { id: 1 },
    update: {
      lastStatus: "error",
      errorMessage,
      lastRunId: runId,
      lastCollectedAt: new Date(),
    },
    create: {
      id: 1,
      lastStatus: "error",
      errorMessage,
      lastRunId: runId,
      lastCollectedAt: new Date(),
    },
  });
}

function usageDedupKey(input: {
  authIndex: string | null;
  model: string;
  timestamp: Date;
  source: string | null;
  totalTokens: number;
}) {
  return [input.authIndex ?? "", input.model, input.timestamp.toISOString(), input.source ?? "", String(input.totalTokens)].join("::");
}
```

Keep all existing route business rules intact while moving them into the shared file:
- usage fetch + auth-files fetch
- response parsing/type guards
- record construction
- `createMany(..., skipDuplicates: true)` persistence
- latency backfill batching
- success/error collector-state updates

- [ ] **Step 5: Update the public entrypoint so it returns structured outcomes for all cases**

Make `runUsageCollector()` return these result shapes:

```ts
if (!usageResponse.ok) {
  await markCollectorError(runId, "failed-to-fetch-usage-data");
  return { ok: false, skipped: false, runId, reason: "failed-to-fetch-usage-data", status: "error" };
}

return {
  ok: true,
  skipped: false,
  runId,
  collectedAt: collectedAt.toISOString(),
};
```

Use short machine-readable `reason` values such as:
- `missing-management-api-key`
- `collector-already-running`
- `proxy-service-unavailable`
- `failed-to-fetch-usage-data`
- `unexpected-usage-response`
- `usage-persist-failed`

- [ ] **Step 6: Replace inline collector logic in the route with a temporary import that still fails on response mapping**

Update `dashboard/src/app/api/usage/collect/route.ts` imports to include:

```ts
import { runUsageCollector } from "@/lib/usage/collector";
```

Replace the main body after auth/origin checks with:

```ts
const result = await runUsageCollector({ trigger: isCronAuth ? "external" : "manual" });

if (result.ok) {
  return NextResponse.json({ success: true, runId: result.runId, collectedAt: result.collectedAt });
}

if (result.skipped) {
  return NextResponse.json({ success: false, message: "Collector already running", runId: result.runId }, { status: 202 });
}

return Errors.internal("Usage collection failed");
```

- [ ] **Step 7: Expand collector-core tests to cover failure and success paths**

Add these tests to `dashboard/src/lib/usage/__tests__/collector.test.ts`:

```ts
it("returns structured failure when MANAGEMENT_API_KEY is missing", async () => {
  vi.stubEnv("MANAGEMENT_API_KEY", "");
  const { runUsageCollector } = await import("@/lib/usage/collector");

  await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
    ok: false,
    skipped: false,
    reason: "missing-management-api-key",
    status: "error",
  });
});

it("returns success when usage fetch and persistence complete", async () => {
  vi.stubEnv("MANAGEMENT_API_KEY", "devmanagementkey");
  vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://localhost:28317/v0/management");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ usage: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ auth_files: [] }), { status: 200 })));

  const { runUsageCollector } = await import("@/lib/usage/collector");
  await expect(runUsageCollector({ trigger: "scheduler" })).resolves.toMatchObject({
    ok: true,
    skipped: false,
  });
});
```

- [ ] **Step 8: Run the collector-core test file and make it pass**

Run: `npm run test -- src/lib/usage/__tests__/collector.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the collector-core extraction**

```bash
git add dashboard/src/lib/usage/collector.ts dashboard/src/lib/usage/__tests__/collector.test.ts dashboard/src/app/api/usage/collect/route.ts
git commit -m "refactor: extract shared usage collector core"
```

---

### Task 2: Convert the usage collect route into a thin wrapper

**Files:**
- Modify: `dashboard/src/app/api/usage/collect/route.ts`
- Test: `dashboard/src/app/api/usage/collect/route.test.ts`

- [ ] **Step 1: Write the failing route-wrapper tests**

Create `dashboard/src/app/api/usage/collect/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/errors", () => ({
  Errors: {
    unauthorized: () => new Response("unauthorized", { status: 401 }),
    forbidden: () => new Response("forbidden", { status: 403 }),
    internal: (message: string) => new Response(message, { status: 500 }),
  },
}));
vi.mock("@/lib/usage/collector", () => ({ runUsageCollector: vi.fn() }));

describe("POST /api/usage/collect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 when neither bearer auth nor session auth is valid", async () => {
    const { POST } = await import("./route");
    const request = new NextRequest("http://localhost:3000/api/usage/collect", { method: "POST" });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the route test to confirm it fails on incomplete wrapper behavior**

Run: `npm run test -- src/app/api/usage/collect/route.test.ts`

Expected: FAIL because the route still contains implementation details or does not yet match the mocked collector result flow.

- [ ] **Step 3: Reduce the route to auth/origin/result mapping only**

Update `dashboard/src/app/api/usage/collect/route.ts` so its main structure becomes:

```ts
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const isCronAuth = (() => {
    if (!COLLECTOR_API_KEY || !authHeader) return false;
    const expected = `Bearer ${COLLECTOR_API_KEY}`;
    if (authHeader.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
    } catch {
      return false;
    }
  })();

  if (!isCronAuth) {
    const session = await verifySession();
    if (!session) return Errors.unauthorized();

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { isAdmin: true },
    });

    if (!user?.isAdmin) return Errors.forbidden();

    const originError = validateOrigin(request);
    if (originError) return originError;
  }

  const result = await runUsageCollector({ trigger: isCronAuth ? "external" : "manual" });

  if (result.ok) {
    return NextResponse.json({ success: true, runId: result.runId, collectedAt: result.collectedAt });
  }

  if (result.skipped) {
    return NextResponse.json({ success: false, message: "Collector already running", runId: result.runId }, { status: 202 });
  }

  return Errors.internal("Usage collection failed");
}
```

- [ ] **Step 4: Expand route tests to cover all supported auth and result cases**

Append tests like:

```ts
it("returns 403 for non-admin session", async () => {
  const { verifySession } = await import("@/lib/auth/session");
  const { prisma } = await import("@/lib/db");
  vi.mocked(verifySession).mockResolvedValue({ userId: "user-1" } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ isAdmin: false } as never);

  const { POST } = await import("./route");
  const response = await POST(new NextRequest("http://localhost:3000/api/usage/collect", { method: "POST" }));

  expect(response.status).toBe(403);
});

it("returns 202 when collector result is skipped", async () => {
  vi.stubEnv("COLLECTOR_API_KEY", "collector-secret");
  const { runUsageCollector } = await import("@/lib/usage/collector");
  vi.mocked(runUsageCollector).mockResolvedValue({
    ok: false,
    skipped: true,
    runId: "run-1",
    reason: "collector-already-running",
  });

  const { POST } = await import("./route");
  const response = await POST(new NextRequest("http://localhost:3000/api/usage/collect", {
    method: "POST",
    headers: { authorization: "Bearer collector-secret" },
  }));

  expect(response.status).toBe(202);
});
```

Also add:
- admin-session success → `200`
- bearer-auth success → `200`
- collector failure → `500`

- [ ] **Step 5: Run the route-wrapper test file and make it pass**

Run: `npm run test -- src/app/api/usage/collect/route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the route-wrapper change**

```bash
git add dashboard/src/app/api/usage/collect/route.ts dashboard/src/app/api/usage/collect/route.test.ts
git commit -m "test: cover usage collector route wrapper"
```

---

### Task 3: Add the internal usage collector scheduler

**Files:**
- Modify: `dashboard/src/instrumentation-node.ts`
- Test: `dashboard/src/instrumentation-node.test.ts`

- [ ] **Step 1: Write the failing scheduler test skeleton**

Create `dashboard/src/instrumentation-node.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/quota-alerts", () => ({ runAlertCheck: vi.fn(), getCheckIntervalMs: vi.fn().mockResolvedValue(300000) }));
vi.mock("@/lib/providers/resync", () => ({ resyncCustomProviders: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/usage/collector", () => ({ runUsageCollector: vi.fn().mockResolvedValue({ ok: true, skipped: false, runId: "run-1", collectedAt: new Date().toISOString() }) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("registerNodeInstrumentation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("starts the usage scheduler after the startup delay", async () => {
    const mod = await import("./instrumentation-node");
    mod.registerNodeInstrumentation();

    await vi.advanceTimersByTimeAsync(60_000);

    const { runUsageCollector } = await import("@/lib/usage/collector");
    expect(runUsageCollector).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the scheduler test to confirm it fails before implementation**

Run: `npm run test -- src/instrumentation-node.test.ts`

Expected: FAIL because no usage scheduler is registered yet.

- [ ] **Step 3: Add a second scheduler guard and startup path in `instrumentation-node.ts`**

Update the global guard shape:

```ts
const globalForScheduler = globalThis as typeof globalThis & {
  __quotaSchedulerRegistered?: boolean;
  __usageCollectorSchedulerRegistered?: boolean;
};
```

Add to `registerNodeInstrumentation()`:

```ts
if (!globalForScheduler.__usageCollectorSchedulerRegistered) {
  globalForScheduler.__usageCollectorSchedulerRegistered = true;
  scheduleTimeout(() => {
    startUsageCollectorScheduler();
  }, 60_000);
}
```

Do not remove quota scheduler or provider resync startup.

- [ ] **Step 4: Implement `startUsageCollectorScheduler()` with recursive timers and in-process overlap guard**

Add this function to `dashboard/src/instrumentation-node.ts`:

```ts
function startUsageCollectorScheduler() {
  let isRunning = false;
  const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

  const run = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const result = await runUsageCollector({ trigger: "scheduler" });

      if (result.ok) {
        logger.info({ runId: result.runId, collectedAt: result.collectedAt }, "Scheduled usage collection completed");
      } else if (result.skipped) {
        logger.debug?.({ runId: result.runId, reason: result.reason }, "Scheduled usage collection skipped");
      } else {
        logger.warn({ runId: result.runId, reason: result.reason }, "Scheduled usage collection failed");
      }
    } catch (error) {
      logger.error({ error }, "Usage collector scheduler error");
    } finally {
      isRunning = false;
    }
  };

  const scheduleNext = async () => {
    await run();
    scheduleTimeout(scheduleNext, DEFAULT_INTERVAL_MS);
  };

  scheduleNext();
}
```

- [ ] **Step 5: Expand scheduler tests for idempotency and repeated scheduling**

Add tests like:

```ts
it("does not register duplicate usage schedulers", async () => {
  const mod = await import("./instrumentation-node");
  mod.registerNodeInstrumentation();
  mod.registerNodeInstrumentation();

  await vi.advanceTimersByTimeAsync(60_000);

  const { runUsageCollector } = await import("@/lib/usage/collector");
  expect(runUsageCollector).toHaveBeenCalledTimes(1);
});

it("schedules the next usage collection run after five minutes", async () => {
  const mod = await import("./instrumentation-node");
  mod.registerNodeInstrumentation();

  await vi.advanceTimersByTimeAsync(60_000);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

  const { runUsageCollector } = await import("@/lib/usage/collector");
  expect(runUsageCollector).toHaveBeenCalledTimes(2);
});
```

Also add a test where `runUsageCollector` rejects once and the second scheduled cycle still runs.

- [ ] **Step 6: Run the scheduler test file and make it pass**

Run: `npm run test -- src/instrumentation-node.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the internal scheduler**

```bash
git add dashboard/src/instrumentation-node.ts dashboard/src/instrumentation-node.test.ts
git commit -m "feat: add internal usage collection scheduler"
```

---

### Task 4: Remove installer-managed usage cron and update operational docs

**Files:**
- Modify: `install.sh`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/INSTALLATION.md`
- Modify: `docs/CODEMAPS/backend.md`

- [ ] **Step 1: Write a documentation-first checklist in the plan branch diff**

Before editing, confirm these exact doc statements need to exist after the change:

```md
- Periodic usage collection is performed by the dashboard app itself.
- `COLLECTOR_API_KEY` is optional and only needed for external/token-authenticated calls to `/api/usage/collect`.
- Production installs should not rely on an OS cron entry for usage collection.
```

- [ ] **Step 2: Remove usage cron creation from `install.sh`**

Delete the block that adds the usage collector cron job and replace it with cleanup logic shaped like:

```bash
# Remove legacy usage collector cron entry if present
if crontab -l 2>/dev/null | grep -q "/api/usage/collect"; then
  crontab -l 2>/dev/null | grep -v "/api/usage/collect" | crontab -
fi
```

If the installer currently prints operator instructions about the cron-based collector, remove or rewrite them so they describe the internal scheduler instead.

- [ ] **Step 3: Update `docs/CONFIGURATION.md` to reframe `COLLECTOR_API_KEY`**

Replace cron-oriented wording with wording like:

```md
### `COLLECTOR_API_KEY`

Optional. Protects external bearer-token calls to `POST /api/usage/collect`.

The dashboard's built-in usage scheduler does not require this value. Set it only if you want to trigger usage collection from external automation.
```

- [ ] **Step 4: Update `docs/INSTALLATION.md` and `docs/CODEMAPS/backend.md`**

Add or revise sections so they say:

```md
The dashboard starts its usage collector scheduler during Node-runtime startup. The scheduler reuses the same collector core as the manual `/api/usage/collect` route and runs periodically without OS cron.
```

In `docs/CODEMAPS/backend.md`, update any route flow that currently implies:

```md
POST /api/usage/collect -> inline route logic
```

to instead describe:

```md
POST /api/usage/collect -> auth/origin checks -> shared usage collector core -> Prisma collector state / usage records
```

- [ ] **Step 5: Run a targeted verification search for legacy cron-based statements**

Run: `rg -n "/api/usage/collect|COLLECTOR_API_KEY|cron" install.sh docs/CONFIGURATION.md docs/INSTALLATION.md docs/CODEMAPS/backend.md`

Expected:
- no installer logic still creates a usage collector cron entry
- docs describe the internal scheduler as primary
- any remaining `COLLECTOR_API_KEY` mentions describe it as optional external auth

- [ ] **Step 6: Commit the installer and docs changes**

```bash
git add install.sh docs/CONFIGURATION.md docs/INSTALLATION.md docs/CODEMAPS/backend.md
git commit -m "docs: document internal usage collection scheduler"
```

---

### Task 5: Verify the full change set

**Files:**
- Modify: none
- Verify: changed files above

- [ ] **Step 1: Run the focused automated test suite**

Run:

```bash
npm run test -- src/lib/usage/__tests__/collector.test.ts src/app/api/usage/collect/route.test.ts src/instrumentation-node.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript verification for the dashboard app**

Run: `npm run typecheck`

Expected: PASS with no new TypeScript errors.

- [ ] **Step 3: Run ESLint verification for the dashboard app**

Run: `npm run lint`

Expected: PASS with no new lint errors in collector, route, scheduler, or docs-adjacent source changes.

- [ ] **Step 4: Verify there is no remaining usage-cron installer path**

Run: `rg -n "/api/usage/collect.*cron|cron.*usage|usage collector cron" install.sh docs`

Expected: no remaining operator-facing instructions that present cron as the primary periodic collection mechanism.

- [ ] **Step 5: Smoke-check local runtime behavior by inspection or local run**

If you can run the app, use this sequence:

```bash
./dev-local.sh
```

Then confirm via logs or DB observation that:
- scheduler registers after startup
- a usage collection cycle runs without manual refresh
- `/dashboard/usage` shows a fresher `last synced` value after the cycle completes

If full runtime verification is not feasible, explicitly record that limitation and provide the exact manual verification steps above.

- [ ] **Step 6: Commit the final verification state**

```bash
git status
```

Expected: working tree clean after the prior commits, or only intentionally uncommitted files remain.

---

## Spec Coverage Check

- Shared collector core extraction: covered by Task 1
- Thin route wrapper: covered by Task 2
- Internal scheduler in Node runtime: covered by Task 3
- Five-minute interval and delayed startup behavior: covered by Task 3
- Retain current lease semantics: covered by Task 1 + Task 3
- Remove installer cron dependency: covered by Task 4
- Update docs to reflect internal scheduler and optional `COLLECTOR_API_KEY`: covered by Task 4
- Automated verification and runtime verification: covered by Task 5

## Placeholder Scan

No `TBD`, `TODO`, or deferred implementation placeholders remain in this plan. All code-writing steps include concrete file targets, commands, and example code structure.

## Type Consistency Check

The plan consistently uses:
- `runUsageCollector()` as the shared collector entrypoint
- `UsageCollectorResult` for structured results
- triggers: `manual`, `scheduler`, `external`

If implementation discovers that the existing route helper names are more ergonomic to preserve, update all tasks consistently before execution rather than mixing names.
