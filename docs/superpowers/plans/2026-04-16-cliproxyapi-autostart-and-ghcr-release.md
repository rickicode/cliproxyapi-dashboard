# CLIProxyAPI Autostart and GHCR Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `cliproxyapi` Docker lifecycle recovery so repo-managed operations reliably end with the service running, and make the dashboard image publish automatically to GHCR through the existing release workflow.

**Architecture:** Keep Docker Compose as the lifecycle source of truth and harden the repo’s update/rebuild paths rather than adding a watchdog or redesigning runtime management. Reuse the existing `.github/workflows/release.yml` publish pipeline and extend its trigger/conditions so the same GHCR target and tag scheme are published automatically on the intended release path.

**Tech Stack:** Next.js API routes, TypeScript, Vitest, Bash, Docker Compose, GitHub Actions, GHCR

---

## File Map

### Runtime/lifecycle hardening

**Modify**
- `dashboard/src/app/api/update/route.ts`
  - Make the compose path the clearly preferred recovery-safe path.
  - Tighten fallback/recovery behavior so repo-managed update operations are less likely to leave `cliproxyapi` absent.
- `rebuild.sh`
  - Clarify and harden the rebuild sequence so the post-condition is explicit: `cliproxyapi` should be running again after the script completes.
- `infrastructure/docker-compose.yml`
  - Preserve/clarify the intended `cliproxyapi` restart-policy lifecycle if needed by implementation.
- `docker-compose.local.yml`
  - Keep local parity if lifecycle policy comments/behavior need to match production intent.
- `docker-compose.yml`
  - Keep root local compose parity if needed.
- `install.sh`
  - Update generated systemd/unit or messaging only if needed to align startup/recovery semantics with the approved design.
- `docs/INSTALLATION.md`
  - Document the boot/startup and lifecycle expectations clearly.
- `docs/SERVICE-MANAGEMENT.md`
  - Clarify continuity-preserving vs destructive operations.
- `docs/RUNBOOK.md`
  - Add/update operator guidance for recovery-sensitive update/rebuild behavior.

**Create**
- `dashboard/src/app/api/update/route.test.ts`
  - Route-level regression coverage for update lifecycle branching and recovery behavior.

### GHCR automation

**Modify**
- `.github/workflows/release.yml`
  - Reuse the existing GHCR build/push/merge jobs.
  - Add automatic trigger/condition logic for the approved release path.
  - Preserve image target `ghcr.io/${{ github.repository }}/dashboard` and expected tags.

---

### Task 1: Add route-level regression tests for proxy update lifecycle

**Files:**
- Create: `dashboard/src/app/api/update/route.test.ts`
- Reference: `dashboard/src/app/api/admin/backup/route.test.ts`
- Reference: `dashboard/src/app/api/providers/oauth/route.test.ts`

- [ ] **Step 1: Write the failing update-route tests**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const verifySessionMock = vi.fn();
const validateOriginMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  verifySession: verifySessionMock,
}));

vi.mock("@/lib/auth/origin", () => ({
  validateOrigin: validateOriginMock,
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("POST /api/update", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    verifySessionMock.mockResolvedValue({ userId: "user-1" });
    validateOriginMock.mockReturnValue(null);
  });

  it("prefers the compose recreate path when compose is available", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, '{"isAdmin":true}', ""))
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, "compose-ok", ""))
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, "up-ok", ""));

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ type: "proxy" }),
      })
    );

    expect(response.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["compose", "-f", "/opt/cliproxyapi/infrastructure/docker-compose.yml", "up", "-d", "--no-deps", "--force-recreate", "cliproxyapi"]),
      expect.any(Function)
    );
  });

  it("attempts bounded recovery if the main update path fails", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, '{"isAdmin":true}', ""))
      .mockImplementationOnce((_cmd, _args, cb) => cb(new Error("compose failed"), "", "failed"))
      .mockImplementationOnce((_cmd, _args, cb) => cb(null, "recover-ok", ""));

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost/api/update", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ type: "proxy" }),
      })
    );

    expect(response.status).toBe(200);
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "docker",
      expect.arrayContaining(["compose", "-f", "/opt/cliproxyapi/infrastructure/docker-compose.yml", "up", "-d", "--no-deps", "cliproxyapi"]),
      expect.any(Function)
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm exec -- vitest run src/app/api/update/route.test.ts`

Expected: FAIL because the test file and/or assertions do not match current route behavior yet.

- [ ] **Step 3: Add the minimal test harness file**

```ts
// Create `dashboard/src/app/api/update/route.test.ts` with the mocked route tests above,
// adjusted to the route's actual helper imports and request body shape.
```

- [ ] **Step 4: Re-run the tests and confirm the current failures are the intended lifecycle gaps**

Run: `npm exec -- vitest run src/app/api/update/route.test.ts`

Expected: FAIL on the lifecycle-path assertions you intend to fix in Task 2.

- [ ] **Step 5: Commit the failing-test scaffold only after the task is made green in Task 2**

```bash
git add dashboard/src/app/api/update/route.test.ts
git commit -m "test(update): cover proxy update lifecycle paths"
```

### Task 2: Harden `POST /api/update` so repo-managed updates end in a running `cliproxyapi`

**Files:**
- Modify: `dashboard/src/app/api/update/route.ts`
- Test: `dashboard/src/app/api/update/route.test.ts`

- [ ] **Step 1: Use the failing route tests from Task 1**

Run: `npm exec -- vitest run src/app/api/update/route.test.ts`

Expected: FAIL on the compose-preference and/or recovery assertions.

- [ ] **Step 2: Make compose the clear primary path and tighten bounded recovery**

```ts
async function recreateWithCompose(): Promise<void> {
  await runCompose([
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    CONTAINER_NAME,
  ]);
}

