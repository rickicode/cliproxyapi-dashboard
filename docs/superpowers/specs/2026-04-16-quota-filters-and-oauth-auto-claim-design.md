# Quota Filters/Pagination and OAuth Auto-Claim Reliability Design

## Summary

This design combines two related but operationally independent improvements:

1. Add quota-page list controls on `/dashboard/quota`:
   - search by account email
   - filter by provider
   - filter by status
   - pagination for the account list
2. Strengthen and clarify OAuth auto-claim behavior on `/dashboard/providers` for newly created OAuth accounts, without expanding into general claim-management UI.

The implementation intentionally keeps quota filtering/pagination client-side and URL-backed, while treating OAuth auto-claim as a reliability and result-reporting improvement for the existing connect/import lifecycle.

## Goals

### Quota page
- Make the account list easier to use when many accounts exist.
- Allow users to narrow accounts by email, provider, and status.
- Prevent long unpaginated account lists on `/dashboard/quota`.
- Preserve current quota summary/chart behavior as much as possible.
- Keep filter state bookmarkable and shareable via the URL.

### Providers auto-claim
- Improve the existing automatic ownership claim flow when a user creates a new OAuth connection.
- Keep callback-provider and no-callback-provider flows behaviorally consistent.
- Make auto-claim outcomes explicit to the user.
- Avoid expanding scope into bulk claim, connected-account ownership management, or retroactive claiming of old unowned accounts.

## Non-Goals

### Quota page
- No server-side search/filter API changes for quota detail data in this work.
- No server-side pagination for quota detail data in this work.
- No changes to quota summary aggregation route contract.
- No new quota analytics dimensions beyond email search, provider filter, and status filter.

### Providers auto-claim
- No bulk claim feature for existing unowned accounts.
- No new claim-management UI on `/dashboard/connected-accounts`.
- No manual claim workflow redesign.
- No attempt to auto-claim historical unowned auth files outside the active new-connection flow.

## Current State

### Quota page
- `/dashboard/quota` is powered by `dashboard/src/app/dashboard/quota/page.tsx`.
- It fetches summary and detail datasets through `useQuotaSummaryData()` and `useQuotaDetailData()`.
- It already supports a provider filter button group stored in local React state.
- It passes a filtered account list to `dashboard/src/components/quota/quota-details.tsx`.
- It does not currently support search, status filtering, pagination, or URL-backed query state.

### Providers auto-claim
- `/dashboard/providers` is powered by `dashboard/src/app/dashboard/providers/page.tsx` and related provider components.
- New OAuth connections are orchestrated primarily in `dashboard/src/components/providers/oauth-section.tsx`.
- Existing auto-claim logic already lives in `dashboard/src/app/api/management/oauth-callback/route.ts`.
- The current system already tries to auto-claim new accounts, but the logic and result reporting are not sufficiently unified or explicit across callback and no-callback flows.

## Design Overview

## Part A: Quota page search, filter, and pagination

### Approach

Use client-side search/filter/pagination with URL-backed query state.

The detail dataset returned by the existing quota API is already rich enough to support this. Keeping the logic client-side avoids API contract changes, reduces backend risk, and aligns with the current scale of the page.

### Query state

The quota page will support these URL parameters:

- `q` — free-text email search
- `provider` — selected provider filter
- `status` — selected status filter
- `page` — active account-list page

Example:

`/dashboard/quota?q=gmail&provider=claude&status=active&page=2`

### Query-state rules

- Unknown `provider` values fall back to `all`.
- Unknown `status` values fall back to `all`.
- Missing, invalid, or negative `page` values fall back to `1`.
- Changing `q`, `provider`, or `status` resets `page` to `1`.
- Refreshing the page preserves the current view because the state lives in the URL.

### Filter dimensions

The quota page will support:

- search by account email
- provider filter
- status filter

Provider filtering should preserve the existing quota-page provider focus and visual style. Status filtering should use status values already derivable from the existing quota detail model instead of inventing a new backend status system.

### Filtering pipeline

The page will process the detail dataset in this order:

1. start from the full detail dataset already fetched from the hook
2. apply provider filter
3. apply status filter
4. apply case-insensitive email search
5. compute total filtered result count
6. slice only the final filtered list for pagination

### Pagination behavior

- Pagination applies only to the account list.
- Summary cards and charts are computed from the filtered dataset before pagination.
- Pagination is performed on the flat filtered account collection before `QuotaDetails` groups the current page’s accounts for display.
- This means grouping behavior only applies to the visible page subset.

This is intentionally simpler and more predictable than paginating grouped sections.

### Empty-state behavior

The page should distinguish:

- **No data**: there are no quota accounts available at all.
- **No results**: quota data exists, but the active search/filter combination matches nothing.

These must have different user-facing messages.

### File boundaries

#### Modify
- `dashboard/src/app/dashboard/quota/page.tsx`
  - own parsed query state
  - filter and paginate accounts
  - keep summary/chart derived from filtered, pre-pagination data
- `dashboard/src/components/quota/quota-details.tsx`
  - accept the already paginated subset and render it
  - support clearer empty-state variants if needed

#### Create
- `dashboard/src/components/quota/quota-toolbar.tsx`
  - search input
  - provider filter control
  - status filter control
  - optional result count / clear filters action
- `dashboard/src/lib/quota/query-state.ts`
  - parse quota URL query
  - normalize invalid params
  - build query strings for router updates

### Reused existing patterns

