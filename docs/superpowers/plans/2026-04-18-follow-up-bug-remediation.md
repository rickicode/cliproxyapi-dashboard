# Follow-up Bug Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the strongest remaining post-hardening bugs in fatal-error fallback, mutating route hardening, provider sync consistency, and connected-account identity/state handling.

**Architecture:** Tackle the remaining issues in descending risk order. First, remove the fatal-page dependency on translation context and close the missing origin-validation holes. Next, fix correctness bugs where shared config sync and user-scoped provider state can still diverge. Finally, clean up UI state identity collisions and misleading runtime error handling with narrow, test-backed changes.

**Tech Stack:** Next.js App Router, TypeScript, Prisma, Vitest, next-intl, existing auth/origin helpers, provider sync helpers

---

## Scope Check

This is intentionally a **follow-up plan** for the strongest remaining bugs after the earlier hardening work. It is not a broad redesign. It keeps the prior non-goals intact:

- no distributed locking redesign
- no broad auth architecture rewrite
- no large provider model redesign
- no test-infrastructure migration

---

## File Structure

- Modify: `dashboard/src/app/global-error.tsx`
  - Remove the remaining translation-dependent child dependency from the fatal fallback page.
- Modify: `dashboard/src/components/public-theme-toggle.tsx` **only if needed**
  - Use only if the fatal-page fix can be done more narrowly by making this component provider-independent.
- Test: `dashboard/src/app/global-error.test.tsx`
  - Add a focused regression that proves the fatal page renders without intl context.

- Modify: `dashboard/src/app/api/custom-providers/resync/route.ts`
  - Add origin validation for this mutating authenticated route.
- Test: `dashboard/src/app/api/custom-providers/resync/route.test.ts`
  - Add missing-origin and invalid-origin rejection coverage.

- Modify: `dashboard/src/app/api/set-locale/route.ts`
  - Add missing-origin protection and malformed JSON handling.
- Test: `dashboard/src/app/api/set-locale/route.test.ts`
  - Add route coverage for 403 invalid origin and 400 malformed JSON.

- Modify: `dashboard/src/app/api/custom-providers/[id]/route.ts`
  - Serialize delete-side `openai-compatibility` sync using the same provider mutex/hardening path as create/update.
- Test: `dashboard/src/app/api/custom-providers/[id]/route.test.ts`
  - Add targeted regression coverage that delete-side sync uses the serialized path and preserves shared config correctness.

- Modify: `dashboard/src/app/api/providers/perplexity-cookie/route.ts`
  - Make Perplexity provider ownership semantics consistent (per-user or explicitly global).
- Test: `dashboard/src/app/api/providers/perplexity-cookie/route.test.ts`
  - Add regression coverage for the chosen ownership model.

- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
  - Stop using `accountName` alone as the stable identity key for connected-account rows.
- Modify: `dashboard/src/lib/providers/oauth-listing.ts` **if the row type needs an explicit stable key field**.
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-table.tsx`
  - Update UI keying/loading/selection to use the stable identity key.
- Test: `dashboard/src/lib/providers/__tests__/oauth-ops.test.ts`
- Test: `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`
  - Add collision regression coverage.

- Modify: `dashboard/src/components/config-subscriber.tsx`
  - Distinguish load failure from “no subscription”.
- Test: `dashboard/src/components/config-subscriber.test.tsx` **or nearest existing config-sharing test file**
  - Add a focused regression for error-state behavior if there is an established local pattern; otherwise keep this task narrow and verify via nearest existing suite.

- Modify: `dashboard/src/lib/usage/collector.ts`
  - Make ownership attribution provider-aware when provider data is available.
- Test: `dashboard/src/lib/usage/__tests__/collector.test.ts`
  - Add same-email/same-name cross-provider collision coverage.

- Modify: `dashboard/src/app/api/config-sync/tokens/route.ts`
  - Change implicit sync-token binding from oldest key to newest key for consistency.
- Test: `dashboard/src/app/api/config-sync/tokens/route.test.ts`
  - Add explicit coverage for newest-key selection.

- Modify: remaining malformed-JSON routes:
  - `dashboard/src/app/api/model-preferences/route.ts`
  - `dashboard/src/app/api/update/dashboard/route.ts`
- Test: adjacent route test files for those routes, if present; otherwise create focused route tests beside them.

---

## Delivery Order

1. **Fatal fallback correctness**
2. **Missing origin validation on mutating routes**
3. **Delete-side sync serialization + Perplexity ownership consistency**
4. **Connected-account identity collision fix**
5. **Subscriber error state + provider-aware collector attribution**
6. **Config-sync token consistency + remaining malformed-JSON cleanup**

---

### Task 1: Make the fatal error page fully provider-independent

**Files:**
- Modify: `dashboard/src/app/global-error.tsx`
- Create or Modify Test: `dashboard/src/app/global-error.test.tsx`

- [ ] **Step 1: Write the failing regression test**

Create `dashboard/src/app/global-error.test.tsx` with a server-render test that imports `GlobalError` directly and renders it **without** any `NextIntlClientProvider`.

Use a test like:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "./global-error";

vi.mock("@/components/public-theme-toggle", () => ({
  PublicThemeToggle: () => <div>THEME_TOGGLE</div>,
}));

describe("GlobalError", () => {
  it("renders without intl provider context", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={new Error("boom")} reset={() => {}} />
    );

    expect(html).toContain("Something went wrong");
  });
});
```

