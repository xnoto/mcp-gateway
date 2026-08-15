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
