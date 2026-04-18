# Codex Revoked Check via Quota-Triggered Sync

## Summary

Add a quota-triggered status sync for Codex accounts so that when the dashboard detects a Codex authentication failure during quota collection, it updates the account status in the management API instead of only returning a runtime error. The implementation should stay server-side, keep the upstream auth-file metadata as the single source of truth, and avoid adding side effects to UI or listing paths.

## Current State

- `dashboard/src/app/api/quota/route.ts` already probes Codex quota through the management API and maps upstream failures into user-facing errors.
- `401` is currently treated as `"Codex OAuth token expired - re-authenticate in CLIProxyAPI"`.
- `403` is currently treated as access denied with optional detail text.
- `dashboard/src/lib/providers/oauth-ops.ts` already reads `status`, `status_message`, and `unavailable` from upstream `/auth-files` responses.
- The connected accounts UI already renders those upstream status fields and needs no major contract change.
- `dashboard/src/app/api/management/[...path]/route.ts` allowlists `auth-files/status`, but the dashboard does not actively use that path today.

## Goals

- Detect Codex auth failures during quota collection and sync them into upstream account status.
- Keep account status state upstream, not in dashboard-local storage.
- Reuse the existing connected-accounts status display path.
- Keep quota responses resilient even if status syncing fails.
- Minimize blast radius by limiting changes to quota orchestration and a focused management helper.

## Non-Goals

- No periodic background revoked checker.
- No UI-driven health probe on page load.
- No provider-agnostic status sync refactor in this iteration.
- No dashboard database overlay for OAuth health state.
- No model-scoped status state; Codex account status remains account-level.

## Chosen Approach

Use a quota-orchestrated sync flow:

1. Keep `fetchCodexQuota()` responsible for detecting quota/auth outcomes.
2. In the Codex branch of quota aggregation, classify the result into a sync-worthy status transition.
3. Call a dedicated server-side helper to update upstream auth-file status using a best-effort write.
4. Let existing OAuth listing and UI consume the updated upstream status through `/auth-files`.

This approach avoids mixing status mutation into the UI or listing path, preserves a single source of truth, and keeps the new write behavior close to the existing Codex quota signal.

## Rejected Alternatives

### Inline mutation inside `fetchCodexQuota()`

Rejected because it mixes read and write responsibilities in a low-level fetch helper, increases surprise side effects, and makes testing and reuse harder.

### Dashboard-local status overlay in Prisma

Rejected because it introduces a second source of truth, requires schema and merge logic changes, and significantly expands the maintenance surface.

## Architecture

### Detection point

The primary detection signal remains the Codex quota probe in:

- `dashboard/src/app/api/quota/route.ts`

The quota route already has the narrowest, highest-confidence signal for Codex auth validity because it observes actual provider responses.

### Sync point

The safest point for mutation is the Codex-specific orchestration branch in quota aggregation, after the quota outcome has already been classified.

That branch has enough context to:

- identify the Codex account being checked,
- distinguish success from auth failure,
- issue a best-effort status sync without polluting lower-level fetch utilities.

### Status writer

Add a focused server-side helper near existing management API helpers, preferably in:

- `dashboard/src/lib/providers/management-api.ts`

Responsibilities:

- accept the target Codex account identity,
- accept the target status payload,
- write to the upstream management API with a short timeout,
- log and return failure without throwing fatal errors into the quota path.

The helper should call the management API directly server-to-server, following the same pattern used elsewhere in server code, rather than routing through the dashboard's browser-facing `/api/management/...` proxy.

## State Mapping

### 401 from Codex quota probe

Treat as a high-confidence expired or revoked token signal.

Target upstream state:

- `status = "error"`
- `unavailable = true`
- `status_message = "Codex OAuth token expired - re-authenticate in CLIProxyAPI"`

### 403 from Codex quota probe

Do not classify as revoked automatically.

Target upstream state:

- `status = "error"`
- `unavailable = true`
- `status_message = "Codex access denied - account may need verification"`

If the existing error body provides useful upstream detail, that detail may be appended as long as the message remains stable and user-safe.

### Successful Codex quota probe after prior error

Treat as self-healing and restore healthy status upstream.

Target upstream state:

- `status = "active"`
- `unavailable = false`
- `status_message = null` or cleared equivalent expected by upstream

### Other failures

Do not expand the sync logic to every generic transport or parsing failure in the first iteration. Timeouts, management API transport errors, or malformed payloads should continue to behave as quota errors unless there is a high-confidence account-health signal.

## Failure Handling

### Sync failures must be non-fatal

If the dashboard cannot update upstream account status:

- the quota endpoint must still return its normal quota/error result,
- the sync failure should be logged,
- the user-facing quota behavior should remain unchanged from current expectations.

### Conservative 403 treatment

`403` is ambiguous. It may indicate verification requirements, policy restrictions, or other non-revocation conditions. The implementation must avoid mapping `403` to a stronger revoked state than the evidence supports.

### Dedupe and repeated writes

Repeated quota requests for the same account can trigger repeated identical state writes.

Add lightweight in-memory dedupe keyed by account and target status payload so that the same transition is not written continuously in a short interval. This dedupe is an optimization, not a correctness boundary; if the process restarts, writes may happen again.

## Boundaries and Responsibilities

### `dashboard/src/app/api/quota/route.ts`

- keep Codex quota detection and classification logic,
- invoke status sync only from the Codex aggregation path,
- do not push write logic into UI or account-listing code.

### `dashboard/src/lib/providers/management-api.ts` (or adjacent focused helper)

- contain the write-to-upstream logic,
- keep timeout and error handling localized,
- expose a small, provider-aware helper that quota orchestration can call.

### `dashboard/src/lib/providers/oauth-ops.ts`

- remain read-oriented,
- continue mapping upstream `status`, `status_message`, and `unavailable`,
- require no meaningful contract change for this feature.

## Data and Identity Considerations

- The synced health state is account-level, not model-level.
- If the current quota path knows a selected model, it may include that in logs or diagnostics only.
- The implementation should avoid introducing model-specific account state because token validity belongs to the account itself.

## Testing Strategy

Add or update tests covering:

1. `401` classification triggers sync to error/unavailable with the re-auth message.
2. `403` classification triggers sync to error/unavailable with a conservative verification-style message.
3. Successful Codex quota recovery triggers sync back to active.
4. Sync write failures do not fail the quota endpoint.
5. Dedupe prevents repeated identical writes during rapid repeated quota checks.
6. Existing listing behavior still renders synced upstream `status/statusMessage/unavailable` values without contract changes.

Prefer unit-level coverage around classification and sync invocation boundaries. Avoid expanding scope into full end-to-end provider orchestration unless existing tests already provide a low-cost place to add one.

## Verification Plan

Before considering the implementation complete:

- run targeted tests for the updated quota and provider helper behavior,
- run `lsp_diagnostics` on touched files,
- verify the connected accounts path still consumes status from `/auth-files` without regressions.

## Open Decisions Resolved

- **Passive UI check vs quota-triggered sync vs background check:** use quota-triggered sync.
- **401 handling:** treat as high-confidence auth expiration/revocation.
- **403 handling:** treat conservatively as denied/unavailable, not definitively revoked.
- **State storage:** upstream management API remains the single source of truth.
- **UI changes:** not required for the first iteration.

## Scope Boundary for Next Step

The next step is to create an implementation plan for the quota-triggered Codex status sync described here. That plan should stay narrowly scoped to server-side quota orchestration, the management helper, and the minimum necessary tests.