Then adjust the mock/setup so the first run fails for the **real product reason**: the fatal page still includes a translation-dependent child in the actual tree.

- [ ] **Step 2: Run the test to verify the failure**

Run:

```bash
npm run test -- src/app/global-error.test.tsx
```

Expected: FAIL because the fatal page still depends on intl context through a child component.

- [ ] **Step 3: Implement the minimal provider-independent fix**

Prefer the narrowest production fix:

Option A (recommended): remove `PublicThemeToggle` from `global-error.tsx` entirely so the fatal page only uses self-contained UI.

If you apply Option A, the top of the file should change like this:

```tsx
import Link from "next/link";
import { getThemeBootstrapScript } from "@/lib/theme-script";
```

and delete:

```tsx
<PublicThemeToggle />
```

Do **not** broaden this into a theme-toggle redesign unless the test proves it is necessary.

- [ ] **Step 4: Re-run the fatal-page test**

Run:

```bash
npm run test -- src/app/global-error.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/global-error.tsx src/app/global-error.test.tsx
git commit -m "fix(dashboard): decouple fatal error page from intl context"
```

---

### Task 2: Close remaining origin-hardening holes on mutating routes

**Files:**
- Modify: `dashboard/src/app/api/custom-providers/resync/route.ts`
- Modify: `dashboard/src/app/api/set-locale/route.ts`
- Create or Modify Tests:
  - `dashboard/src/app/api/custom-providers/resync/route.test.ts`
  - `dashboard/src/app/api/set-locale/route.test.ts`

- [ ] **Step 1: Write the failing route tests**

Add these cases:

For `custom-providers/resync`:

```ts
it("returns 403 when origin is missing", async () => {
  const { POST } = await import("./route");
  const response = await POST(new NextRequest("http://localhost:3000/api/custom-providers/resync", { method: "POST" }));
  expect(response.status).toBe(403);
});
```

For `set-locale`:

```ts
it("returns 400 for malformed json", async () => {
  const { POST } = await import("./route");
  const request = new NextRequest("http://localhost:3000/api/set-locale", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: "{invalid-json",
  });
  const response = await POST(request);
  expect(response.status).toBe(400);
});
```

and:

```ts
it("returns 403 for invalid origin", async () => {
  const { POST } = await import("./route");
  const request = new NextRequest("http://localhost:3000/api/set-locale", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ locale: "en" }),
  });
  const response = await POST(request);
  expect(response.status).toBe(403);
});
```

- [ ] **Step 2: Run only those route tests**

Run:

```bash
npm run test -- src/app/api/custom-providers/resync/route.test.ts src/app/api/set-locale/route.test.ts
```

Expected: FAIL for missing origin / malformed JSON behavior.

- [ ] **Step 3: Implement the minimal fixes**

In `src/app/api/custom-providers/resync/route.ts`, change the signature to accept `request: NextRequest`, import `validateOrigin`, and add the standard guard:

```ts
export async function POST(request: NextRequest) {
  const session = await verifySession();
  if (!session) return Errors.unauthorized();

  const originError = validateOrigin(request);
  if (originError) return originError;

  const results = await resyncCustomProviders(session.userId);
```

In `src/app/api/set-locale/route.ts`, add the same `validateOrigin(request)` guard and a narrow JSON parse guard:

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

- [ ] **Step 4: Re-run the route tests**

Run:

```bash
npm run test -- src/app/api/custom-providers/resync/route.test.ts src/app/api/set-locale/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/custom-providers/resync/route.ts src/app/api/custom-providers/resync/route.test.ts src/app/api/set-locale/route.ts src/app/api/set-locale/route.test.ts
git commit -m "fix(dashboard): harden remaining mutating route boundaries"
```

---

### Task 3: Serialize delete-side custom-provider sync

**Files:**
- Modify: `dashboard/src/app/api/custom-providers/[id]/route.ts`
- Modify or Create Test: `dashboard/src/app/api/custom-providers/[id]/route.test.ts`

