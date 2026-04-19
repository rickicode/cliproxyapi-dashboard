# Install.sh Docker-Managed Cloudflare Tunnel Design

## Summary

Refine the runtime-bundle installer design so Cloudflare Tunnel no longer uses a host-level `cloudflared` package and system service. Instead, Cloudflare mode will run `cloudflared` as a Docker Compose service inside the same production stack, using token-only remote-managed tunnels, exposing both dashboard and API through Cloudflare while still keeping host ports `8318` and `8317` available.

The installer UX also shifts toward a direct installer entrypoint, with docs allowed to present the primary path as:

```bash
curl -fsSL <installer-url> | sudo bash
```

while the installer itself still fetches the runtime bundle into `/opt/cliproxyapi` and launches a single Compose-managed stack.

## Goals

- Make Cloudflare Tunnel deployment OS-agnostic by requiring only Docker + Compose, not apt/brew/winget/systemd-specific host logic.
- Keep the runtime model centered on a single production `docker-compose.yml`.
- Run Cloudflare Tunnel in Docker Compose using token-only remote-managed mode.
- Expose both dashboard and API through the tunnel in Cloudflare mode.
- Keep host ports `8318` and `8317` open in Cloudflare mode for local/IP-based fallback and debugging.
- Preserve the existing domain mode with bundled Caddy.
- Preserve the existing local-IP mode without Caddy or Cloudflare Tunnel.
- Keep installer behavior aligned with the runtime-bundle contract rooted at `/opt/cliproxyapi`.

## Non-Goals

- Do not add automatic Cloudflare hostname creation or Cloudflare API management.
- Do not introduce config-file-managed Cloudflare tunnels in this iteration.
- Do not remove domain mode or replace bundled Caddy in domain mode.
- Do not make Cloudflare mode “tunnel only” by closing host ports `8317` and `8318`.
- Do not redesign backup helpers, webhook legacy artifacts, or dashboard update flows as part of this design change.
- Do not require non-Docker host service management for any production runtime mode.

## Prior Approved Context This Design Refines

The approved runtime-bundle direction already established:

- production runtime lives under `/opt/cliproxyapi`
- installer fetches runtime artifacts instead of requiring a persistent git checkout
- access modes are `domain`, `cloudflare`, and `local`
- domain mode uses integrated/bundled Caddy
- Cloudflare mode previously used a host-installed `cloudflared` service
- local mode exposes direct host access without domain requirements

This design only changes the Cloudflare mode runtime contract from host-managed `cloudflared` to Compose-managed `cloudflared`.

## Current State

### Installer uses host-level `cloudflared`

`install.sh` currently:

- prompts for `ACCESS_MODE=cloudflare`
- prompts for `CLOUDFLARE_TUNNEL_TOKEN`
- installs `cloudflared` from the Cloudflare apt repository on Debian/Ubuntu
- runs `cloudflared service install <token>`
- enables/restarts `cloudflared.service` with `systemctl`
- verifies `cloudflared.service` is active

This creates an OS-specific split:

- app stack lifecycle is Docker Compose
- tunnel lifecycle is host package manager + system service

### Compose does not currently own Cloudflare Tunnel

`docker-compose.yml` currently owns:

- `postgres`
- `cliproxyapi`
- `docker-proxy`
- `perplexity-sidecar` (profile)
- `dashboard`
- `caddy` (profile)

There is no `cloudflared` service yet.

### Current Cloudflare mode behavior

Cloudflare mode currently assumes:

- `caddy` disabled
- `dashboard` bound to `0.0.0.0:8318`
- `cliproxyapi` bound to `0.0.0.0:8317`
- host-level `cloudflared` proxies Cloudflare traffic to those host ports

## Chosen Direction

Adopt a **Compose-native Cloudflare Tunnel service**.

Cloudflare mode will:

- run `cloudflared` as a Compose service in the production stack
- use **token-only remote-managed** mode
- tunnel both:
  - dashboard → `http://dashboard:8318`
  - API → `http://cliproxyapi:8317`
- keep host ports `8318` and `8317` exposed
- avoid all host-level Cloudflare package/service installation logic

This keeps the system aligned with the user’s explicit goal: “pakai docker saja semuanya dengan satu compose”.

## Rejected Alternatives

### 1. Keep host-level `cloudflared`

Rejected because it reintroduces OS-specific installation and service-management paths. It directly conflicts with the goal of using Docker consistently across platforms.

### 2. Compose-managed `cloudflared`, but close host ports in Cloudflare mode

Rejected for this iteration because the user explicitly chose to keep host ports available. Removing `8317/8318` would reduce fallback/debug access and change operator expectations significantly.

### 3. Support both host-level and Compose-managed Cloudflare paths

Rejected because it increases complexity, docs drift, and support burden. A single Cloudflare runtime path is clearer and less bug-prone.

### 4. Config-file-managed Cloudflare tunnel container

