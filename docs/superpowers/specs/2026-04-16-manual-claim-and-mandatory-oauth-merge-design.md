# Manual Claim and Mandatory OAuth Merge Design

## Summary

This design fixes the dead Claim button on `/dashboard/providers` and makes OAuth ownership assignment mandatory after add, connect, and import flows.

The core policy change is:

1. every newly added OAuth credential must end in an ownership result
2. duplicate credentials should not fail with a conflict when they represent the same logical account
3. when an old credential and a new credential represent the same logical account, the system should keep using the new auth data
4. manual Claim remains available as an admin fallback for legacy or ambiguous cases

This work keeps the existing conservative ambiguity protection, but replaces duplicate-conflict behavior with deterministic merge-or-replace behavior when identity matching is safe.

## Goals

- Make the Claim button on `/dashboard/providers` actually work.
- Require auto-claim after successful OAuth add, connect, and import flows.
- Replace duplicate-conflict behavior with merge behavior when old and new auth belong to the same logical account.
- Prefer the newly received auth data over old auth data when a duplicate is detected safely.
- Keep ambiguous cases safe by refusing to guess.
- Preserve a manual admin fallback for legacy unclaimed or unresolved accounts.

## Non-Goals

- No bulk claim management UI.
- No broad ownership-transfer console for arbitrary accounts.
- No automatic guessing when multiple candidate accounts match weakly.
- No schema redesign that changes the fundamental ownership table shape unless implementation proves it is required.

## Current State

- `/dashboard/providers` renders Claim through `dashboard/src/components/providers/oauth-preview-card.tsx`, but currently passes `onClaim={() => undefined}`.
- Manual claim backend logic already exists in `dashboard/src/app/api/providers/oauth/claim/route.ts`, but the providers page does not call it.
- Auto-claim logic already exists for OAuth callback flows in `dashboard/src/app/api/management/oauth-callback/route.ts` and `dashboard/src/lib/providers/oauth-auto-claim.ts`.
- Import flow ownership creation currently lives in `dashboard/src/lib/providers/oauth-ops.ts` and returns duplicate-style conflicts instead of merging.
- Ownership uniqueness is enforced by `ProviderOAuthOwnership.accountName @unique` in `dashboard/prisma/schema.prisma`.
- Current duplicate handling is conservative and conflict-oriented rather than merge-oriented.

## Design Overview

Introduce one shared ownership-resolution path used by manual claim, OAuth connect, OAuth no-callback polling, add/register, and import.

This shared path will decide one of these outcomes for a newly observed credential:

- create ownership for a new logical account
- confirm the current user already owns the logical account
- merge/replace an existing logical account with the newly received auth data
- refuse automatic ownership because the match is ambiguous
- report a hard error when required system operations fail

The system should no longer treat safe duplicates as conflicts. Instead, it should fold them into the existing logical account while preferring the newest auth credential.

## Identity and Merge Rules

### Logical account identity

Identity matching should use this order:

1. **Primary match: `accountName`**
   - If the new auth file has the same `accountName` as an existing owned or unowned account, it is the same logical account.

2. **Fallback match: `provider + normalized accountEmail`**
   - Only used when `accountName` changed or the management layer emitted a different file name for the same external login.
   - Only valid when exactly one existing account matches that provider/email pair.

3. **Otherwise ambiguous or unmatched**
   - If multiple provider/email matches exist, automatic merge must not guess.

### Merge semantics

When a new credential matches an existing logical account safely:

- the new credential becomes the canonical auth credential
- old ownership metadata is preserved where still valid
- `provider`, `accountEmail`, and any other derived metadata should be refreshed from the new credential if the new values are present
- the system should not return a duplicate conflict for this case

### Preferred source of truth

If old auth and new auth refer to the same logical account, the system should prefer the **new auth data**.

That means implementation should replace or repoint ownership toward the newly created or newly uploaded auth record rather than preserving the stale one by default.

## Shared Ownership Resolver

Create a shared helper in `dashboard/src/lib/providers/` to centralize ownership decisions.