- URL query-state pattern from connected accounts (`connected-accounts-page.tsx`, `connected-accounts-toolbar.tsx`)
- quota-provider visual filtering style from the current quota page

## Part B: OAuth auto-claim reliability for newly created accounts

### Approach

Keep the existing “auto-claim on new OAuth creation” scope, but extract/standardize claim detection and claim-result classification so the frontend gets a consistent result regardless of provider flow shape.

This is a reliability/clarity improvement, not a feature expansion into ownership management.

### Core behavior

When a new OAuth connection flow completes:

1. the auth flow succeeds or partially succeeds at the provider/management layer
2. the system tries to identify the newly created auth file for the current user session
3. the system returns a structured auto-claim result
4. the frontend shows a clearer outcome message

### Supported result states

The auto-claim path should classify outcomes into explicit states:

- `claimed`
- `already_claimed`
- `no_match`
- `ambiguous`
- `error`

These states should be used consistently by both callback and no-callback provider flows.

### Behavioral rules

- A successful OAuth connect must not be treated as a full failure only because auto-claim could not uniquely determine ownership.
- If connection succeeds but auto-claim does not, the user should be told that connection succeeded and ownership could not be assigned automatically.
- If an account is already claimed, the user should get a specific message rather than a vague failure.
- If multiple candidates exist, the system should refuse to auto-claim rather than guessing.

### File boundaries

#### Modify
- `dashboard/src/components/providers/oauth-section.tsx`
  - consume structured auto-claim outcomes
  - present clearer post-connect feedback
- `dashboard/src/app/api/management/oauth-callback/route.ts`
  - delegate matching/classification logic into a shared helper
  - return or expose a normalized result shape

#### Create
- `dashboard/src/lib/providers/oauth-auto-claim.ts`
  - encapsulate candidate matching for newly created auth files
  - classify outcomes into `claimed`, `already_claimed`, `no_match`, `ambiguous`, `error`
  - avoid duplicating heuristics across callback/no-callback paths

### Scope guard

This design does **not** add:

- claim actions to connected accounts
- bulk claim APIs
- retroactive reconciliation UI for already unowned accounts

## UX Details

### Quota page UX

Toolbar on `/dashboard/quota` should include:

- search input for email
- provider filter
- status filter
- visible count of matching accounts (optional but recommended)

Behavior:

- filter/search changes update the URL without full page reload
- filter/search changes reset pagination to page 1
- pagination changes update only the list view state
- provider/status/search affect both the list and the summary/chart aggregates
- page affects only the visible account list

### Providers UX

After connect/import on `/dashboard/providers`, the user should receive outcome messaging such as:

- connected and claimed successfully
- connected, but ownership could not be determined automatically
- connected, but the account was already claimed

The exact wording can be localized later, but the important design point is that outcome classes are explicit and user-comprehensible.

## Error Handling

### Quota page
- No new backend failure mode is introduced.
- Invalid URL params are normalized rather than producing an error.
- Existing loading and data-fetch failure behavior remains the same.

### Providers auto-claim
- Connect success and claim success are separate concerns.
- Claim ambiguity or no-match should not invalidate an otherwise successful OAuth connection.
- Internal claim-helper errors should surface as explicit claim result status, not as silent generic failures.

## Testing Strategy

## Quota page

### Update/add tests around:
- `dashboard/src/app/dashboard/quota/page.test.tsx`
- `dashboard/src/components/quota/__tests__/quota-details.test.tsx`
- any new query-state helper test file

### Minimum coverage
- email search filters correctly
- provider filter works correctly
- status filter works correctly
- combined search + provider + status filtering works correctly
- changing filters resets page to 1
- pagination slices only the account list
- summary/chart continue to derive from filtered pre-pagination data
- invalid URL params normalize safely
- “no data” vs “no results” states are distinct

## Providers auto-claim

### Update/add tests around:
- `dashboard/src/app/api/management/oauth-callback/route.ts`
- new tests for `dashboard/src/lib/providers/oauth-auto-claim.ts`
- frontend provider flow tests if needed for result presentation

### Minimum coverage
- unique candidate -> `claimed`
- no candidate -> `no_match`
- multiple candidates -> `ambiguous`
- existing owner -> `already_claimed`
- OAuth connection success remains success when auto-claim cannot complete uniquely
- callback and no-callback paths expose a consistent result shape to the frontend

## Verification Criteria

This work is complete when all of the following are true:

1. `/dashboard/quota` supports email search, provider filter, status filter, and pagination for the account list.
2. Quota query state is URL-backed and normalized safely.
3. Quota summary cards and charts remain based on the active filtered set, not the current page only.
4. Quota empty states clearly distinguish “no data” from “no matching results”.
5. Newly created OAuth accounts continue to use auto-claim.
6. Auto-claim result handling is consistent across callback and no-callback flows.
7. Auto-claim outcomes are explicit enough that the providers UI can explain what happened.
8. Failure to auto-claim does not incorrectly report the whole OAuth connection as failed when the connection itself succeeded.

## Risks and Trade-offs

### Accepted trade-off: client-side quota pagination
This design intentionally keeps quota list pagination client-side. That is simpler and lower-risk now, but it means the page still fetches the whole detail dataset before filtering.

### Accepted trade-off: limited auto-claim scope
This design intentionally improves only the “new connection” auto-claim path. It does not solve claim management for old unowned accounts.

### Mitigation
If quota scale later outgrows client-side handling, the query-state UI can be retained while moving filtering/pagination server-side in a follow-up change.