- [ ] **Step 1: Write the failing delete-sync regression**

Add a focused test that proves the delete path routes through serialized shared-config mutation instead of doing an unlocked read-modify-write inline.

Use the smallest viable assertion based on existing test patterns in that route file. If the route currently mocks management fetches, assert that the shared helper/mutex path is used. If not, add a focused test around the exact management API call sequence.

- [ ] **Step 2: Run the route test and verify it fails**

Run the single route suite containing the new regression.

- [ ] **Step 3: Implement the minimal delete-side serialization fix**

Preferred direction: extract the delete-side `openai-compatibility` removal into the same synchronized path already used elsewhere, instead of duplicating another unlocked management merge/PUT sequence.

Do not add new locking primitives. Reuse the existing provider mutex / sync machinery.

- [ ] **Step 4: Re-run the route test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/custom-providers/[id]/route.ts src/app/api/custom-providers/[id]/route.test.ts
git commit -m "fix(dashboard): serialize custom provider delete sync"
```

---

### Task 4: Make Perplexity provider ownership semantics consistent

**Files:**
- Modify: `dashboard/src/app/api/providers/perplexity-cookie/route.ts`
- Test: `dashboard/src/app/api/providers/perplexity-cookie/route.test.ts`

- [ ] **Step 1: Write the failing ownership regression**

Add a regression that proves the intended model explicitly.

Recommended intended model for this repo: **per-user provider ownership**, because the rest of the dashboard/provider config flow is user-scoped.

The test should model:
- existing `customProvider` with `providerId: "perplexity-pro"` belonging to another user
- current user uploads a valid cookie
- route should create/use a current-user-scoped provider instead of silently returning success without a usable provider

- [ ] **Step 2: Run the Perplexity route tests to verify failure**

```bash
npm run test -- src/app/api/providers/perplexity-cookie/route.test.ts
```

- [ ] **Step 3: Implement the minimal consistency fix**

Most likely change:

```ts
const existingProvider = await prisma.customProvider.findFirst({
  where: { providerId: "perplexity-pro", userId },
  include: { models: true },
});
```

Then keep the rest of the create/update logic user-scoped.

If other code assumes global singleton semantics, stop and revisit before broadening scope.

- [ ] **Step 4: Re-run the route tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/providers/perplexity-cookie/route.ts src/app/api/providers/perplexity-cookie/route.test.ts
git commit -m "fix(dashboard): make perplexity provider ownership user-scoped"
```

---

### Task 5: Fix connected-account identity collisions

**Files:**
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
- Modify: `dashboard/src/lib/providers/oauth-listing.ts` (if needed)
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-table.tsx`
- Test: `dashboard/src/lib/providers/__tests__/oauth-ops.test.ts`
- Test: `dashboard/src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx`

- [ ] **Step 1: Write the failing identity-collision tests**

Add one backend-facing regression and one UI-facing regression.

Backend regression: two rows with the same `accountName` but different providers should produce distinct action keys / identifiers.

UI regression: selection/loading should not collide when two rows share the same `accountName`.

- [ ] **Step 2: Run the targeted tests to verify failure**

```bash
npm run test -- src/lib/providers/__tests__/oauth-ops.test.ts src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
```

- [ ] **Step 3: Implement the minimal stable identifier**

Preferred approach:
- add a stable `actionKey`/`rowKey` composed from provider + accountName (or persisted id if already present in the row type)
- use that same stable key everywhere UI state currently uses plain `accountName`

Do not redesign the entire row model beyond what is needed for unique identity.

- [ ] **Step 4: Re-run the targeted tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/oauth-ops.ts src/lib/providers/oauth-listing.ts src/components/connected-accounts/connected-accounts-page.tsx src/components/connected-accounts/connected-accounts-table.tsx src/lib/providers/__tests__/oauth-ops.test.ts src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx
git commit -m "fix(dashboard): stabilize connected account identity keys"
```

---

### Task 6: Distinguish config-subscriber load errors from no-subscription state

**Files:**
- Modify: `dashboard/src/components/config-subscriber.tsx`
- Test: nearest existing config-sharing/component test file, if present

- [ ] **Step 1: Add a failing regression if a local test file already exists**

If there is an existing nearby test file for `config-subscriber`, add a regression showing failed status load does **not** render the subscription form.

If no local test file exists and adding one would require new test infrastructure, document that and keep this task implementation narrow.

- [ ] **Step 2: Implement minimal error state**

Add a separate `loadError` state in `config-subscriber.tsx`:

```ts
const [loadError, setLoadError] = useState<string | null>(null);
```

