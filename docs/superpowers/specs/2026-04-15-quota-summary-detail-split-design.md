# Quota Summary/Detail Split Design

## Goal

Make `/dashboard/quota` feel fast on first open by returning a lightweight quota summary first, while loading the full per-account detail payload separately afterward.

## Problem

- The current quota page still depends on a full `/api/quota` aggregation before the main content becomes useful.
- With hundreds of Codex accounts, the cold path is dominated by provider quota fan-out, especially Codex.
- Frontend dedupe and backend single-flight already removed duplicate cold fetches, but they do not reduce the cost of producing the full payload.

## Behavior

- The quota API supports two explicit views:
  - `/api/quota?view=summary`
  - `/api/quota?view=detail`
- `summary` returns only the data required to render the top quota page content quickly:
  - counts used by the top stat cards
  - provider-level summaries used by the chart
  - model-first warning summary used by the warning banner
  - generated timestamp / metadata needed for refresh state
- `detail` returns the existing full `accounts` payload for `QuotaDetails`.
- The quota page loads `summary` first and renders the top section as soon as it is available.
- The details section loads separately and can show its own loading state without blocking the summary section.
- Header notifications should use `summary`, not `detail`, so the shared dashboard shell does not force a full detail aggregation.

## Architecture

- Keep one route file: `dashboard/src/app/api/quota/route.ts`.
- Add a small query-param dispatch layer in the route so `view=summary` and `view=detail` share the same auth, cache, and single-flight pattern, but maintain separate cache keys.
- Split backend response building into two bounded paths:
  - `buildQuotaDetailResponse()` produces the current full `accounts` payload.
  - `buildQuotaSummaryResponse()` produces only provider-level aggregates and top-level counters.
- Derive summary data on the server from the same provider/account traversal logic rather than returning `accounts` and recomputing summary on the client.
- Add dedicated hooks:
  - `useQuotaSummaryData()`
  - `useQuotaDetailData()`
- Keep shared SWR semantics (dedupe, optional refresh interval, bust refresh) but use separate SWR keys for summary and detail.
- Update `dashboard/src/app/dashboard/quota/page.tsx` so:
  - top cards, warning banner, and chart depend on summary data
  - `QuotaDetails` depends on detail data
  - the refresh button refreshes both views

## Data Shape

The summary response should be intentionally small and stable. It should include:

- `providers`: provider-level summary entries already ready for chart/stat rendering, including:
  - `monitorMode`
  - `totalAccounts`
  - `activeAccounts`
  - `healthyAccounts`
  - `errorAccounts`
  - `windowCapacities` for window-based providers
  - optional `modelFirstSummary` for model-first providers
  - `lowCapacity`
- `totals`: top-level counts such as active accounts, provider count, low-capacity count, and any model-first summary counters needed for the current top cards
- `warnings`: model-first warning entries needed for the warning banner
- `generatedAt`

The detail response should preserve the current `QuotaResponse` shape with `accounts` so `QuotaDetails` and the existing per-account UI can continue to work with minimal churn.

## Error Handling

- If `summary` fails, the page should preserve the current top-level loading/error experience.
- If `detail` fails after `summary` succeeds, the page should still show the summary section and a local details error/loading fallback.
- Cache and single-flight must be isolated by view so a slow `detail` request does not block a fast `summary` response.
- `bust` refresh should work independently per view.
- Refreshing both views from the page should tolerate partial failure; one failed refresh must not abort the other.

## Testing

- API route tests covering:
  - `view=summary` returns the lightweight shape and does not expose full `accounts`
  - `view=detail` preserves the current full payload shape
  - cache/single-flight separation by view
- Hook tests covering separate SWR keys and bust refresh behavior for summary and detail hooks.
- Quota page tests where practical to confirm summary UI can render before detail completes.

## Scope Boundaries

- Do not add background schedulers or precomputation in this step.
- Do not redesign the quota UI itself.
- Do not change provider-specific quota fetching semantics in this step.
- Do not remove the existing Codex slow/error logging or aggregate timing logs.

## Success Criteria

- Opening `/dashboard/quota` shows the top summary content without waiting for the full account detail payload.
- Shared dashboard consumers stop triggering full detail aggregation unless they truly need per-account data.
- The detail table can remain slower for large Codex fleets without making the whole page feel blocked.