Rejected because the user selected token-only remote-managed mode. Adding local tunnel config generation now would widen scope unnecessarily.

## Architecture

### 1. Production stack remains one Compose file with three access-mode shapes

Runtime continues to center on `/opt/cliproxyapi/docker-compose.yml`, but the mode contract becomes:

- `domain`
  - `COMPOSE_PROFILES=caddy`
  - `caddy` enabled
  - `cloudflared` disabled
- `cloudflare`
  - `COMPOSE_PROFILES=cloudflare`
  - `cloudflared` enabled
  - `caddy` disabled
- `local`
  - no Cloudflare or Caddy profile
  - both `caddy` and `cloudflared` disabled

All modes still run from the runtime bundle rooted at `/opt/cliproxyapi`.

### 2. Cloudflare Tunnel becomes a Compose service

Add a new `cloudflared` service to `docker-compose.yml`.

Service requirements:

- use the official `cloudflared` container image
- be activated only by the `cloudflare` Compose profile
- receive `CLOUDFLARE_TUNNEL_TOKEN` from `.env`
- join the Compose network that can reach `dashboard` and `cliproxyapi`
- not publish its own host ports
- proxy requests to internal Docker service names:
  - `dashboard:8318`
  - `cliproxyapi:8317`

Because the user chose token-only remote-managed mode, the design should avoid a large generated tunnel YAML unless the chosen container invocation absolutely requires a minimal wrapper/config artifact.

### 3. Host ports remain open in Cloudflare mode

Cloudflare mode will continue binding:

- `dashboard` on `0.0.0.0:8318`
- `cliproxyapi` on `0.0.0.0:8317`

This preserves:

- local network access
- debugging convenience
- fallback access even if tunnel configuration is incomplete

Docs must explicitly state that Cloudflare mode is not a closed-host-port mode.

### 4. Installer becomes Docker-only for tunnel management

`install.sh` will stop doing all host-level `cloudflared` work:

- no apt repo bootstrap for Cloudflare packages
- no `apt-get install cloudflared`
- no `cloudflared service install`
- no `systemctl enable/restart/is-active cloudflared.service`

Instead, installer responsibilities in Cloudflare mode are:

- prompt for `CLOUDFLARE_TUNNEL_TOKEN`
- write token and mode settings into `/opt/cliproxyapi/.env`
- ensure `COMPOSE_PROFILES=cloudflare`
- validate `docker compose config`
- start the same production stack with Compose
- verify the `cloudflared` container is part of the healthy/running stack

### 5. Installer entrypoint UX can be curl-first

Docs may present the main install entrypoint as:

```bash
curl -fsSL <installer-url> | sudo bash
```

This is acceptable because the installer no longer depends on a local checked-out repo to function. Its job is only to:

- bootstrap prerequisites
- fetch runtime bundle assets
- generate env/config metadata
- launch the Compose stack

The safer download-then-run variant may still appear as an alternate/manual path, but the primary docs default for this redesign is the direct curl pipe flow because the user explicitly chose it.

## File-Level Design

### `install.sh`

Modify to:

- remove host-level tunnel installation helpers such as:
  - `install_cloudflared_package()`
  - `install_cloudflared_service()`
- remove any call sites that invoke host package/service management for Cloudflare mode
- keep the `ACCESS_MODE=cloudflare` prompt path
- keep `CLOUDFLARE_TUNNEL_TOKEN` prompt and validation
- write Cloudflare token into `.env` for Compose consumption
- set `COMPOSE_PROFILES=cloudflare` in Cloudflare mode
- update validation so Cloudflare mode is verified through Compose, not host `systemctl`
- update final summary text to describe Compose-managed tunnel behavior
- reconcile `.env` reuse more strictly so access mode and profiles do not drift when an existing env file is reused

### `docker-compose.yml`

Modify to:

- add a `cloudflared` service gated by `profiles: ["cloudflare"]`
- wire it to token-based remote-managed tunnel startup
- place it on the frontend network so it can reach:
  - `dashboard:8318`
  - `cliproxyapi:8317`
- leave `dashboard` and `cliproxyapi` host port exposure intact in Cloudflare mode
- preserve `caddy` profile behavior for domain mode

The compose file becomes the only runtime owner for Cloudflare Tunnel in production.

### `README.md`

Update high-level install flow to say:

- Cloudflare Tunnel is Compose-managed
- production runtime uses one Compose stack for app services and tunnel service
- curl-first installer invocation is the primary documented path

### `docs/INSTALLATION.md`

Update to reflect:

- primary install invocation can be `curl ... | sudo bash`
- Cloudflare mode runs `cloudflared` in Docker Compose
- no host package/service install occurs for Cloudflare mode
- host ports `8317/8318` remain open in Cloudflare mode
- verification instructions use `docker compose` rather than `systemctl status cloudflared`

### `docs/CONFIGURATION.md`

Update Cloudflare sections so:

