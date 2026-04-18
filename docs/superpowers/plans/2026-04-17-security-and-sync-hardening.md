# Security and Sync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the highest-risk security, state-consistency, and runtime-correctness bugs in the dashboard with a phased, test-first rollout that hardens security boundaries while keeping non-security fixes conservative.

**Architecture:** Deliver the work in three phases. Phase 1 hardens trust boundaries in auth/session and origin validation, and is allowed to change unsafe behavior. Phase 2 fixes sync/state divergence by reusing existing provider mutex infrastructure, aligning config-sync inputs, and unifying auth-file parsing. Phase 3 cleans up correctness and resilience issues with narrow route/component changes and targeted regression tests.

**Tech Stack:** Next.js App Router route handlers, TypeScript, Prisma, Vitest, next-intl, existing management API helpers

---

## File Structure

- Modify: `dashboard/src/lib/auth/session.ts`
  - Remove or strictly constrain `SKIP_AUTH` bypass behavior.
  - Stop deriving cookie security from request-controlled forwarded headers.
- Modify: `dashboard/src/app/api/auth/me/route.ts`
  - Remove the route-local bypass branch.
  - Keep the route fully dependent on the hardened session path.
- Create: `dashboard/src/lib/auth/session.test.ts`
  - Add direct coverage for dev/test bypass containment and production fail-closed behavior.
- Create: `dashboard/src/lib/auth/origin.test.ts`
  - Add direct coverage for missing-origin rejection rules and trusted-origin matching.
- Modify: `dashboard/src/lib/auth/origin.ts`
  - Make browser-like mutating traffic fail closed when `Origin` is missing or invalid.
  - Prefer configured/request URL origins over forwarded host/proto trust.
- Modify: `dashboard/src/app/api/providers/perplexity-cookie/route.ts`
  - Surface partial success when cookie persistence succeeds but provider sync fails.
- Modify: `dashboard/src/lib/providers/custom-provider-sync.ts`
  - Serialize `openai-compatibility` read-modify-write through `providerMutex`.
- Modify: `dashboard/src/lib/providers/management-api.ts`
  - Reuse the existing mutex and optionally export a shared config-key constant for the new lock call site.
- Create: `dashboard/src/lib/providers/custom-provider-sync.test.ts`
  - Add focused tests for create/update serialization and sync failure reporting.
- Modify: `dashboard/src/app/api/config-sync/version/route.ts`
  - Pass the token-bound API key into bundle generation.
- Modify: `dashboard/src/app/api/config-sync/bundle/route.ts`
  - Keep bundle behavior aligned with version behavior and add regression assertions if the response contract changes.
- Modify: `dashboard/src/lib/config-sync/generate-bundle.ts`
  - Centralize effective API key selection for version and bundle generation.
  - Stop using the oldest created API key when a newer/default path is intended.
- Create: `dashboard/src/lib/config-sync/generate-bundle.test.ts`
  - Add coverage for sync-token-bound key selection and deterministic version alignment.
- Modify: `dashboard/src/lib/usage/collector.ts`
  - Replace ad hoc auth-files parsing with a shared parser.
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
  - Reuse the same auth-files parser/normalizer as usage collection.
- Create: `dashboard/src/lib/providers/auth-files.ts`
  - Hold the shared auth-files response normalization logic.
- Create: `dashboard/src/lib/providers/auth-files.test.ts`
  - Add shape-compatibility tests for `{ files }`, `{ auth_files }`, and bare arrays.
- Modify: selected sensitive routes that call `await request.json()` inside broad catch blocks:
  - `dashboard/src/app/api/auth/login/route.ts`
  - `dashboard/src/app/api/setup/route.ts`
  - `dashboard/src/app/api/admin/users/route.ts`
  - `dashboard/src/app/api/config-sharing/publish/route.ts`
  - `dashboard/src/app/api/config-sharing/subscribe/route.ts`
  - Convert malformed JSON to `400`-class validation responses.
- Modify: `dashboard/src/app/api/admin/users/route.ts`
  - Reject deletion of the final admin.
- Modify: `dashboard/src/app/global-error.tsx`
  - Remove dependency on provider-scoped `useTranslations`.
  - Use a self-contained, resilient fallback copy path.
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
  - Add persistent inline error state instead of falling through to empty results on fetch failure.
- Modify: selected i18n correctness files if still in scope after the fixes above:
  - `dashboard/src/components/config-subscriber.tsx`
  - `dashboard/src/components/dashboard-nav.tsx`
  - `dashboard/src/app/dashboard/admin/users/page.tsx`
- Test: existing route and component suites, plus the new focused tests above.

## Delivery Order

1. **Phase 1:** Auth/session and origin hardening.
2. **Phase 2:** Shared sync serialization, Perplexity partial-success reporting, config-sync consistency, auth-files normalization.
3. **Phase 3:** Malformed JSON handling, delete-last-admin guard, global-error resilience, connected-accounts fetch-failure state, then i18n/date cleanup if time remains.

Work from `dashboard/` unless a step explicitly says repo root.

---

### Task 1: Contain the `SKIP_AUTH` bypass to safe contexts