Responsibilities:

- receive the current user, provider, new auth-file metadata, and optional existing auth snapshot data
- identify the target logical account by the identity rules above
- decide whether to create, confirm-existing, merge-replace, mark ambiguous, or return error
- provide a normalized result shape usable by APIs and UI code

### Result states

The shared resolver should normalize to a small explicit set such as:

- `claimed`
- `already_owned_by_current_user`
- `merged_with_existing`
- `claimed_manually`
- `ambiguous`
- `no_match`
- `claimed_by_other_user`
- `error`

The exact strings can be finalized during implementation, but one normalized shared shape must be used across flows.

## Flow-by-Flow Behavior

### 1. Manual Claim on `/dashboard/providers`

The existing Claim button should become a real admin action.

Behavior:

- clicking Claim calls `/api/providers/oauth/claim`
- loading/disabled state is driven by the selected account name
- success refreshes the provider account list and shows a success toast
- failure shows a specific error toast

The API itself should use the shared ownership resolver so manual claim and auto-claim obey the same duplicate and merge rules where applicable.

### 2. OAuth connect with callback

After the management callback succeeds and the new auth file is identified:

- the callback route must invoke the shared ownership resolver
- if the credential is a safe duplicate, the resolver should merge and prefer the new auth data
- if the credential is already owned by the same user, return a success-like state rather than a conflict
- if multiple candidates exist, return `ambiguous` and do not auto-assign ownership blindly

### 3. OAuth connect without callback

The no-callback polling flow should use the same resolver and same result-state contract as the callback flow.

The frontend must not need separate reasoning for callback and device-code/no-callback providers.

### 4. Import flow

Import must stop treating safe duplicates as hard conflicts.

Behavior:

- after upload succeeds, the import flow identifies the new auth file
- the shared resolver decides create vs merge vs ambiguous
- if a duplicate logical account is detected safely, import succeeds and the new auth replaces the old one
- only truly ambiguous cases or infrastructure failures should block ownership assignment

### 5. Add/register flow

Any add/register path that currently writes directly to `ProviderOAuthOwnership` must also route through the shared ownership resolver.

This keeps add, connect, and import behavior aligned instead of having different duplicate semantics.

## Management/Auth Replacement Strategy

The dashboard does not own the underlying auth files directly; the management API does.

So implementation must make a clear distinction between:

- **ownership merge**: update dashboard ownership metadata to point at the logical account represented by the newest auth file
- **auth replacement**: ensure the new management-side auth file is the one considered canonical going forward

Design requirement:

- if the management layer creates a new auth file for the same logical account, the dashboard should associate ownership with that newest auth file rather than leaving ownership stuck to stale auth metadata

If the management API supports deleting or superseding stale auth files safely, that can be implemented. If it does not, the minimum acceptable behavior is:

- ownership and visible listing should resolve to the newest auth file
- stale duplicates should not remain the active credential for that logical account in dashboard behavior

## UI Behavior

### Providers preview card and account list

- Claim must only render when `canClaim` is true and the action is actually wired.
- A visible Claim button must always have a real action behind it.
- The UI should not render dead or placeholder claim controls.

### Success feedback

After add/connect/import, feedback should distinguish:

- added/connected/imported and claimed successfully
- added/connected/imported and merged into existing account using the new auth
- added/connected/imported but ownership could not be assigned automatically because the result was ambiguous
- added/connected/imported but the account is owned by another user

This keeps auto-claim mandatory while still explaining fallback-required situations.

## Error Handling

- A successful provider authentication event should not be reported as a total failure only because ownership resolution was ambiguous.
- Safe duplicate detection must resolve via merge, not via duplicate-conflict error.
- True ambiguity must remain non-destructive and must not guess.
- Manual Claim errors must remain explicit for admins.
- Race conditions must still be handled through transaction/unique-constraint-safe logic, but rerouted into normalized ownership outcomes instead of generic duplicate failures.

## File Boundaries

### Modify

- `dashboard/src/components/providers/oauth-preview-card.tsx`
  - pass a real claim handler and claim loading state
