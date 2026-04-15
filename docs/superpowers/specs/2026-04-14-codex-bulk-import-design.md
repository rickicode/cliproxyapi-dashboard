# Codex Bulk Import Design

## Goal

Add bulk import for Codex OAuth credentials from a JSON array so users can onboard many accounts at once without manual one-by-one imports.

## Input Format

The dashboard accepts a JSON array. Each item represents one Codex credential payload and must include:

- `email`: user-facing identifier for the account
- OAuth credential fields such as `access_token`, `refresh_token`, `id_token`, and any other fields required by CLIProxyAPI

Example:

```json
[
  {
    "email": "user1@example.com",
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "..."
  }
]
```

## Behavior

- Bulk import is only available for the `codex` OAuth provider.
- The UI accepts either a single credential object (existing behavior) or a bulk array for Codex.
- For bulk entries, the dashboard generates an internal auth-file name from the email using the pattern `codex_[email].json`.
- The generated file name is sanitized for file-safety, while the original email remains the user-facing identifier in results.
- The backend uploads each generated credential file to the management `/auth-files` endpoint using the existing import flow.
- The backend returns per-entry results with success or failure details instead of failing the whole batch on first error.

## Architecture

- Extend validation schema and API route parsing for a bulk Codex payload.
- Reuse the existing single-account import function for each entry so ownership creation, polling, cache invalidation, and conflict behavior stay consistent.
- Add a small bulk import helper in the provider layer to orchestrate iteration and result collection.
- Update the provider import modal to detect Codex bulk arrays, submit them, and render a per-email summary.

## Error Handling

- Reject array payloads for non-Codex providers.
- Reject bulk items missing `email` or with invalid object structure.
- If one account fails, continue importing the rest and report partial success.
- Keep duplicate/conflict behavior visible per item.

## Testing

- Unit tests for bulk payload validation and file-name generation.
- API route tests covering:
  - bulk Codex success
  - non-Codex array rejection
  - per-item mixed success/failure response
- UI tests for bulk JSON validation logic where practical.