**Files:**
- Modify: `dashboard/src/lib/auth/session.ts`
- Modify: `dashboard/src/app/api/auth/me/route.ts`
- Test: `dashboard/src/lib/auth/session.test.ts`

- [ ] **Step 1: Write the failing session tests**

Create `dashboard/src/lib/auth/session.test.ts` with these tests:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookiesMock = vi.fn();
const headersMock = vi.fn();
const verifyTokenMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
  headers: headersMock,
}));

vi.mock("./jwt", () => ({
  verifyToken: verifyTokenMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
    },
  },
}));

describe("verifySession hardening", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    cookiesMock.mockResolvedValue({ get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() });
    headersMock.mockResolvedValue(new Headers());
    verifyTokenMock.mockResolvedValue(null);
    findUniqueMock.mockResolvedValue(null);
  });

  it("returns null in production even when SKIP_AUTH=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SKIP_AUTH", "1");

    const { verifySession } = await import("./session");

    await expect(verifySession()).resolves.toBeNull();
  });

  it("allows the bypass only in test mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SKIP_AUTH", "1");

    const { verifySession } = await import("./session");

    await expect(verifySession()).resolves.toEqual({
      userId: "dev-user-id",
      username: "dev",
      sessionVersion: 0,
    });
  });
});
```

- [ ] **Step 2: Run the new session tests to verify they fail**

Run:

```bash
npm run test -- src/lib/auth/session.test.ts
```

Expected: FAIL because production still accepts `SKIP_AUTH=1`.

- [ ] **Step 3: Implement the minimal bypass containment in `session.ts`**

Update `dashboard/src/lib/auth/session.ts` to gate bypass behavior with a helper like this near the top of the file:

```ts
const SESSION_COOKIE_NAME = "session";

function allowDevAuthBypass(): boolean {
  return process.env.SKIP_AUTH === "1" && process.env.NODE_ENV === "test";
}

