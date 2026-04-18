# Security and Sync Hardening Design

## Summary

This design defines a risk-first remediation program for the dashboard that addresses the most credible security, state-consistency, and runtime-correctness issues discovered during review.

The implementation strategy is intentionally mixed:

1. **security findings may harden behavior even if requests that previously worked begin failing**
2. **non-security findings should remain conservative and minimize product-facing behavior changes**
3. **work should be staged so the highest-risk trust-boundary bugs are closed before deeper consistency and UX cleanup**

The resulting work is organized into three phases: security boundary hardening, sync/state consistency fixes, and correctness/operational cleanup.

## Goals

- Remove or strictly contain the global authentication bypass risk.
- Make origin validation fail closed for browser-originated mutating requests.
- Reduce trust in request-controlled forwarded headers for security decisions.
- Eliminate the most credible shared-config lost-update path in custom provider sync.
- Prevent dashboard success responses when provider sync only partially succeeded.
- Align config-sync and usage/auth-file parsing behavior across related code paths.
- Fix high-value runtime correctness issues without broad refactoring.
- Add targeted tests for each fix so regressions are caught close to the affected boundary.

## Non-Goals

- No broad auth-system rewrite.
- No distributed locking system in this iteration.
- No full redesign of management API contracts.
- No repository-wide conversion of every route to shared Zod validation in the same project.
- No large frontend redesign; UI work is limited to correctness and resilience fixes.
- No attempt to solve every operational limitation caused by single-instance assumptions in one pass.

## Current State

- `dashboard/src/lib/auth/session.ts` accepts `SKIP_AUTH=1` and returns a synthetic session for every caller.
- `dashboard/src/lib/auth/origin.ts` allows requests with no `Origin` and derives allowed origins partly from `x-forwarded-*` headers.
- `dashboard/src/lib/providers/custom-provider-sync.ts` performs unlocked read-modify-write updates against the shared `openai-compatibility` config.
- `dashboard/src/app/api/providers/perplexity-cookie/route.ts` updates dashboard state and then calls proxy sync, but the soft-failure result from sync is not surfaced to callers.
- Config-sync routes appear to use different effective inputs for bundle generation versus version hashing.
- Auth-file consumers in usage collection and OAuth operations parse different response shapes.
- `dashboard/src/app/global-error.tsx` depends on `useTranslations`, which may not be available in the global error boundary context.
- Some UI paths degrade failed loads into misleading empty states rather than persistent inline errors.

## Chosen Approach

Use a **risk-first phased hardening** plan:

### Phase 1: Security boundary hardening

Address issues that can weaken or collapse trust boundaries:

- `SKIP_AUTH` runtime bypass
- origin/CSRF validation behavior
- security decisions derived from forwarded headers
- related cookie security assumptions where those are coupled to the same trust model

This phase is allowed to change behavior because the current behavior is not safe enough.

### Phase 2: Sync and state-consistency fixes

Address bugs where the dashboard, proxy, and upstream-derived state can silently diverge:

- unlocked shared custom-provider sync
- Perplexity false-success flows
- config-sync version/bundle inconsistency
- auth-files response-shape mismatch between consumers

This phase should preserve contracts where possible and tighten only the affected internal logic.

### Phase 3: Correctness and operational cleanup

Address medium-value issues that reduce reliability, observability, or user trust:

- malformed JSON incorrectly surfacing as `500`
- missing delete-last-admin protection
- global-error rendering resilience
- false empty states on fetch failure
- selected i18n/date/accessibility correctness gaps
- clearly documented single-process limitations where not fixed directly

This phase should be conservative and avoid opportunistic refactors.

## Rejected Alternatives

### Quick wins first

Rejected because it would leave the most dangerous security and race-condition issues open while spending time on lower-risk polish work.

### Subsystem-by-subsystem execution only

Rejected as the primary framing because some of the highest-risk issues cut across subsystem boundaries, and a subsystem-first ordering would weaken risk prioritization.

### Single giant hardening refactor

Rejected because it increases blast radius, makes rollback harder, and mixes behavior-changing security work with routine correctness fixes.

## Architecture and Phase Design

## Phase 1: Security Boundary Hardening

### 1. Authentication bypass containment

Primary files:

- `dashboard/src/lib/auth/session.ts`
- `dashboard/src/app/api/auth/me/route.ts`
- related auth tests to be added near the auth library and route suites

Design requirements:

- Production runtime must not accept a process-wide auth bypass simply because `SKIP_AUTH=1` is present.
- If a development bypass remains at all, it must be explicitly constrained to safe contexts such as local development and/or test-only execution.
- The route-level representation of the current user must not silently elevate privileges beyond what the constrained bypass model explicitly allows.

Preferred outcome:

- remove the bypass from normal runtime logic entirely, or
- gate it behind an explicit dev/test-only policy that fails closed in production.

The implementation may keep a narrowly scoped testing/dev convenience, but it must no longer be possible to accidentally enable blanket session bypass on a deployed instance.

### 2. Origin validation hardening

Primary files:

- `dashboard/src/lib/auth/origin.ts`
- mutating route tests that already exercise origin validation behavior

Design requirements:

- Browser-originated mutating requests must be treated as forbidden unless origin validation passes.
- Missing `Origin` should not automatically pass on routes where the request is expected to come from browser fetch/XHR form interaction.
- Internal server-to-server paths that do not rely on browser cookies should not be broken by a blanket browser-origin policy.

The core design rule is:

- **fail closed for browser-like session-bearing mutation traffic**
- **permit explicitly trusted non-browser/internal flows only when they are identified by a different trust mechanism**

This preserves security hardening without indiscriminately breaking machine-to-machine operations.

### 3. Forwarded-header trust reduction

Primary files:

- `dashboard/src/lib/auth/origin.ts`
- `dashboard/src/lib/auth/session.ts`

Design requirements:

- Security decisions must not depend on untrusted forwarded headers unless the deployment model explicitly guarantees trusted proxy termination.
- Origin validation should prefer stable configured origins and request URL data over caller-controlled forwarded values.
- Cookie `secure` handling should not become weaker because a forwarded header is absent or spoofed.

This does not require a full proxy-awareness framework. The goal is to stop treating forwarded metadata as an unconditional source of truth for sensitive checks.

### 4. Scope boundary for Phase 1

Phase 1 is allowed to change request acceptance behavior. If some previously tolerated requests begin returning `403` or bypass no longer works outside local/test contexts, that is an intended hardening outcome.

## Phase 2: Sync and State-Consistency Fixes

### 1. Shared custom-provider sync serialization

Primary files:

- `dashboard/src/lib/providers/custom-provider-sync.ts`
- `dashboard/src/lib/providers/management-api.ts`
- related provider-sync tests to be added in `dashboard/src/lib/providers/__tests__/`

Design requirements:

- The shared `openai-compatibility` update path must no longer perform an unlocked read-modify-write sequence.
- Within a single process, writes to the shared provider list should be serialized consistently.
- The fix should reuse existing local coordination primitives if possible rather than inventing a second concurrency model.

Important boundary:

- This phase does **not** promise cross-process or distributed safety.
- It must, however, eliminate the concrete in-process lost-update path that exists today.

### 2. Perplexity sync result integrity

Primary files:

- `dashboard/src/app/api/providers/perplexity-cookie/route.ts`
- if needed, adjacent Perplexity sync helpers

Design requirements:

- A route must not imply provider provisioning or model sync succeeded if the proxy-sync step returned a soft failure.
- Prisma persistence and proxy-sync status should be reported distinctly when they differ.
- The response contract may be extended to expose partial success as long as the route remains backward-compatible where practical.

Preferred outcome:

- callers can distinguish `cookie saved` from `provider synced`
- logs retain enough detail for support/debugging
- no silent “works in dashboard, broken in proxy” success path remains

### 3. Config-sync consistency

Primary files:

- `dashboard/src/app/api/config-sync/version/route.ts`
- `dashboard/src/app/api/config-sync/bundle/route.ts`
- `dashboard/src/lib/config-sync/generate-bundle.ts`

Design requirements:

- Version calculation and bundle generation must be derived from the same effective input set for the same token/user context.
- If sync tokens are bound to an API key or visibility scope, both endpoints must honor that same scope.
- Clients must not be told a version hash that describes a different logical bundle than the one they would actually receive.

### 4. Auth-files response-shape alignment

Primary files:

- `dashboard/src/lib/usage/collector.ts`
- `dashboard/src/lib/providers/oauth-ops.ts`
- any helper that should centralize auth-file response parsing

Design requirements:

- All dashboard consumers of the management API auth-files payload should accept one normalized parsing path.
- If upstream shape differences must be tolerated for compatibility, that compatibility logic should live in one place rather than diverging across subsystems.
- Usage attribution and OAuth ownership flows should not disagree about what constitutes a valid auth-files payload.

Preferred outcome:

- introduce one parser/normalizer shared by both consumers, or
- otherwise make both call sites accept the same documented set of shapes.

## Phase 3: Correctness and Operational Cleanup

### 1. Malformed JSON should become `400`, not `500`

Primary files:

- selected API routes currently calling `await request.json()` inside broad catch blocks

Design requirements:

- invalid JSON at the request boundary must be treated as client validation failure.
- internal error logging should remain reserved for genuine server-side failures.
- this should be applied first to the highest-value sensitive routes rather than forcing a repo-wide cleanup in one step.

### 2. Delete-last-admin protection

