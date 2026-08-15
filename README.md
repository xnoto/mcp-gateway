# MCP gateway

This repository is the canonical source for `~/.config/mcp-gateway`. Chezmoi
clones it as a `git-repo` external configured by the xnoto `dotfiles` repo.

It runs local stdio MCP servers once and exposes each server over
Streamable HTTP for OpenCode, Claude Code, and Codex. A small Node supervisor
runs one `mcp-proxy` process per server so a failed credential, VPN, or Podman
dependency cannot prevent unrelated MCP servers from starting.

Each proxy listens only on a dedicated localhost port recorded in
`servers.json`, with its MCP endpoint at `http://127.0.0.1:<port>/mcp`. The
supervisor probes `tools/list` and restarts only the failed proxy after repeated
protocol failures.

## Dependencies

On macOS, the managed Brewfile provides `node`, `uv`, `podman`, and `tmux`.

On Fedora Linux, install `nodejs`, `uv`, `podman`, and `tmux` with the system
package manager. The gateway uses `npx` and `uvx` to run pinned MCP packages.

## Services

Platform integration remains owned by the `dotfiles` repo:

- macOS: `~/Library/LaunchAgents/com.xnoto.mcp-gateway.plist`
- Linux: `~/.config/systemd/user/mcp-gateway.service`
- credentials: the private `~/.shellenv` rendered from encrypted dotfiles

After applying the dotfiles, load the service for the current platform.

### macOS

```sh
launchctl bootout "gui/$(id -u)/com.xnoto.mcp-gateway" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.xnoto.mcp-gateway.plist"
```

To restart the service without re-bootstrapping:

```sh
launchctl kickstart -k "gui/$(id -u)/com.xnoto.mcp-gateway"
```

### Fedora Linux

```sh
systemctl --user daemon-reload
systemctl --user enable mcp-gateway.service
systemctl --user restart mcp-gateway.service
```

## Migrating an existing installation

Before the first apply that enables the external repository, stop the platform
service and move the existing non-Git `~/.config/mcp-gateway` directory aside.
Chezmoi clones a missing external directory but attempts to pull an existing
one, which requires that directory to already be a Git checkout.

After applying the updated dotfiles, restart the service and verify the gateway
before removing the backup.

## Development

Run the static checks from this checkout:

```sh
make check
```

The `run` and `healthcheck` wrappers intentionally resolve the installed files
under `~/.config/mcp-gateway`; use the static checks when working only in this
source checkout.

## Verification

```sh
"$HOME/.config/mcp-gateway/healthcheck"
```

The GitHub, Grafana, Argo CD, and Parallel Search launchers source the private
`~/.shellenv` file and export only the credential required by that MCP server.
Parallel Search uses a pinned `mcp-remote` bridge to convert its hosted
Streamable HTTP endpoint to stdio before the supervisor publishes it on the
standard loopback endpoint.

Context-mode remains a client-local MCP because it owns per-session capture
and compaction behavior; it is not routed through this shared gateway.

The endpoints are unauthenticated and intentionally bound to loopback. Do not
forward or expose these ports to other hosts.

On macOS, initialize and start the Podman machine before using the
`terraform-docs` endpoint.
