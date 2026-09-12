.PHONY: check test restart test-restart test-backoff

check:
	pre-commit run --all-files

test: check test-restart test-backoff

test-restart:
	node --test tests/restart.test.mjs

test-backoff:
	node --test tests/backoff.test.mjs

restart:
	@platform=$$(uname -s); \
	case "$$platform" in \
	  Darwin) launchctl kickstart -k "gui/$$(id -u)/com.xnoto.mcp-gateway" ;; \
	  Linux) systemctl --user restart mcp-gateway.service ;; \
	  *) printf '%s\n' "unsupported platform: $$platform" >&2; exit 1 ;; \
	esac
