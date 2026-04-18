# Usage Collector Internal Scheduler Design

## Summary

Replace the usage collector's external cron dependency with an internal Node-runtime scheduler so usage synchronization runs automatically in both local development and production. The scheduler should reuse the same collector core as the manual `/api/usage/collect` route, preserve the existing DB-backed collector lease, and make the dashboard's “last synced” status reflect actual in-app periodic collection rather than an external automation requirement.

## Goal

Make usage collection run periodically from the dashboard application itself in both local and production environments, without requiring an OS-level cron job.

## Non-Goals

- Redesigning the collector lease into a heartbeat-based distributed lock
- Changing usage aggregation semantics or the `usageRecord` schema
- Removing the manual `/api/usage/collect` endpoint
- Redesigning the usage page UI
- Refactoring unrelated background tasks

## Current State

The usage dashboard currently gives the impression that data is refreshed periodically, but the actual collection mechanism is external:

- `dashboard/src/app/dashboard/usage/page.tsx` polls `/api/usage/history` every 5 minutes
- `/api/usage/history` only reads stored data and `collectorState.lastCollectedAt`
- actual collection happens in `dashboard/src/app/api/usage/collect/route.ts`
- periodic collection depends on a cron job installed by `install.sh`
- local development does not install or run that cron job
- production behavior depends on installer-generated automation rather than the application runtime itself

This mismatch makes the “last synced” timestamp appear stale in local development and creates two different operational models between local and production.

## Desired End State

After this change:

- the dashboard app starts an internal usage-collection scheduler in Node runtime
- local and production use the same periodic collection mechanism
- the shared collector logic is no longer embedded only inside the API route
- `/api/usage/collect` remains available for admin/manual or token-authenticated triggering
- production no longer relies on an installer-created usage cron job
- `COLLECTOR_API_KEY` remains optional and is not required for internal scheduling

## Approach Options

### Option A — Internal scheduler as the primary mechanism

Extract collector business logic into a shared server-only module and invoke it from both an internal scheduler and the manual route.

**Selected** because it removes the cron dependency cleanly, keeps local and production consistent, avoids internal HTTP loopback, and follows the existing quota scheduler pattern.

### Option B — Internal scheduler plus permanent external cron fallback

Add the internal scheduler but keep the production cron job indefinitely.

**Rejected** because it leaves two permanent trigger paths, makes behavior harder to reason about, and keeps operational ownership ambiguous.

### Option C — Internal scheduler that self-fetches `/api/usage/collect`

Add a scheduler in `instrumentation-node.ts` that performs an authenticated HTTP request back into the app route.

**Rejected** because it adds unnecessary loopback HTTP, depends on route auth shape, and is less clean than sharing collector logic directly.

## Design

### 1. Shared collector core

Extract the collector's business logic from `dashboard/src/app/api/usage/collect/route.ts` into a new server-only module, proposed at:

- `dashboard/src/lib/usage/collector.ts`

This module should own:

- management API configuration validation
- collector lease acquisition and skip handling
- usage and auth-files fetches
- key sync invocation if still required by the current collector flow
- persistence, dedupe-safe inserts, and latency backfill behavior
- collector success and error state updates

The module should return a structured result describing whether the run succeeded, skipped, or failed, with enough information for both scheduler logging and HTTP response mapping.

### 2. Thin route wrapper

Keep `dashboard/src/app/api/usage/collect/route.ts`, but reduce it to a wrapper responsible for:

- authentication and authorization
- origin validation for session-authenticated manual requests
- invoking the shared collector core
- mapping the collector result to HTTP responses

This preserves backward compatibility for admin refresh and optional external automation while removing duplicated collector behavior between manual and scheduled paths.

### 3. Internal scheduler registration

Add a dedicated usage scheduler to `dashboard/src/instrumentation-node.ts` using the same startup pattern already used for quota alerts:

- register only in Node runtime
- use a global idempotency guard to prevent duplicate registration during dev/HMR
- start after a startup delay
- use recursive `setTimeout(...).unref?.()` instead of `setInterval`
- catch and log errors without crashing the app

The scheduler should invoke the shared collector core directly, not through HTTP.

### 4. Scheduler behavior

The scheduler should behave as follows:

- enabled in both local and production
- startup delay of approximately 60 seconds to allow app, DB, and management API initialization
- default interval of 5 minutes to match current user expectations and previous cron cadence
- in-process overlap guard via local `isRunning`
- cross-process overlap control continues to rely on the existing DB-backed collector lease
- each run logs success, skip, or failure with enough detail to troubleshoot stale sync behavior

The scheduler should schedule the next cycle regardless of whether the current cycle succeeds or fails.

### 5. Lease and concurrency model

The current collector already uses a DB-backed lease in `collectorState`, which is stronger than the quota scheduler's in-memory overlap prevention alone. That lease should remain the cross-process coordination mechanism for the new scheduler.