- `dashboard/src/components/providers/oauth-credential-list.tsx`
  - use real claim state and keep button rendering consistent with `canClaim`
- `dashboard/src/components/providers/oauth-section.tsx`
  - consume normalized claim/merge outcomes across connect flows
- `dashboard/src/app/api/providers/oauth/claim/route.ts`
  - route manual claim through the shared ownership resolver
- `dashboard/src/app/api/management/oauth-callback/route.ts`
  - replace direct ownership create/conflict logic with the shared resolver
- `dashboard/src/lib/providers/oauth-ops.ts`
  - replace direct create/conflict paths in import and add/register flows with the shared resolver
- `dashboard/src/lib/providers/oauth-auto-claim.ts`
  - narrow its responsibility to candidate discovery/classification inputs if needed, while moving final ownership decisioning into the new shared resolver

### Create

- `dashboard/src/lib/providers/oauth-ownership-resolver.ts`
  - identity matching
  - duplicate merge decisioning
  - normalized ownership result contract
  - transaction-safe create/update behavior
- focused tests for the new resolver and updated route/component behavior

## Testing Strategy

### Unit tests

Add or update tests for:

- `dashboard/src/lib/providers/__tests__/oauth-ownership-resolver.test.ts`
  - new account -> claimed
  - same `accountName` duplicate -> merged using new auth
  - fallback `provider + email` duplicate -> merged using new auth
  - multiple email matches -> ambiguous
  - owned by current user -> already owned result
  - owned by another user -> claimed-by-other-user result when applicable

### Route tests

Add or update tests for:

- `dashboard/src/app/api/providers/oauth/claim/route.test.ts`
  - admin manual claim succeeds
  - manual claim can merge a safe duplicate instead of returning duplicate conflict
  - manual claim still rejects unauthorized/non-admin users
- `dashboard/src/app/api/management/oauth-callback/route.test.ts`
  - callback flow returns merged result when duplicate auth is safely identified
  - callback flow remains ambiguous when more than one candidate is plausible
- `dashboard/src/app/api/providers/oauth/import/route.test.ts`
  - import succeeds with merged result when duplicate logical account is detected safely

### Component tests

Add or update tests for:

- `dashboard/src/components/providers/__tests__/oauth-section.test.tsx`
  - merged outcome messaging is shown correctly
- `dashboard/src/components/providers/__tests__/oauth-preview-card.test.tsx`
  - Claim button calls the real handler
- any existing connected accounts/providers list tests affected by new `canClaim` semantics

## Verification Criteria

This work is complete when all of the following are true:

1. The Claim button on `/dashboard/providers` invokes a real manual-claim flow.
2. A visible Claim button is never a no-op.
3. Add, connect, and import flows all route through one shared ownership-resolution policy.
4. Safe duplicates merge automatically instead of surfacing duplicate-conflict failures.
5. When duplicate auth is merged, the system prefers the new auth data.
6. Ambiguous cases still refuse to guess automatically.
7. Callback and no-callback OAuth flows report the same normalized ownership result structure.
8. Existing legacy unclaimed accounts can still be claimed manually by an admin.

## Risks and Trade-offs

### Risk: duplicate identity is not perfectly represented by current schema

The current schema is unique by `accountName`, while the desired behavior may also need `provider + email` fallback matching.

Mitigation:

- keep fallback matching conservative
- only use `provider + email` when it resolves to exactly one candidate
- keep ambiguous fallback matches manual

### Risk: management API may not expose first-class stale-auth replacement

The dashboard may be able to update ownership metadata more easily than it can delete or supersede old auth files.

Mitigation:

- require dashboard-visible behavior to prefer the newest auth file
- treat physical cleanup of stale auth files as an implementation detail or follow-up if needed

### Risk: race conditions during concurrent claim/import/connect flows

Concurrent writes may still collide.

Mitigation:

- use transaction-safe ownership updates
- normalize `P2002`-style conflicts into deterministic final outcomes
- verify final state after collisions instead of surfacing generic duplicate errors