export const verifySession = cache(async (): Promise<SessionPayload | null> => {
  if (allowDevAuthBypass()) {
    return { userId: "dev-user-id", username: "dev", sessionVersion: 0 };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  // keep the remaining logic unchanged
});
```

Also update cookie security in the same file so `createSession()` no longer uses `x-forwarded-proto` as the deciding value:

```ts
const isSecure = process.env.NODE_ENV === "production";
```

- [ ] **Step 4: Remove the route-local bypass from `/api/auth/me`**

Update `dashboard/src/app/api/auth/me/route.ts` by deleting the `SKIP_AUTH` block entirely so the route begins like this:

```ts
export async function GET() {
  try {
    const session = await verifySession();

    if (!session) {
      return Errors.unauthorized();
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        username: true,
        isAdmin: true,
        createdAt: true,
      },
    });
```

- [ ] **Step 5: Re-run the session tests to verify they pass**

Run:

```bash
npm run test -- src/lib/auth/session.test.ts
```

Expected: PASS with 2 tests passing.

- [ ] **Step 6: Commit Phase 1 auth containment**

```bash
git add src/lib/auth/session.ts src/lib/auth/session.test.ts src/app/api/auth/me/route.ts
git commit -m "fix(dashboard): constrain auth bypass to test mode"
```

---

### Task 2: Harden origin validation and reduce forwarded-header trust

**Files:**
- Modify: `dashboard/src/lib/auth/origin.ts`
- Test: `dashboard/src/lib/auth/origin.test.ts`
- Test: `dashboard/src/app/api/providers/oauth/import/route.test.ts`

- [ ] **Step 1: Write the failing unit tests for origin validation**

Create `dashboard/src/lib/auth/origin.test.ts` with these tests:

```ts
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { validateOrigin } from "./origin";

describe("validateOrigin", () => {
  it("rejects mutating requests without an Origin header", () => {
    const request = new NextRequest("http://localhost:3000/api/admin/users", {
      method: "POST",
      headers: { host: "localhost:3000" },
    });

    const response = validateOrigin(request);

    expect(response?.status).toBe(403);
  });

  it("allows matching dashboard origin", () => {
    const request = new NextRequest("http://localhost:3000/api/admin/users", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
    });

    expect(validateOrigin(request)).toBeNull();
  });

  it("does not trust a spoofed forwarded host when the request URL origin does not match", () => {
    const request = new NextRequest("http://localhost:3000/api/admin/users", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });

    const response = validateOrigin(request);

    expect(response?.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the origin unit tests to verify they fail**

Run:

```bash
npm run test -- src/lib/auth/origin.test.ts
```

Expected: FAIL because missing `Origin` currently returns `null`.

- [ ] **Step 3: Implement fail-closed browser mutation behavior**

Update `dashboard/src/lib/auth/origin.ts` to remove the forwarded host/proto helpers and use a narrower origin allowlist. Replace the current exported function with this structure:

```ts
import { NextRequest, NextResponse } from "next/server";

function toUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizePort(protocol: string, port: string): string {
  if (!port) return "";
  if (protocol === "https:" && port === "443") return "";
  if (protocol === "http:" && port === "80") return "";
  return port;
}

function isSameOrigin(origin: URL, candidate: URL): boolean {
  return (
    origin.protocol === candidate.protocol &&
    origin.hostname === candidate.hostname &&
    normalizePort(origin.protocol, origin.port) === normalizePort(candidate.protocol, candidate.port)
  );
}

export function validateOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    const allowedCandidates = [requestUrl.origin, process.env.DASHBOARD_URL]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map(toUrl)
      .filter((value): value is URL => value !== null);

    const isAllowed = allowedCandidates.some((candidate) => isSameOrigin(originUrl, candidate));
    if (!isAllowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return null;
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
```

- [ ] **Step 4: Add one route-level regression test**

Append this test to `dashboard/src/app/api/providers/oauth/import/route.test.ts`:

```ts
it("returns 403 when a browser mutation omits the Origin header", async () => {
  const { POST } = await import("./route");

  const request = new NextRequest("http://localhost:3000/api/providers/oauth/import", {
    method: "POST",
    body: JSON.stringify({ provider: "codex", fileName: "auth.json" }),
    headers: {
      "content-type": "application/json",
      cookie: "session=test",
    },
  });

  const response = await POST(request);

  expect(response.status).toBe(403);
});
```

- [ ] **Step 5: Run the origin-focused tests to verify they pass**

Run:

```bash
npm run test -- src/lib/auth/origin.test.ts src/app/api/providers/oauth/import/route.test.ts
```

Expected: PASS with the new missing-origin assertions green.

- [ ] **Step 6: Commit the origin hardening**

```bash
git add src/lib/auth/origin.ts src/lib/auth/origin.test.ts src/app/api/providers/oauth/import/route.test.ts
git commit -m "fix(dashboard): fail closed on invalid browser origins"
```

---

### Task 3: Serialize shared custom-provider sync updates

**Files:**
- Modify: `dashboard/src/lib/providers/custom-provider-sync.ts`
- Modify: `dashboard/src/lib/providers/management-api.ts`
- Test: `dashboard/src/lib/providers/custom-provider-sync.test.ts`

- [ ] **Step 1: Write the failing custom-provider sync tests**

Create `dashboard/src/lib/providers/custom-provider-sync.test.ts` with these tests:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const invalidateProxyModelsCacheMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);
vi.stubEnv("CLIPROXYAPI_MANAGEMENT_URL", "http://test:8317/v0/management");
vi.stubEnv("MANAGEMENT_API_KEY", "secret-key");

vi.mock("@/lib/cache", () => ({
  invalidateProxyModelsCache: invalidateProxyModelsCacheMock,
}));

describe("syncCustomProviderToProxy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("serializes create/update through providerMutex", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue(release);

    vi.doMock("./management-api", () => ({
      providerMutex: { acquire },
    }));

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ "openai-compatibility": [] }), body: { cancel: vi.fn() } })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(""), body: { cancel: vi.fn() } });

    const { syncCustomProviderToProxy } = await import("./custom-provider-sync");

    const result = await syncCustomProviderToProxy(
      {
        providerId: "perplexity-pro",
        baseUrl: "http://perplexity-sidecar:8766/v1",
        apiKey: "sk-perplexity-sidecar",
        models: [{ upstreamName: "sonar-pro", alias: "sonar-pro" }],
        excludedModels: [],
      },
      "create"
    );

    expect(result).toEqual({ syncStatus: "ok" });
    expect(acquire).toHaveBeenCalledWith("openai-compatibility");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the custom-provider sync tests to verify they fail**

Run:

```bash
npm run test -- src/lib/providers/custom-provider-sync.test.ts
```

Expected: FAIL because the helper does not acquire `providerMutex` yet.

- [ ] **Step 3: Add single-process serialization to `custom-provider-sync.ts`**

Update `dashboard/src/lib/providers/custom-provider-sync.ts` so it imports the mutex and wraps the read-modify-write block:

```ts
import { providerMutex } from "@/lib/providers/management-api";

export async function syncCustomProviderToProxy(
  providerData: SyncProviderData,
  operation: "create" | "update",
  prefetchedConfig?: ManagementProviderEntry[]
): Promise<SyncResult> {
  const managementUrl = env.CLIPROXYAPI_MANAGEMENT_URL;
  const secretKey = env.MANAGEMENT_API_KEY;

  if (!secretKey) {
    return {
      syncStatus: "failed",
      syncMessage: "Backend sync unavailable - management API key not configured",
    };
  }

  const release = await providerMutex.acquire("openai-compatibility");
  try {
    // keep the existing fetch/merge/put logic inside this block unchanged
  } catch (syncError) {
    // keep the existing error path unchanged
  } finally {
    release();
  }
}
```

No new concurrency abstraction is needed. Reuse the existing mutex.

- [ ] **Step 4: Re-run the custom-provider sync tests to verify they pass**

Run:

```bash
npm run test -- src/lib/providers/custom-provider-sync.test.ts
```

Expected: PASS with the mutex acquisition assertion green.

- [ ] **Step 5: Commit the serialization fix**

```bash
git add src/lib/providers/custom-provider-sync.ts src/lib/providers/custom-provider-sync.test.ts
git commit -m "fix(dashboard): serialize shared custom provider sync"
```

---

### Task 4: Report Perplexity proxy-sync partial failures explicitly