This design deliberately keeps the existing stale-lease behavior unchanged:

- the stale window remains 15 minutes
- no heartbeat extension is introduced in this change

This means a very long-running collector could still be considered stale by another process. That is an existing behavior and remains acceptable for this scope because:

- duplicate runs are mitigated by dedupe-safe writes
- the immediate problem being solved is the lack of internal periodic scheduling

Any heartbeat-lock redesign is deferred to a separate follow-up if needed.

### 6. Manual and external trigger behavior

Manual admin refresh should continue to work as it does today from the user's perspective:

- admin refresh can still trigger collection immediately
- the usage page still reloads history after collect

External token-authenticated triggering may remain supported through `COLLECTOR_API_KEY`, but that key is no longer part of the application's own periodic scheduling path.

### 7. Production migration

Update installer/deployment behavior so usage collection is owned by the app runtime rather than an OS cron job.

This requires changes to:

- `install.sh`
- relevant documentation such as `docs/CONFIGURATION.md`, `docs/INSTALLATION.md`, or other operator-facing setup docs if they describe usage collection automation

Expected production migration behavior:

- new installs do not create the usage collector cron job
- reinstall/update paths remove or replace the legacy cron entry if present
- temporary overlap during rollout is tolerated because the collector lease should cause one side to skip in most cases

## File Categories

### Must change

- `dashboard/src/app/api/usage/collect/route.ts`
- `dashboard/src/instrumentation-node.ts`
- `install.sh`
- production/local docs that describe usage collection behavior

### Likely add

- `dashboard/src/lib/usage/collector.ts`
- tests for the new shared collector core and scheduler behavior

### Must not change in this scope

- `dashboard/src/app/dashboard/usage/page.tsx` behavior beyond what is required for compatibility
- collector lease semantics beyond reusing the current mechanism
- unrelated scheduler flows such as quota alerts or provider resync

## Error Handling

- Missing `MANAGEMENT_API_KEY` should fail fast in the shared collector result and be logged by the scheduler
- management API fetch failures should mark collector error state consistently with current behavior
- route responses should continue to distinguish success, skip, and failure outcomes
- scheduler errors must never terminate the server process
- history cache behavior in `/api/usage/history` remains unchanged; short-lived UI lag after a collect is acceptable

## Testing Strategy

### Shared collector core tests

Add tests covering:

- lease acquired → collector runs
- lease busy → collector returns skipped result
- missing management config → collector returns structured failure
- management API unavailable → collector marks error state
- success path → collector persists records and marks success state

These tests should mock Prisma, fetches, and any side-effect helpers used by the collector core.

### Route tests

Add or update route tests covering:

- unauthorized access without session or bearer auth
- non-admin session forbidden
- admin session allowed
- bearer `COLLECTOR_API_KEY` allowed
- route response mapping for success, skip, and failure results

### Scheduler tests

Add focused tests for `instrumentation-node.ts` behavior:

- registration guard prevents duplicate scheduler startup
- scheduler invokes the shared collector core
- scheduler schedules the next run after completion
- collector failures are logged but do not stop future scheduling

### Verification before completion

Before claiming the implementation complete, verify:

1. local development updates `collectorState.lastCollectedAt` without external cron
2. production no longer depends on a cron entry for usage collection
3. manual admin-triggered collect still works
4. legacy cron installation logic is removed or replaced
5. scheduler logs provide enough signal to diagnose skipped or failed runs

## Risks and Mitigations

### Risk: temporary double-trigger during rollout

If a production environment still has the old cron job while the new scheduler is active, both may attempt collection.

**Mitigation:** rely on the existing DB lease during rollout and remove legacy cron creation/retention in installer logic.

### Risk: duplicate scheduler registration in dev

HMR or repeated initialization can start multiple timers in development.

**Mitigation:** use a dedicated global registration guard, matching the existing quota scheduler pattern.

### Risk: long-running collection exceeds stale lease window

Another process could treat the current run as stale after 15 minutes.

**Mitigation:** explicitly keep this as known existing behavior, preserve dedupe-safe writes, and treat heartbeat locking as a separate future enhancement.

### Risk: scheduler silently fails without visibility

If internal runs fail but do not surface clearly, stale usage data may still be hard to diagnose.

**Mitigation:** add explicit logs for scheduler start, skip, success, and failure paths.

## Acceptance Criteria

The design is successful when all of the following are true:

- the dashboard app performs usage collection periodically in both local and production without relying on an OS cron job
- `last synced` updates automatically over time without requiring manual admin refresh
- manual `/api/usage/collect` remains available and functional
- internal scheduling does not require `COLLECTOR_API_KEY`
- installer/deployment automation no longer treats cron as the primary usage collector mechanism
- the implementation remains within current collector lease semantics and does not introduce unrelated architectural changes
