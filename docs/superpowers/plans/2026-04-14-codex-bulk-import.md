# Codex Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex bulk OAuth import from a JSON array using `email` as the auth-file identity source.

**Architecture:** Extend the existing single-import flow instead of inventing a second persistence path. The API route will accept a Codex-only bulk shape, generate internal `codex_[email].json` file names, call the current import helper per account, and return per-entry results for the UI to display.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Zod, Prisma, Vitest

---

### Task 1: Add failing provider-layer tests for bulk import helpers

**Files:**
- Create: `dashboard/src/lib/providers/__tests__/oauth-ops.test.ts`
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildCodexBulkImportFileName } from "@/lib/providers/oauth-ops";

describe("buildCodexBulkImportFileName", () => {
  it("builds a codex-prefixed file name from email", () => {
    expect(buildCodexBulkImportFileName("user@example.com")).toBe("codex_user@example.com.json");
  });

  it("sanitizes unsafe file-name characters", () => {
    expect(buildCodexBulkImportFileName("user/name@example.com")).toBe("codex_user_name@example.com.json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-ops.test.ts`
Expected: FAIL because `buildCodexBulkImportFileName` does not exist yet

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildCodexBulkImportFileName(email: string): string {
  const safeEmail = email.trim().replace(/[^a-zA-Z0-9@._-]+/g, "_");
  return `codex_${safeEmail}.json`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-ops.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/__tests__/oauth-ops.test.ts dashboard/src/lib/providers/oauth-ops.ts
git commit -m "test: add codex bulk import file naming coverage"
```

### Task 2: Add failing API route tests for Codex bulk import

**Files:**
- Create: `dashboard/src/app/api/providers/oauth/import/route.test.ts`
- Modify: `dashboard/src/app/api/providers/oauth/import/route.ts`
- Modify: `dashboard/src/lib/validation/schemas.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@/lib/auth/session", () => ({
  verifySession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/auth/rate-limit", () => ({
  checkRateLimitWithPreset: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock("@/lib/providers/dual-write", () => ({
  importOAuthCredential: vi.fn(),
  importBulkCodexOAuthCredentials: vi.fn(),
}));

describe("POST /api/providers/oauth/import", () => {
  it("accepts a codex bulk array and returns per-item results", async () => {
    const request = new NextRequest("http://localhost/api/providers/oauth/import", {
      method: "POST",
      body: JSON.stringify({
        provider: "codex",
        bulkCredentials: [
          { email: "user@example.com", access_token: "token" },
        ],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    expect(response.status).toBe(207);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/app/api/providers/oauth/import/route.test.ts`
Expected: FAIL because the route only supports single imports

- [ ] **Step 3: Write minimal implementation**

```ts
if (provider === OAUTH_PROVIDER.CODEX && Array.isArray(parsed.data.bulkCredentials)) {
  const result = await importBulkCodexOAuthCredentials(session.userId, parsed.data.bulkCredentials);
  return NextResponse.json({ data: result }, { status: 207 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/app/api/providers/oauth/import/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app/api/providers/oauth/import/route.test.ts dashboard/src/app/api/providers/oauth/import/route.ts dashboard/src/lib/validation/schemas.ts
git commit -m "test: cover codex bulk oauth import route"
```

### Task 3: Implement provider-layer bulk import orchestration

**Files:**
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("continues bulk import after an item failure", async () => {
  // mock single import helper to fail once, succeed once
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-ops.test.ts`
Expected: FAIL because bulk orchestrator does not exist

- [ ] **Step 3: Write minimal implementation**

```ts
export async function importBulkCodexOAuthCredentials(userId: string, credentials: CodexBulkCredentialInput[]) {
  const results = [];
  for (const credential of credentials) {
    const { email, ...payload } = credential;
    const fileName = buildCodexBulkImportFileName(email);
    const singleResult = await importOAuthCredential(userId, "codex", fileName, JSON.stringify(payload));
    results.push({ email, ...singleResult });
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-ops.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/providers/oauth-ops.ts dashboard/src/lib/providers/__tests__/oauth-ops.test.ts
git commit -m "feat: add codex bulk oauth import helper"
```

### Task 4: Update the provider import UI for Codex bulk JSON

**Files:**
- Modify: `dashboard/src/components/providers/oauth-section.tsx`
- Modify: `dashboard/src/components/providers/oauth-import-form.tsx`
- Modify: `dashboard/messages/en.json`
- Modify: `dashboard/messages/de.json`

- [ ] **Step 1: Write the failing test**

```ts
// add a component-level assertion for Codex bulk validation if a suitable test harness exists;
// otherwise write route-level tests first and manually validate this task in browser
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- --runInBand`
Expected: FAIL for the new validation expectation, or no suitable harness documented

- [ ] **Step 3: Write minimal implementation**

```ts
if (importProviderId === "codex" && Array.isArray(parsed)) {
  // validate every item has email and object payload fields
  // submit { provider: "codex", bulkCredentials: parsed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/providers/oauth-section.tsx dashboard/src/components/providers/oauth-import-form.tsx dashboard/messages/en.json dashboard/messages/de.json
git commit -m "feat: support codex bulk oauth import in provider UI"
```

### Task 5: Run verification and document behavior

**Files:**
- Modify: `docs/superpowers/specs/2026-04-14-codex-bulk-import-design.md`
- Modify: `docs/superpowers/plans/2026-04-14-codex-bulk-import.md`

- [ ] **Step 1: Run focused test suite**

Run: `cd dashboard && npm test -- src/lib/providers/__tests__/oauth-ops.test.ts src/app/api/providers/oauth/import/route.test.ts`
Expected: PASS

- [ ] **Step 2: Run broader safety checks**

Run: `cd dashboard && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 3: Record any deviations from the plan**

```md
Update the spec or plan docs if file names, response shape, or test scope changed during implementation.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-14-codex-bulk-import-design.md docs/superpowers/plans/2026-04-14-codex-bulk-import.md
git commit -m "docs: finalize codex bulk import plan and spec"
```