**Files:**
- Modify: `dashboard/src/app/api/providers/perplexity-cookie/route.ts`
- Test: `dashboard/src/app/api/providers/perplexity-cookie/route.test.ts`

- [ ] **Step 1: Write the failing Perplexity route tests**

Create `dashboard/src/app/api/providers/perplexity-cookie/route.test.ts` with this focused case:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const checkRateLimitMock = vi.fn();
const findManyMock = vi.fn();
const updateManyMock = vi.fn();
const createMock = vi.fn();
const findUniqueProviderMock = vi.fn();
const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: validateOriginMock }));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimitWithPreset: checkRateLimitMock }));
vi.mock("@/lib/providers/perplexity", () => ({ isPerplexityEnabled: () => true }));
vi.mock("@/lib/db", () => ({
  prisma: {
    perplexityCookie: { findMany: findManyMock, updateMany: updateManyMock, create: createMock },
    customProvider: { findUnique: findUniqueProviderMock, create: vi.fn() },
  },
}));

describe("POST /api/providers/perplexity-cookie", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1", username: "alice", sessionVersion: 0 });
    validateOriginMock.mockReturnValue(null);
    checkRateLimitMock.mockReturnValue({ allowed: true });
    updateManyMock.mockResolvedValue({ count: 1 });
    createMock.mockResolvedValue({ id: "cookie-1", label: "Default", isActive: true, createdAt: new Date("2026-04-17T00:00:00Z") });
    findUniqueProviderMock.mockResolvedValue({ id: "cp-1", userId: "user-1", models: [] });

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [{ id: "sonar-pro" }] }), body: { cancel: vi.fn() } })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ "openai-compatibility": [] }), body: { cancel: vi.fn() } })
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom"), body: { cancel: vi.fn() } });
  });

  it("returns partial sync status when cookie save succeeds but proxy sync fails", async () => {
    const { POST } = await import("./route");

    const request = new NextRequest("http://localhost:3000/api/providers/perplexity-cookie", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ cookieData: JSON.stringify({ "next-auth.session-token": "token" }), label: "Default" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.syncStatus).toBe("failed");
    expect(data.syncMessage).toContain("may not work immediately");
  });
});
```

- [ ] **Step 2: Run the Perplexity route tests to verify they fail**

Run:

```bash
npm run test -- src/app/api/providers/perplexity-cookie/route.test.ts
```

Expected: FAIL because the route does not return `syncStatus` or `syncMessage` yet.

- [ ] **Step 3: Propagate sync result details through the route response**

Update `dashboard/src/app/api/providers/perplexity-cookie/route.ts` so `syncPerplexityProvider()` returns the sync status from `syncCustomProviderToProxy()`.

Use this result type:

```ts
async function syncPerplexityProvider(
  userId: string
): Promise<{ created: boolean; modelsUpdated: number; syncStatus: "ok" | "failed"; syncMessage?: string }> {
```

When creating the provider, capture and return the sync result:

```ts
const syncResult = await syncCustomProviderToProxy(
  {
    providerId: "perplexity-pro",
    baseUrl: SIDECAR_BASE_URL,
    apiKey: "sk-perplexity-sidecar",
    models,
    excludedModels: [],
  },
  "create"
);

return {
  created: true,
  modelsUpdated: models.length,
  syncStatus: syncResult.syncStatus,
  syncMessage: syncResult.syncMessage,
};
```

Do the same for the update path, and then expose the values in the route response:

```ts
let syncStatus: "ok" | "failed" = "ok";
let syncMessage: string | undefined;

try {
  const result = await syncPerplexityProvider(session.userId);
  providerProvisioned = result.created;
  modelsUpdated = result.modelsUpdated;
  syncStatus = result.syncStatus;
  syncMessage = result.syncMessage;
} catch (error) {
  logger.error({ err: error, userId: session.userId }, "Failed to sync perplexity-pro custom provider");
  syncStatus = "failed";
  syncMessage = "Backend sync failed - provider created but may not work immediately";
}

return NextResponse.json({
  cookie,
  providerProvisioned,
  modelsUpdated,
  syncStatus,
  syncMessage,
}, { status: 201 });
```

- [ ] **Step 4: Re-run the Perplexity route tests to verify they pass**

Run:

```bash
npm run test -- src/app/api/providers/perplexity-cookie/route.test.ts
```

Expected: PASS with the new partial-success response assertions green.

- [ ] **Step 5: Commit the Perplexity partial-success fix**

```bash
git add src/app/api/providers/perplexity-cookie/route.ts src/app/api/providers/perplexity-cookie/route.test.ts
git commit -m "fix(dashboard): expose perplexity sync partial failures"
```

---

### Task 5: Align config-sync version and bundle generation inputs

**Files:**
- Modify: `dashboard/src/app/api/config-sync/version/route.ts`
- Modify: `dashboard/src/lib/config-sync/generate-bundle.ts`
- Test: `dashboard/src/lib/config-sync/generate-bundle.test.ts`

- [ ] **Step 1: Write the failing config-sync tests**

Create `dashboard/src/lib/config-sync/generate-bundle.test.ts` with these tests:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.fn();
const findUniqueApiKeyMock = vi.fn();
const findFirstUserApiKeyMock = vi.fn();

vi.mock("@/lib/fetch-utils", () => ({ fetchWithRetry: fetchWithRetryMock }));
vi.mock("@/lib/db", () => ({
  prisma: {
    modelPreference: { findUnique: vi.fn().mockResolvedValue(null) },
    agentModelOverride: { findUnique: vi.fn().mockResolvedValue(null) },
    userApiKey: {
      findUnique: findUniqueApiKeyMock,
      findFirst: findFirstUserApiKeyMock,
      update: vi.fn().mockResolvedValue(null),
    },
    configSubscription: { findUnique: vi.fn().mockResolvedValue(null) },
    customProvider: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/lib/config-generators/opencode", () => ({
  buildAvailableModelsFromProxy: () => ({}),
  extractOAuthModelAliases: () => ({}),
  fetchModelsDevLimits: () => Promise.resolve({}),
  getProxyUrl: () => "http://localhost:8317",
  getInternalProxyUrl: () => "http://cliproxyapi:8317",
  inferModelDefinition: () => ({ name: "x", attachment: false, modalities: ["text"], context: 1, output: 1 }),
}));
vi.mock("@/lib/config-generators/shared", () => ({ fetchProxyModels: () => Promise.resolve([]) }));
vi.mock("@/lib/config-generators/oh-my-opencode", () => ({ buildOhMyOpenCodeConfig: () => ({}) }));
vi.mock("@/lib/config-generators/oh-my-opencode-slim", () => ({ buildSlimConfig: () => ({}) }));
vi.mock("@/lib/config-generators/oh-my-opencode-types", () => ({ validateFullConfig: () => undefined }));
vi.mock("@/lib/config-generators/oh-my-opencode-slim-types", () => ({ validateSlimConfig: () => undefined }));
vi.mock("@/lib/cache", () => ({ proxyModelsCache: { get: () => null, set: vi.fn() }, CACHE_TTL: { PROXY_MODELS: 60_000 }, CACHE_KEYS: { proxyModels: () => "proxy-models" } }));

describe("generateConfigBundle sync-key behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchWithRetryMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ files: [], "api-keys": [], "openai-compatibility": [] }), body: { cancel: vi.fn() } });
    findFirstUserApiKeyMock.mockResolvedValue({ id: "key-old", key: "sk-old" });
  });

  it("uses the sync-token-bound key when provided", async () => {
    findUniqueApiKeyMock.mockResolvedValue({ key: "sk-sync-bound" });

    const { generateConfigBundle } = await import("./generate-bundle");
    const bundle = await generateConfigBundle("user-1", "key-sync");

    expect(bundle.version).toEqual(expect.any(String));
    expect(findUniqueApiKeyMock).toHaveBeenCalledWith({
      where: { id: "key-sync" },
      select: { key: true },
    });
  });
});
```

- [ ] **Step 2: Run the config-sync tests to verify they fail or expose drift**

Run:

```bash
npm run test -- src/lib/config-sync/generate-bundle.test.ts
```

Expected: FAIL or require route alignment because `/api/config-sync/version` does not pass `syncApiKey` yet.

- [ ] **Step 3: Pass the token-bound key through the version route**

Update `dashboard/src/app/api/config-sync/version/route.ts` so it calls bundle generation exactly like the bundle route does:

```ts
export async function GET(request: NextRequest) {
  const authResult = await validateSyncTokenFromHeader(request);

  if (!authResult.ok) {
    return Errors.unauthorized();
  }

  try {
    const bundle = await generateConfigBundle(authResult.userId, authResult.syncApiKey);
    return NextResponse.json({ version: bundle.version });
  } catch (error) {
    return Errors.internal("Config sync version error", error);
  }
}
```

- [ ] **Step 4: Stop choosing the oldest user API key by default**

Update `dashboard/src/lib/config-sync/generate-bundle.ts` so the fallback user key query uses the newest key instead of the oldest:

```ts
prisma.userApiKey.findFirst({
  where: { userId },
  orderBy: { createdAt: "desc" },
  select: { id: true, key: true },
}),
```

Keep the existing `syncApiKey` override behavior, and do not change the rest of the bundle assembly in this step.

- [ ] **Step 5: Re-run the config-sync tests to verify they pass**

Run:

```bash
npm run test -- src/lib/config-sync/generate-bundle.test.ts
```

Expected: PASS with the sync-key lookup assertion green.

- [ ] **Step 6: Commit the config-sync alignment**

```bash
git add src/app/api/config-sync/version/route.ts src/lib/config-sync/generate-bundle.ts src/lib/config-sync/generate-bundle.test.ts
git commit -m "fix(dashboard): align config sync version with bundle scope"
```

---

### Task 6: Normalize auth-files parsing across usage and OAuth flows

**Files:**
- Create: `dashboard/src/lib/providers/auth-files.ts`
- Create: `dashboard/src/lib/providers/auth-files.test.ts`
- Modify: `dashboard/src/lib/usage/collector.ts`
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`

- [ ] **Step 1: Write the failing auth-files parser tests**

Create `dashboard/src/lib/providers/auth-files.test.ts` with these tests:

```ts
import { describe, expect, it } from "vitest";
import { parseAuthFilesResponse } from "./auth-files";

describe("parseAuthFilesResponse", () => {
  it("accepts a bare array response", () => {
    expect(parseAuthFilesResponse([{ name: "a.json", provider: "codex" }])).toEqual([
      { name: "a.json", provider: "codex" },
    ]);
  });

  it("accepts a { files } response", () => {
    expect(parseAuthFilesResponse({ files: [{ name: "a.json", provider: "codex" }] })).toEqual([
      { name: "a.json", provider: "codex" },
    ]);
  });

  it("accepts a { auth_files } response", () => {
    expect(parseAuthFilesResponse({ auth_files: [{ name: "a.json", provider: "codex" }] })).toEqual([
      { name: "a.json", provider: "codex" },
    ]);
  });
});
```

- [ ] **Step 2: Run the auth-files parser tests to verify they fail**

Run:

```bash
npm run test -- src/lib/providers/auth-files.test.ts
```

Expected: FAIL because `parseAuthFilesResponse` does not exist yet.

- [ ] **Step 3: Add the shared parser**

Create `dashboard/src/lib/providers/auth-files.ts` with this implementation:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAuthFilesResponse<T extends Record<string, unknown>>(value: unknown): T[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.files)
      ? value.files
      : isRecord(value) && Array.isArray(value.auth_files)
        ? value.auth_files
        : [];

  return entries.filter((entry): entry is T => isRecord(entry));
}
```

- [ ] **Step 4: Rewire both consumers to use the shared parser**

In `dashboard/src/lib/usage/collector.ts`, replace the current `entries` assignment with:

```ts
import { parseAuthFilesResponse } from "@/lib/providers/auth-files";

const authFilesJson: unknown = await authFilesResponse.json();
const entries = parseAuthFilesResponse<AuthFileEntry>(authFilesJson);
```

In `dashboard/src/lib/providers/oauth-ops.ts`, replace ad hoc `files` extraction with the same helper:

```ts
import { parseAuthFilesResponse } from "@/lib/providers/auth-files";

const payload: unknown = await response.json();
const files = parseAuthFilesResponse<Record<string, unknown>>(payload);
```

- [ ] **Step 5: Re-run the auth-files-related tests to verify they pass**

Run:

```bash
npm run test -- src/lib/providers/auth-files.test.ts src/lib/usage/__tests__/collector.test.ts src/lib/providers/__tests__/oauth-ops.test.ts
```

Expected: PASS with the new shared parser tests green and no regressions in collector/OAuth tests.

- [ ] **Step 6: Commit the auth-files normalization**

```bash
git add src/lib/providers/auth-files.ts src/lib/providers/auth-files.test.ts src/lib/usage/collector.ts src/lib/providers/oauth-ops.ts
git commit -m "fix(dashboard): normalize auth-files response parsing"
```

---

### Task 7: Convert malformed JSON on sensitive routes from `500` to `400`

**Files:**
- Modify: `dashboard/src/app/api/auth/login/route.ts`
- Modify: `dashboard/src/app/api/setup/route.ts`
- Modify: `dashboard/src/app/api/admin/users/route.ts`
- Modify: `dashboard/src/app/api/config-sharing/publish/route.ts`
- Modify: `dashboard/src/app/api/config-sharing/subscribe/route.ts`
- Test: `dashboard/src/app/api/admin/users/route.test.ts`

- [ ] **Step 1: Add one failing regression test on a sensitive route**

Create `dashboard/src/app/api/admin/users/route.test.ts` with this targeted case if the file does not exist, or append it if you create a broader suite:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({ verifySession: verifySessionMock }));
vi.mock("@/lib/auth/origin", () => ({ validateOrigin: validateOriginMock }));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimitWithPreset: () => ({ allowed: true }) }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: findUniqueMock } } }));