async function recoverWithCompose(): Promise<void> {
  await runCompose(["up", "-d", "--no-deps", CONTAINER_NAME]);
}

export async function POST(request: NextRequest) {
  // ...existing auth/origin validation...

  try {
    await recreateWithCompose();
    return apiSuccess({ ok: true, restarted: true });
  } catch (primaryError) {
    logger.warn({ err: primaryError }, "Proxy update failed, attempting bounded recovery");

    try {
      await recoverWithCompose();
      return apiSuccess({ ok: true, restarted: true, recovered: true });
    } catch (recoveryError) {
      logger.error({ err: recoveryError }, "Proxy recovery failed after update error");
      return Errors.internal("Failed to update CLIProxyAPI");
    }
  }
}
```

- [ ] **Step 3: Keep fallback `docker run` only where truly needed**

```ts
// If the route currently supports a non-compose fallback, keep it behind explicit compose-unavailable detection.
// Do not lead with `docker rm -f cliproxyapi` when compose orchestration is available.
```

- [ ] **Step 4: Re-run the targeted route tests**

Run: `npm exec -- vitest run src/app/api/update/route.test.ts`

Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm exec -- tsc --noEmit`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/app/api/update/route.ts dashboard/src/app/api/update/route.test.ts
git commit -m "fix(update): harden cliproxyapi recovery path"
```

### Task 3: Clarify rebuild behavior so operators know what is destructive versus recovery-safe

**Files:**
- Modify: `rebuild.sh`
- Modify: `docs/SERVICE-MANAGEMENT.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/INSTALLATION.md`

- [ ] **Step 1: Write a failing shell-syntax / docs coherence checkpoint for yourself**

Use this checklist before editing:
- `rebuild.sh` must remain shell-valid
- docs must clearly distinguish:
  - continuity-preserving actions
  - destructive teardown actions
  - expected final state of `cliproxyapi`

- [ ] **Step 2: Update `rebuild.sh` messaging and sequence comments**

```bash
echo "Pulling latest images..."
docker compose pull --ignore-buildable

echo "Building dashboard image..."
docker compose build dashboard

echo "Recreating stack. This operation will temporarily replace containers, then restore them."
docker compose down
docker compose up -d

echo "Rebuild complete. Verifying cliproxyapi is running..."
docker compose ps cliproxyapi
```

- [ ] **Step 3: Update docs to distinguish safe vs destructive commands**

```md
## Container lifecycle guidance

- Prefer `docker compose up -d <service>` or route-level restart/update actions when you want the service to return immediately.
- `docker compose down` is a destructive teardown action: it removes the running stack before recreating it.
- After repo-managed update/rebuild flows complete successfully, `cliproxyapi` is expected to be running again.
```

- [ ] **Step 4: Verify shell syntax**

Run: `bash -n rebuild.sh`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add rebuild.sh docs/SERVICE-MANAGEMENT.md docs/RUNBOOK.md docs/INSTALLATION.md
git commit -m "docs(ops): clarify cliproxyapi lifecycle behavior"
```

### Task 4: Keep compose lifecycle intent explicit in tracked compose/install files