- `CLOUDFLARE_TUNNEL_TOKEN` is described as Compose runtime input
- wording about `cloudflared.service` is removed
- `COMPOSE_PROFILES=cloudflare` is documented explicitly

### `docs/SERVICE-MANAGEMENT.md`

Replace Cloudflare operational guidance based on:

- `systemctl status cloudflared`
- `systemctl restart cloudflared`

with Compose-native guidance such as:

- `docker compose ps`
- `docker compose logs cloudflared`
- `docker compose restart cloudflared`

### `docs/RUNBOOK.md`

Update production troubleshooting and runbook steps so Cloudflare mode assumes:

- `cloudflared` is a Compose service
- no host service manager is involved
- local-IP fallback remains available in Cloudflare mode

### `docs/TROUBLESHOOTING.md`

Review and update if any host-level Cloudflare Tunnel service wording remains.

## Mode Behavior Contract

### Domain mode

- Access path: domain + bundled `caddy`
- `COMPOSE_PROFILES=caddy`
- `caddy` active
- `cloudflared` inactive
- final output emphasizes domain URLs

### Cloudflare mode

- Access path: Cloudflare Tunnel + local IP fallback
- `COMPOSE_PROFILES=cloudflare`
- `cloudflared` active in Compose
- `caddy` inactive
- `CLOUDFLARE_TUNNEL_TOKEN` required
- host ports `8317/8318` remain open
- final output emphasizes:
  - local IP URLs
  - that tunnel is Compose-managed
  - that hostname management still happens in Cloudflare dashboard

### Local mode

- Access path: direct local IP only
- no profiles required
- both `caddy` and `cloudflared` inactive
- host ports `8317/8318` open

## Validation and Verification Contract

### Installer preflight

Retain current preflight rules for:

- root/admin access as required by installer path
- Docker and Compose availability
- mode-appropriate port checks
- DB mode validation

Cloudflare-specific preflight changes:

- require non-empty `CLOUDFLARE_TUNNEL_TOKEN`
- do not require host package manager installability for `cloudflared`
- do not require `systemctl`

### Runtime validation

Cloudflare mode must verify with Docker/Compose evidence, not host service evidence:

- `docker compose config` succeeds
- stack starts successfully
- `dashboard` healthy
- `cliproxyapi` healthy
- `cloudflared` container running, and use a stable healthcheck only if the official image/runtime supports one without fragile hacks

If a robust `cloudflared` healthcheck cannot be defined, validation should prefer:

- service present in stack
- container remains running without crash-loop
- logs available for operator diagnosis

### Required implementation verification

Before claiming this redesign complete, implementation must freshly verify at minimum:

1. `bash -n install.sh`
2. `docker compose -f docker-compose.yml config` with required dummy env values
3. dashboard unit test suite still passes
4. docs no longer describe Cloudflare mode as a host-installed `cloudflared.service`

## Risks and Mitigations

### Risk: Compose profile drift in reused `.env`

The installer already has a known fragility around keeping an existing `.env` while changing mode assumptions.

Mitigation:

- do not reconcile only `DB_MODE`
- explicitly reconcile or rewrite:
  - `ACCESS_MODE`
  - `COMPOSE_PROFILES`
  - bind address settings
  - any Cloudflare-specific env keys

### Risk: `cloudflared` container invocation details may be image-specific

Mitigation:

- keep token-only mode minimal
- use the official image and official documented token-oriented container/service pattern
- verify actual Compose config and startup behavior during implementation

### Risk: Docs drift between runtime model and operator expectations

Mitigation:

- update all runtime-facing docs in the same batch as installer/compose changes
- remove host-service language from main docs
- keep messaging consistent that Cloudflare mode still leaves local ports open

### Risk: Operators may assume Cloudflare hostnames are auto-created

Mitigation:

- keep explicit wording that installer does not manage Cloudflare hostnames
- final summary must remind operators to configure hostnames in the Cloudflare dashboard

## Acceptance Criteria

This design is satisfied only if all of the following are true after implementation:

1. Cloudflare mode does not install `cloudflared` on the host.
2. Cloudflare mode does not rely on `systemctl` or `cloudflared.service`.
3. `cloudflared` runs as a Compose service in the production stack.
4. Cloudflare mode uses token-only remote-managed tunnel input.
5. Cloudflare mode exposes both dashboard and API through the tunnel.
6. Host ports `8317` and `8318` remain open in Cloudflare mode.
7. Domain mode continues using bundled Caddy.
8. Local mode continues without Caddy or Cloudflare Tunnel.
9. Main docs present the curl-pipe installer path as the default documented installer invocation.
10. Verification evidence exists for `install.sh`, Compose config, and dashboard tests.

## Implementation Notes for Later Planning

- This design updates the previously approved runtime-bundle installer design; it does not replace the runtime-bundle direction itself.
- Planning should treat this as a refinement of the Cloudflare access-mode lane plus documentation/installer-entrypoint wording.
- Legacy webhook/update paths remain outside this scope unless they are touched incidentally by doc cleanup.