describe("POST /api/admin/users malformed JSON", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "admin-1", username: "admin", sessionVersion: 0 });
    validateOriginMock.mockReturnValue(null);
    findUniqueMock.mockResolvedValue({ isAdmin: true });
  });

  it("returns 400 when request JSON is invalid", async () => {
    const { POST } = await import("./route");

    const request = new NextRequest("http://localhost:3000/api/admin/users", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: "{invalid-json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the admin-user malformed JSON test to verify it fails**

Run:

```bash
npm run test -- src/app/api/admin/users/route.test.ts
```

Expected: FAIL because invalid JSON currently falls into the generic internal-error path.

- [ ] **Step 3: Add a tiny JSON parsing helper pattern to each sensitive route**

Use this pattern in each selected route before the broader `try/catch` logic proceeds:

```ts
let body: unknown;
try {
  body = await request.json();
} catch {
  return Errors.validation("Invalid JSON body");
}

if (!body || typeof body !== "object" || Array.isArray(body)) {
  return Errors.validation("Invalid request body");
}
```

Apply the same structure to:

- `src/app/api/auth/login/route.ts`
- `src/app/api/setup/route.ts`
- `src/app/api/admin/users/route.ts`
- `src/app/api/config-sharing/publish/route.ts`
- `src/app/api/config-sharing/subscribe/route.ts`

Do not broaden the refactor beyond these routes in this task.

- [ ] **Step 4: Re-run the malformed JSON regression test**

Run:

```bash
npm run test -- src/app/api/admin/users/route.test.ts
```

Expected: PASS with a `400` response.

- [ ] **Step 5: Commit the malformed JSON boundary fixes**

```bash
git add src/app/api/auth/login/route.ts src/app/api/setup/route.ts src/app/api/admin/users/route.ts src/app/api/config-sharing/publish/route.ts src/app/api/config-sharing/subscribe/route.ts src/app/api/admin/users/route.test.ts
git commit -m "fix(dashboard): treat malformed json as validation errors"
```

---

### Task 8: Prevent deletion of the final admin user

**Files:**
- Modify: `dashboard/src/app/api/admin/users/route.ts`
- Test: `dashboard/src/app/api/admin/users/route.test.ts`

- [ ] **Step 1: Add the failing last-admin deletion test**

Append this test to `dashboard/src/app/api/admin/users/route.test.ts`:

```ts
it("rejects deletion of the final admin account", async () => {
  const deleteMock = vi.fn();
  const countMock = vi.fn().mockResolvedValue(1);

  vi.doMock("@/lib/db", () => ({
    prisma: {
      user: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ isAdmin: true })
          .mockResolvedValueOnce({ id: "admin-2", username: "other-admin", isAdmin: true }),
        count: countMock,
        delete: deleteMock,
      },
    },
  }));

  const { DELETE } = await import("./route");

  const request = new NextRequest("http://localhost:3000/api/admin/users?userId=admin-2", {
    method: "DELETE",
    headers: { origin: "http://localhost:3000" },
  });

  const response = await DELETE(request);

  expect(response.status).toBe(400);
  expect(deleteMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the admin route tests to verify they fail**

Run:

```bash
npm run test -- src/app/api/admin/users/route.test.ts
```

Expected: FAIL because the route does not count remaining admins yet.

- [ ] **Step 3: Implement the final-admin guard**

Update the delete path in `dashboard/src/app/api/admin/users/route.ts` after the self-delete check:

```ts
if (targetUser.isAdmin) {
  const remainingAdminCount = await prisma.user.count({
    where: { isAdmin: true },
  });

  if (remainingAdminCount <= 1) {
    return Errors.validation("Cannot delete the last admin account");
  }
}
```

Keep the rest of the deletion flow unchanged.

- [ ] **Step 4: Re-run the admin route tests to verify they pass**

Run:

```bash
npm run test -- src/app/api/admin/users/route.test.ts
```

Expected: PASS with the last-admin guard assertion green.

- [ ] **Step 5: Commit the admin-protection fix**

```bash
git add src/app/api/admin/users/route.ts src/app/api/admin/users/route.test.ts
git commit -m "fix(dashboard): prevent deleting final admin"
```

---

### Task 9: Make the global error page self-contained and add persistent fetch-failure UI

**Files:**
- Modify: `dashboard/src/app/global-error.tsx`
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
- Test: `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`

- [ ] **Step 1: Add the failing connected-accounts error-state test**

Append this test to `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`:

```tsx
it("renders a persistent inline error when the page load fails", async () => {
  loadConnectedAccountsPageDataMock.mockRejectedValueOnce(new Error("boom"));

  render(<ConnectedAccountsPage />);

  await waitFor(() => {
    expect(screen.getByText(/failed to load connected accounts/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the connected-accounts component tests to verify they fail**

Run:

```bash
npm run test -- src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
```

Expected: FAIL because the component only shows a toast and then falls through to the empty table state.

- [ ] **Step 3: Add explicit error state to the connected accounts page**

Update `dashboard/src/components/connected-accounts/connected-accounts-page.tsx` with a minimal `loadError` state:

```ts
const [loadError, setLoadError] = useState<string | null>(null);
```

Clear it on load start:

```ts
setLoading(true);
setLoadError(null);
```

Set it in the error path:

```ts
runtime.applyError(requestId, () => {
  setLoadError(t("toastOAuthLoadFailed"));
  showToast(t("toastOAuthLoadFailed"), "error");
});
```

Render it before the table branch:

```tsx
{loading ? (
  <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-base)] p-6 text-sm text-[var(--text-muted)]">
    {tc("loading")}
  </div>
) : loadError ? (
  <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-6 text-sm text-rose-200">
    {loadError}
  </div>
) : (
  <>
    <ConnectedAccountsTable
      items={visibleItems}
      selectedActionKeys={selectedActionKeys}
      loadingActionKey={loadingActionKey}
      onToggleVisible={handleToggleVisible}
      onToggleRow={handleToggleRow}
      onRowAction={handleRowAction}
    />
    <ConnectedAccountsPagination
      page={currentPage}
      totalPages={totalPages}
      onPageChange={handlePageChange}
    />
  </>
)}
```

- [ ] **Step 4: Make `global-error.tsx` provider-independent**

Replace the translation hook usage in `dashboard/src/app/global-error.tsx` with static fallback copy so the component can render even when the root provider tree is broken:

```tsx
const copy = {
  fatalError: "Fatal error",
  somethingWentWrong: "Something went wrong",
  criticalError: "A critical error occurred while loading the application.",
  tryAgain: "Try again",
  goToDashboard: "Go to dashboard",
};
```

Then replace `t("...")` calls with `copy.fatalError`, `copy.somethingWentWrong`, `copy.criticalError`, `copy.tryAgain`, and `copy.goToDashboard`.

Also change the HTML tag to avoid hardcoding the locale to English in a misleading way:

```tsx
<html lang="en" suppressHydrationWarning>
```

Keep `lang="en"` only as an explicit fallback if no locale plumbing is available in the global error boundary.

- [ ] **Step 5: Re-run the connected-accounts tests to verify they pass**

Run:

```bash
npm run test -- src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
```

Expected: PASS with the persistent inline error assertion green.

- [ ] **Step 6: Commit the resilience fixes**

```bash
git add src/app/global-error.tsx src/components/connected-accounts/connected-accounts-page.tsx src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
git commit -m "fix(dashboard): harden error and empty-state fallbacks"
```

---

### Task 10: Localize remaining hardcoded strings and date formatting

**Files:**
- Modify: `dashboard/src/components/config-subscriber.tsx`
- Modify: `dashboard/src/components/dashboard-nav.tsx`
- Modify: `dashboard/src/app/dashboard/admin/users/page.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`

- [ ] **Step 1: Add the translation keys before touching components**

Add these keys to `dashboard/messages/en.json` and mirror them in `dashboard/messages/de.json` with matching structure:

```json
{
  "connectedAccounts": {
    "loadFailedInline": "Failed to load connected accounts. Try again."
  },
  "configSubscriber": {
    "shareCodeLabel": "Share code",
    "statusActive": "Active",
    "statusPaused": "Paused",
    "never": "Never"
  },
  "navigation": {
    "expandSidebar": "Expand sidebar",
    "collapseSidebar": "Collapse sidebar"
  }
}
```

Keep the exact nesting aligned with the existing namespace layout in each file.

- [ ] **Step 2: Replace the hardcoded strings in `config-subscriber.tsx`**

Update the component to use the existing translation hook and the new keys for:

```tsx
t("shareCodeLabel")
t("statusActive")
t("statusPaused")
t("never")
```

Also move any remaining hardcoded explanatory strings in that component into the same namespace.

- [ ] **Step 3: Localize the sidebar aria-label and admin date formatting**

In `dashboard/src/components/dashboard-nav.tsx`, change the aria label to:

```tsx
aria-label={isCollapsed ? t("expandSidebar") : t("collapseSidebar")}
```

In `dashboard/src/app/dashboard/admin/users/page.tsx`, replace hardcoded US formatting with the app locale-driven formatter already available in the page context. If the page already has `locale`, use:

```ts
new Date(value).toLocaleDateString(locale, {
  year: "numeric",
  month: "short",
  day: "numeric",
})
```

If no locale variable exists yet, add it through the page's existing i18n loading path instead of hardcoding `"en-US"`.

- [ ] **Step 4: Run the most relevant component/page tests**

Run:

```bash
npm run test -- src/components/providers/__tests__/oauth-section.test.tsx src/app/dashboard/quota/page.test.tsx src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
```

Expected: PASS with no translation-structure regressions.

- [ ] **Step 5: Commit the i18n cleanup**

```bash
git add src/components/config-subscriber.tsx src/components/dashboard-nav.tsx src/app/dashboard/admin/users/page.tsx messages/en.json messages/de.json
git commit -m "fix(dashboard): localize remaining account management copy"
```

---

## Final Verification Checklist

- [ ] Run the focused phase-1 tests:

```bash
npm run test -- src/lib/auth/session.test.ts src/lib/auth/origin.test.ts src/app/api/providers/oauth/import/route.test.ts
```

Expected: PASS.

- [ ] Run the focused phase-2 tests:

```bash
npm run test -- src/lib/providers/custom-provider-sync.test.ts src/app/api/providers/perplexity-cookie/route.test.ts src/lib/config-sync/generate-bundle.test.ts src/lib/providers/auth-files.test.ts src/lib/usage/__tests__/collector.test.ts src/lib/providers/__tests__/oauth-ops.test.ts
```

Expected: PASS.

- [ ] Run the focused phase-3 tests:

```bash
npm run test -- src/app/api/admin/users/route.test.ts src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
```

Expected: PASS.

- [ ] Run diagnostics/build-safety commands:

```bash
npm run typecheck
npm run lint
```

Expected: PASS with no new TypeScript or lint errors.

## Self-Review Notes

- **Spec coverage:** Phase 1 covers `SKIP_AUTH`, origin hardening, and forwarded-header trust reduction. Phase 2 covers custom provider race, Perplexity false-success, config-sync mismatch, and auth-files shape alignment. Phase 3 covers malformed JSON, last-admin deletion, global-error resilience, connected-accounts false empty state, and selected i18n/date cleanup.
- **Placeholder scan:** No `TODO`/`TBD` steps remain; each task specifies exact files, commands, and code snippets.
- **Type consistency:** Shared names used consistently across tasks: `allowDevAuthBypass`, `parseAuthFilesResponse`, `syncStatus`, and `syncMessage`.
