# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-08 | **Commit:** 78fdf41 | **Branch:** main

## OVERVIEW

Self-hosted AI proxy management dashboard. Next.js 16 + React 19 + TypeScript strict + Tailwind v4 + Prisma 7 + PostgreSQL. Controls CLIProxyAPI service via Docker socket.

## STRUCTURE

```
cliproxyapi_dashboard/
├── dashboard/          # Main Next.js application (work here)
├── infrastructure/     # Docker Compose, Caddy, systemd configs
├── plugin/             # OpenCode sync plugin (separate npm package)
├── scripts/            # Host-level backup/restore scripts
└── install.sh          # Production deployment script
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add API endpoint | `dashboard/src/app/api/` | Use `route.ts` pattern |
| Add UI page | `dashboard/src/app/dashboard/` | Server Component default |
| Core business logic | `dashboard/src/lib/` | Auth, providers, config-sync |
| Database changes | `dashboard/prisma/schema.prisma` | Run migrate + generate |
| Docker/deployment | `infrastructure/` | Compose + Caddy configs |
| Environment vars | `infrastructure/.env` | Never commit |

## CONVENTIONS

### TypeScript (Strict)
- **NEVER** `any` → use `unknown` + type guards
- Const types: `const X = {...} as const; type X = typeof X[keyof typeof X]`
- Import types explicitly: `import type { User } from "@/lib/types"`

### React 19
- Named imports only: `import { useState } from "react"`
- **NO** `useMemo`/`useCallback` → React Compiler handles it
- **NO** `forwardRef` → ref is a regular prop
- Server Components default, `"use client"` only when needed

### Tailwind v4
- **NEVER** `var()` in className
- **NEVER** hex colors in className
- `cn()` only for conditional classes

### API Routes
- Always try-catch with structured JSON: `{ error: "message" }`
- Auth: `verifySession()` for users, `validateSyncTokenFromHeader()` for CLI
- CSRF: `validateOrigin()` for state-changing requests
- Admin: check `user.isAdmin` for privileged operations

## ANTI-PATTERNS (FORBIDDEN)

| Pattern | Why | Alternative |
|---------|-----|-------------|
| `any` type | Breaks type safety | `unknown` + type guard |
| `@ts-ignore` / `as any` | Masks real issues | Fix the type |
| Manual memoization | React 19 handles it | Remove `useMemo`/`useCallback` |
| Edit `generated/prisma/*` | Gets overwritten | Modify `schema.prisma` |
| Commit `.env` or secrets | Security risk | Use `infrastructure/.env` |
| `position: absolute` for dropdowns | Z-index issues | Use `position: fixed` |

## COMMANDS

```bash
cd dashboard                    # Always work from here
npm run dev                     # Dev server :3000
npm run build                   # Production build
npm run lint                    # ESLint (flat config)
npx prisma migrate dev --name X # DB migration
npx prisma generate             # Regenerate client
./dev-local.sh                  # Local Docker dev environment
./dev-local.sh --reset          # Reset dev database
```

## ARCHITECTURE NOTES

### Dual-Write Pattern
Provider keys stored in BOTH:
1. PostgreSQL (ownership tracking via Prisma)
2. CLIProxyAPI config.yaml (via Management API)

`lib/providers/dual-write.ts` uses AsyncMutex to prevent race conditions.

### Config Sync Flow
```
User Preferences → lib/config-sync/generate-bundle.ts → JSON bundle
                   ↓
CLI Plugin fetches via /api/config-sync/bundle (Bearer token auth)
```

### Three Auth Layers
1. **Session (JWT)**: Dashboard users via cookie
2. **Sync Token**: CLI plugins via Bearer header
3. **Admin**: `isAdmin` flag for privileged operations

## COMPLEXITY HOTSPOTS

| File | Lines | Risk |
|------|-------|------|
| `components/oh-my-opencode-config-generator.tsx` | 1344 | God component, complex state |
| `app/dashboard/providers/page.tsx` | 1305 | Multi-provider UI logic |
| `lib/providers/dual-write.ts` | 778 | Critical sync logic with mutex |
| `lib/config-sync/generate-bundle.ts` | 400 | Orchestrates all config data |

## TESTING

**Current State**: No automated tests. Manual verification only.

## CHILD AGENTS.md

- `dashboard/AGENTS.md` - Next.js app specifics
- `dashboard/src/lib/AGENTS.md` - Core library modules
- `dashboard/src/app/api/AGENTS.md` - API endpoint patterns
