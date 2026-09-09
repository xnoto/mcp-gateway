# AGENTS.md

## Ownership

This repository is the canonical source for `~/.config/mcp-gateway`. The xnoto
`dotfiles` repository installs it through `.chezmoiexternal.toml.tmpl` as a
`git-repo` external on macOS and Linux.

Keep platform service definitions and secret rendering in `dotfiles`:

- `Library/LaunchAgents/com.xnoto.mcp-gateway.plist.tmpl` for macOS
- `dot_config/systemd/user/mcp-gateway.service` for Linux
- `private_dot_shellenv.tmpl` and encrypted secret sources

## Layout and permissions

- `servers.json` defines the supervised MCP servers and localhost ports.
- `supervisor.mjs`, `healthcheck.mjs`, and `probe.mjs` implement supervision
  and MCP protocol checks.
- `run`, `healthcheck`, `bin/argocd`, `bin/github`, `bin/grafana`, and
  `bin/parallel-search` must remain executable.
- The shell wrappers are POSIX `sh` and must remain portable across macOS and
  Linux.

## Adding a server

Assign each server a unique localhost port from the 8765-8799 block registered
in `servers.json`. Keep environment pairs on adjacent ports
(`aws-staging`/`aws-prod` 8765/8766, `argocd-staging-eks`/`argocd-prod-eks`
8774/8775) and otherwise take the lowest free port. The supervisor refuses
duplicate ports at startup; clients also pin ports, so never renumber an
existing server.

1. Add the entry to `servers.json` with a stable name; clients reference the
   key and its `<name>_*` tool namespaces. Prefer a direct `command`; use a
   `/bin/sh -c` wrapper only when the child needs environment expansion such
   as `$HOME` (see `codebase-memory`).
2. Extend `warm` for new downstream packages: `command: "uvx"` entries are
   discovered automatically, while `bin/` wrappers and `npx` commands hidden
   behind a shell need explicit lines (see `grafana` and `codebase-memory`).
3. Run `make check` and `node supervisor.mjs --check`.
4. Point client configuration (for example `opencode-config`) at
   `http://127.0.0.1:<port>/mcp` with the exact server key.

The supervisor reads `servers.json` once at startup and never reloads it. Sync
the installed `~/.config/mcp-gateway` checkout first and only then run
`make restart`; restarting before the sync leaves the previous manifest
running. Verify with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and
`"$HOME/.config/mcp-gateway/healthcheck"`.

## Validation

Run `make` or `make check` before considering a change complete. These commands
run repository hygiene checks, secret detection, ShellCheck, JSON validation,
and `node --check` for the JavaScript modules.

Refresh hooks with `pre-commit autoupdate --freeze`; this repository keeps hook
revisions as immutable commit SHAs. Keep the adjacent release comments and the
`pragma: allowlist secret` markers on those public SHAs so an all-files secret
scan does not mistake dependency pins for credentials.

Runtime health checks require the installed checkout, credentials, packages,
VPN access, and platform service, so do not start or restart services without
explicit confirmation.

## Boundaries

Do not edit the rendered `~/.config/mcp-gateway` checkout when the intended
change belongs upstream. Do not commit, push, apply dotfiles, install packages,
or restart services unless explicitly requested.