**Files:**
- Modify: `infrastructure/docker-compose.yml`
- Modify: `docker-compose.local.yml`
- Modify: `docker-compose.yml`
- Modify: `install.sh`

- [ ] **Step 1: Add minimal failing verification checklist**

Checklist to confirm after edits:
- production compose still has `restart: unless-stopped` for `cliproxyapi`
- local compose files stay aligned if touched
- generated service/install messaging does not contradict Docker lifecycle intent

- [ ] **Step 2: Make lifecycle intent explicit without redesigning restart policy**

```yaml
cliproxyapi:
  image: eceasy/cli-proxy-api-plus:latest
  restart: unless-stopped # Docker is the primary auto-restart mechanism for this service
```

```bash
# install.sh output/message example
print_status "CLIProxyAPI uses Docker restart policy 'unless-stopped'; stack startup is still enabled through the generated service."
```

- [ ] **Step 3: Verify compose syntax**

Run in repo root:
- `docker compose -f docker-compose.local.yml config`
- `docker compose -f docker-compose.yml config`

Run in `infrastructure/`:
- `docker compose config`

Expected: PASS for all three

- [ ] **Step 4: Verify install script syntax if edited**

Run: `bash -n install.sh`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add infrastructure/docker-compose.yml docker-compose.local.yml docker-compose.yml install.sh
git commit -m "chore(infra): clarify cliproxyapi autostart policy"
```

### Task 5: Make dashboard GHCR publish automatic in the existing release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Write the failing workflow expectations as an inline checklist**

Checklist:
- workflow must no longer be manual-only
- GHCR target must remain `ghcr.io/${{ github.repository }}/dashboard`
- tags must still include release version, `latest`, and `sha-<shortsha>`
- no second registry may be introduced

- [ ] **Step 2: Add the automatic trigger to `release.yml`**

```yaml
on:
  workflow_dispatch:
    inputs:
      release_type:
        description: "Release type"
        required: true
        default: patch
        type: choice
        options: [patch, minor, major]
  push:
    tags:
      - "v*"
```

> If the current workflow already relies on release-please outputs for `version`, adapt the trigger so automatic GHCR publishing happens on the approved release/tag path without breaking the existing manual path.

- [ ] **Step 3: Keep the existing image target and tag creation intact**

```yaml
env:
  IMAGE_NAME: ghcr.io/${{ github.repository }}/dashboard

# Preserve tag generation shape
TAGS=(
  "${IMAGE_NAME}:${VERSION}"
  "${IMAGE_NAME}:latest"
  "${IMAGE_NAME}:sha-${GITHUB_SHA::7}"
)
```

- [ ] **Step 4: Read back the workflow and verify the publish path is coherent**

Verify manually in the file:
- `build` still logs into `ghcr.io`
- `merge` still publishes manifest/tags
- automatic trigger reaches the same build/publish path

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): auto-publish dashboard image to ghcr"
```

### Task 6: Final verification

**Files:**
- Verify all changed files from Tasks 1-5

- [ ] **Step 1: Run focused route tests**

Run: `npm exec -- vitest run src/app/api/update/route.test.ts`

Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npm exec -- tsc --noEmit`

Expected: PASS

- [ ] **Step 3: Run shell/config verification**

Run from repo root:
- `bash -n rebuild.sh`
- `bash -n install.sh`
- `docker compose -f docker-compose.local.yml config`
- `docker compose -f docker-compose.yml config`

Run from `infrastructure/`:
- `docker compose config`

Expected: PASS for all commands

- [ ] **Step 4: Re-read the spec and verify coverage**

Checklist:
- `cliproxyapi` Docker lifecycle remains based on Compose restart policy
- repo-managed update/rebuild paths are hardened/recovery-sensitive
- docs distinguish continuity-preserving vs destructive operations
- GHCR dashboard image publish is no longer manual-only for the intended release path
- GHCR image target remains unchanged
- expected image tags remain preserved
- no extra registry or watchdog was added

- [ ] **Step 5: Commit any final verification-only adjustments if needed**

```bash
git add dashboard/src/app/api/update/route.test.ts dashboard/src/app/api/update/route.ts rebuild.sh install.sh infrastructure/docker-compose.yml docker-compose.local.yml docker-compose.yml .github/workflows/release.yml docs/INSTALLATION.md docs/SERVICE-MANAGEMENT.md docs/RUNBOOK.md
git commit -m "test(ops): finalize lifecycle and ghcr release verification"
```