Primary files:

- `dashboard/src/app/api/admin/users/route.ts`

Design requirements:

- deleting the final admin account must be rejected explicitly.
- self-delete protection should remain intact.
- the rule should be enforced server-side regardless of UI behavior.

### 3. Global error rendering resilience

Primary files:

- `dashboard/src/app/global-error.tsx`

Design requirements:

- the global error boundary must render without depending on app-level provider context that may be unavailable during root failures.
- localized copy is desirable, but the fallback error path must prioritize reliability over provider-dependent translation hooks.
- locale handling should not hardcode English unless the chosen fallback explicitly documents that trade-off.

### 4. False empty-state cleanup

Primary files:

- `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`

Design requirements:

- fetch failure must be represented as a persistent render-state error, not only a toast.
- empty-state UI must remain reserved for successful loads that actually return zero items.

### 5. Selected i18n and formatting correctness

Primary files:

- `dashboard/src/components/config-subscriber.tsx`
- `dashboard/src/components/dashboard-nav.tsx`
- `dashboard/src/app/dashboard/admin/users/page.tsx`

Design requirements:

- user-facing strings must use the existing i18n system.
- date/time formatting should align with app locale rather than hardcoded US English.
- accessibility labels should be localized as well.

These are lower-risk and should only be included after the higher-severity correctness fixes are planned.

## Testing Strategy

### Phase 1 tests

- add direct auth/session coverage for dev/test bypass containment behavior
- extend route-level origin tests to cover missing-origin rejection and allowed trusted flows
- verify hardened behavior on mutating endpoints already covered by route tests

### Phase 2 tests

- add provider-sync tests that prove serialized single-process updates for the shared config path
- add Perplexity route tests that distinguish DB success from proxy sync success/failure
- add config-sync tests proving version and bundle stay aligned under token-bound context
- add collector/provider tests using the same auth-files payload variants

### Phase 3 tests

- add targeted route tests for malformed JSON and last-admin deletion
- add a focused render test for `global-error.tsx`
- add component tests for persistent fetch-failure state and localized UI behavior where touched

The test suite should remain targeted. This project does not require broad e2e expansion for every fix.

## Verification Plan

Before implementation is considered complete:

- run targeted Vitest suites for each touched subsystem
- run broader regression tests for affected route groups where practical
- run `lsp_diagnostics` on touched files
- confirm no introduced TypeScript or lint regressions in modified areas

If work is split into multiple PRs or commits, each phase should have its own verification checkpoint.

## File Boundaries

### Security phase

- Modify: `dashboard/src/lib/auth/session.ts`
- Modify: `dashboard/src/app/api/auth/me/route.ts`
- Modify: `dashboard/src/lib/auth/origin.ts`
- Test: existing auth-sensitive route tests plus one or more new auth library tests

### Sync phase

- Modify: `dashboard/src/lib/providers/custom-provider-sync.ts`
- Modify: `dashboard/src/lib/providers/management-api.ts`
- Modify: `dashboard/src/app/api/providers/perplexity-cookie/route.ts`
- Modify: `dashboard/src/app/api/config-sync/version/route.ts`
- Modify: `dashboard/src/app/api/config-sync/bundle/route.ts`
- Modify: `dashboard/src/lib/config-sync/generate-bundle.ts`
- Modify: `dashboard/src/lib/usage/collector.ts`
- Modify: `dashboard/src/lib/providers/oauth-ops.ts`
- Test: `dashboard/src/lib/providers/__tests__/oauth-ops.test.ts`
- Test: `dashboard/src/lib/usage/__tests__/collector.test.ts`
- Test: targeted config-sync route or lib tests to be added near those files

### Correctness phase

- Modify: selected API routes with malformed JSON handling
- Modify: `dashboard/src/app/api/admin/users/route.ts`
- Modify: `dashboard/src/app/global-error.tsx`
- Modify: `dashboard/src/components/connected-accounts/connected-accounts-page.tsx`
- Modify: i18n/date correctness files only if still in scope after higher-priority work

## Open Decisions Resolved

- **Scope:** include all high and medium findings in the remediation plan.
- **Behavior changes:** use a mixed policy — conservative by default, but allow hardening-driven behavior changes for high-confidence security findings.
- **Execution ordering:** risk-first phases, not quick wins first.
- **Concurrency scope:** fix the concrete in-process race now; do not expand this project into distributed locking.
- **Frontend scope:** fix correctness and resilience issues, not a visual redesign.

## Scope Boundary for Next Step

The next step is to write an implementation plan for this phased hardening project.

That plan should:

- break each phase into small, test-first tasks,
- identify exact files to modify or add,
- keep Phase 1 independently deliverable,
- keep later phases conservative unless a security hardening requirement explicitly justifies behavior change.