On fetch failure, set `loadError` instead of just `setStatus(null)`. Render an inline retry/error state when `loadError` is present. Keep “not subscribed” UI only for a real empty/404 status.

- [ ] **Step 3: Verify with the nearest existing test or focused manual logic check**

Run the smallest relevant verification command available.

- [ ] **Step 4: Commit**

```bash
git add src/components/config-subscriber.tsx
git commit -m "fix(dashboard): distinguish subscription load errors from empty state"
```

---

### Task 7: Make usage collector attribution provider-aware

**Files:**
- Modify: `dashboard/src/lib/usage/collector.ts`
- Test: `dashboard/src/lib/usage/__tests__/collector.test.ts`

- [ ] **Step 1: Write the failing attribution-collision regression**

Add a test showing two ownership records with the same `accountEmail` or `accountName` under different providers do not collapse to the same user when provider information is present.

- [ ] **Step 2: Run the collector tests to verify failure**

```bash
npm run test -- src/lib/usage/__tests__/collector.test.ts
```

- [ ] **Step 3: Implement provider-aware keying**

When provider information is available from auth-files or ownership data, key the map by a provider-qualified identity rather than a global email/name string.

Keep a conservative fallback only when the unscoped identity is unique.

- [ ] **Step 4: Re-run the collector tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage/collector.ts src/lib/usage/__tests__/collector.test.ts
git commit -m "fix(dashboard): scope usage attribution by provider"
```

---

### Task 8: Align sync-token creation with newest-key semantics

**Files:**
- Modify: `dashboard/src/app/api/config-sync/tokens/route.ts`
- Test: `dashboard/src/app/api/config-sync/tokens/route.test.ts`

- [ ] **Step 1: Write the failing route test**

Add a regression proving newly created sync tokens bind to the newest API key, not the oldest one.

- [ ] **Step 2: Run the route test to verify failure**

```bash
npm run test -- src/app/api/config-sync/tokens/route.test.ts
```

- [ ] **Step 3: Implement the minimal query fix**

Change:

```ts
orderBy: { createdAt: "asc" }
```

to:

```ts
orderBy: { createdAt: "desc" }
```

- [ ] **Step 4: Re-run the route test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/config-sync/tokens/route.ts src/app/api/config-sync/tokens/route.test.ts
git commit -m "fix(dashboard): bind sync tokens to newest api key"
```

---

### Task 9: Finish malformed-JSON hardening on remaining routes

**Files:**
- Modify: `dashboard/src/app/api/model-preferences/route.ts`
- Modify: `dashboard/src/app/api/update/dashboard/route.ts`
- Test: adjacent route test files, or create focused ones beside these routes if absent

- [ ] **Step 1: Write the failing malformed-JSON regressions**

Add route tests proving malformed JSON returns validation `400` instead of generic `500`.

- [ ] **Step 2: Run those route tests to verify failure**

- [ ] **Step 3: Apply the same narrow parse guard pattern used in Task 7**

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

- [ ] **Step 4: Re-run the route tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/model-preferences/route.ts src/app/api/update/dashboard/route.ts src/app/api/model-preferences/route.test.ts src/app/api/update/dashboard/route.test.ts
git commit -m "fix(dashboard): finish malformed json hardening"
```

---

## Final Verification Checklist

- [ ] Run the focused follow-up tests added by this plan.

- [ ] Run the broader verification command from the prior hardening work plus any new route/component tests from this plan.

```bash
npm run test -- src/lib/auth/session.test.ts src/app/api/auth/me/route.test.ts src/lib/auth/origin.test.ts src/app/api/providers/oauth/import/route.test.ts src/lib/providers/custom-provider-sync.test.ts src/app/api/providers/perplexity-cookie/route.test.ts src/lib/config-sync/generate-bundle.test.ts src/app/api/config-sync/version/route.test.ts src/lib/providers/auth-files.test.ts src/lib/providers/__tests__/oauth-ops.test.ts src/lib/usage/__tests__/collector.test.ts src/app/api/admin/users/route.test.ts src/components/connected-accounts/__tests__/connected-accounts-page.test.tsx src/components/providers/__tests__/oauth-section.test.tsx src/app/dashboard/quota/page.test.tsx
```

- [ ] Run typecheck and lint.

```bash
npm run typecheck && npm run lint
```

## Self-Review Notes

- **Spec coverage:** Covers all must-fix items and the strongest should-fix leftovers that were identified in the follow-up audit.
- **Placeholder scan:** All tasks specify concrete files, intended tests, commands, and implementation direction.
- **Type consistency:** Keeps naming focused on the actual current code paths: `validateOrigin`, `syncCustomProviderToProxy`, `ConnectedAccountsPage`, `parseAuthFilesResponse`, and sync-token routes.
