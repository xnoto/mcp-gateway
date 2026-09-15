import { spawn } from "node:child_process"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, uptime } from "node:os"
import { dirname, join } from "node:path"
import { probeMcp } from "./probe.mjs"

const configPath =
  process.env.MCP_GATEWAY_CONFIG ?? join(homedir(), ".config", "mcp-gateway", "servers.json")
const statePath =
  process.env.MCP_GATEWAY_STATE ??
  join(homedir(), ".cache", "mcp-gateway", "supervisor-state.json")
const config = JSON.parse(readFileSync(configPath, "utf8"))
if (
  !config.mcpServers ||
  typeof config.mcpServers !== "object" ||
  Array.isArray(config.mcpServers) ||
  Object.keys(config.mcpServers).length === 0
) {
  throw new Error("mcpServers must be a non-empty object")
}
const servers = config.mcpServers
const minRestartDelayMs = delayFromEnv("MCP_GATEWAY_MIN_RESTART_DELAY_MS", 5_000)
const maxRestartDelayMs = delayFromEnv("MCP_GATEWAY_MAX_RESTART_DELAY_MS", 300_000)
const terminateGraceMs = delayFromEnv("MCP_GATEWAY_TERMINATE_GRACE_MS", 10_000)
const startupGraceMs = 120_000
const probeIntervalMs = 30_000
const failedProbesBeforeRestart = 3
const bootToleranceSeconds = 5
const children = new Map()
const restartTimers = new Map()
const killTimers = new Map()
const startTimes = new Map()
const probeFailures = new Map()
const consecutiveFailures = new Map()
const healthyTimers = new Map()
const probesInFlight = new Set()
let stopping = false

const allowedEnvironment = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]

function baseEnvironment() {
  return Object.fromEntries(
    allowedEnvironment
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
}

function validate() {
  const ports = new Set()
  for (const [name, server] of Object.entries(servers)) {
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
      throw new Error(`${name}: port must be an integer from 1 to 65535`)
    }
    if (ports.has(server.port)) throw new Error(`${name}: duplicate port ${server.port}`)
    if (typeof server.command !== "string" || server.command.length === 0) {
      throw new Error(`${name}: command is required`)
    }
    if (server.args !== undefined && !Array.isArray(server.args)) {
      throw new Error(`${name}: args must be an array`)
    }
    ports.add(server.port)
  }
}

function delayFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

// Every child runs in its own process group so a restart can sweep the whole
// downstream tree. A signal aimed at the proxy alone leaves the npx and
// npm exec wrappers it started running; those keep a server's singleton locks
// and block every later generation from starting.
function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    // ESRCH: the group is already gone. EPERM: it is not ours to signal.
    if (error.code === "ESRCH" || error.code === "EPERM") return false
    throw error
  }
}

function groupAlive(pid) {
  return signalGroup(pid, 0)
}

// Process group ids cannot outlive a reboot, so recorded state is only
// actionable while the boot it was written under is still the current one.
function bootSeconds() {
  return Math.round(Date.now() / 1_000 - uptime())
}

function writeState() {
  const groups = Object.fromEntries([...children].map(([name, child]) => [name, child.pid]))
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify({ boot: bootSeconds(), groups })}\n`, "utf8")
  } catch (error) {
    console.error(`[mcp-gateway] could not record supervisor state: ${error.message}`)
  }
}

function readState() {
  let raw
  try {
    raw = readFileSync(statePath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  let state
  try {
    state = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof state?.boot !== "number") return null
  // A group id from an earlier boot may have been recycled by an unrelated
  // process, so the whole file is discarded rather than acted on.
  if (Math.abs(state.boot - bootSeconds()) > bootToleranceSeconds) return null
  return state
}

// A supervisor killed outright (SIGKILL, power loss, a service manager that
// ran out of patience) leaves its children running. Clear them before
// starting replacements that would otherwise contend with them.
async function reapPreviousRun() {
  let state
  try {
    state = readState()
  } catch (error) {
    console.error(`[mcp-gateway] could not read supervisor state: ${error.message}`)
    return
  }
  if (!state) return

  let stale = Object.entries(state.groups ?? {}).filter(
    ([, pid]) => pid !== process.pid && groupAlive(pid),
  )
  if (stale.length === 0) return

  for (const [name, pid] of stale) {
    console.error(`[mcp-gateway] sweeping orphaned ${name} process group ${pid}`)
    signalGroup(pid, "SIGTERM")
  }

  const deadline = Date.now() + terminateGraceMs
  while (stale.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    stale = stale.filter(([, pid]) => groupAlive(pid))
  }

  for (const [name, pid] of stale) {
    console.error(`[mcp-gateway] orphaned ${name} process group ${pid} ignored SIGTERM; forcing`)
    signalGroup(pid, "SIGKILL")
  }
}

// Signal a running child's whole group, escalating if it does not go away.
function terminate(name) {
  const child = children.get(name)
  if (!child || killTimers.has(name)) return
  signalGroup(child.pid, "SIGTERM")
  const timer = setTimeout(() => {
    killTimers.delete(name)
    if (children.get(name) !== child) return
    console.error(`[mcp-gateway] ${name} ignored SIGTERM; forcing process group ${child.pid}`)
    signalGroup(child.pid, "SIGKILL")
  }, terminateGraceMs)
  timer.unref()
  killTimers.set(name, timer)
}

// The proxy can exit on its own while the wrappers it started stay alive, so
// an exit is swept the same way a deliberate restart is.
function sweepGroup(name, pid) {
  if (!signalGroup(pid, "SIGTERM")) return
  console.error(`[mcp-gateway] ${name} left a running process group; sweeping ${pid}`)
  const timer = setTimeout(() => signalGroup(pid, "SIGKILL"), terminateGraceMs)
  timer.unref()
}

// Consecutive quick failures back off exponentially (auth expiry and other
// persistent faults must not fork-loop); a child that survives the startup
// grace window or answers a probe resets the count.
function restartDelayMs(failures) {
  return Math.min(minRestartDelayMs * 2 ** (failures - 1), maxRestartDelayMs)
}

function scheduleRestart(name, delayMs) {
  if (stopping || restartTimers.has(name)) return
  const timer = setTimeout(() => {
    restartTimers.delete(name)
    start(name)
  }, delayMs)
  restartTimers.set(name, timer)
}

function uvCacheDir(name) {
  const dir = join(homedir(), ".cache", "mcp-gateway", "uv", name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function start(name) {
  const server = servers[name]
  const environment = {
    ...baseEnvironment(),
    ...(server.env ?? {}),
    UV_CACHE_DIR: uvCacheDir(name),
  }
  const args = [
    "--from",
    "mcp-proxy==0.12.0",
    "--with",
    "mcp==1.27.1",
    "mcp-proxy",
    "--host",
    "127.0.0.1",
    "--port",
    String(server.port),
    "--pass-environment",
    "--",
    server.command,
    ...(server.args ?? []),
  ]

  console.log(`[mcp-gateway] starting ${name} on 127.0.0.1:${server.port}`)
  const child = spawn("uvx", args, {
    env: environment,
    stdio: "inherit",
    detached: true,
  })
  children.set(name, child)
  startTimes.set(name, Date.now())
  probeFailures.set(name, 0)
  writeState()
  const healthyTimer = setTimeout(() => {
    healthyTimers.delete(name)
    consecutiveFailures.set(name, 0)
  }, startupGraceMs)
  healthyTimer.unref()
  healthyTimers.set(name, healthyTimer)

  child.on("error", (error) => {
    console.error(`[mcp-gateway] ${name} failed to start: ${error.message}`)
  })

  child.on("exit", (code, signal) => {
    children.delete(name)
    startTimes.delete(name)
    probeFailures.delete(name)
    clearTimeout(healthyTimers.get(name))
    healthyTimers.delete(name)
    clearTimeout(killTimers.get(name))
    killTimers.delete(name)
    sweepGroup(name, child.pid)
    writeState()
    if (stopping) {
      if (children.size === 0) process.exit(0)
      return
    }
    const failures = (consecutiveFailures.get(name) ?? 0) + 1
    consecutiveFailures.set(name, failures)
    const delayMs = restartDelayMs(failures)
    console.error(
      `[mcp-gateway] ${name} exited (${signal ?? `code ${code}`}); restart ${failures} in ${delayMs / 1_000}s`,
    )
    scheduleRestart(name, delayMs)
  })
}

async function probe(name) {
  if (stopping || probesInFlight.has(name) || !children.has(name)) return
  const startedAt = startTimes.get(name) ?? Date.now()
  if (Date.now() - startedAt < startupGraceMs) return

  probesInFlight.add(name)
  try {
    await probeMcp(servers[name].port)
    probeFailures.set(name, 0)
    // A server answering the probe is healthy however badly it started, so a
    // recovered server is not left pinned at the maximum restart delay.
    consecutiveFailures.set(name, 0)
  } catch (error) {
    const failures = (probeFailures.get(name) ?? 0) + 1
    probeFailures.set(name, failures)
    console.error(
      `[mcp-gateway] ${name} probe failed (${failures}/${failedProbesBeforeRestart}): ${error.message}`,
    )
    if (failures >= failedProbesBeforeRestart) {
      probeFailures.set(name, 0)
      terminate(name)
    }
  } finally {
    probesInFlight.delete(name)
  }
}

function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`[mcp-gateway] received ${signal}; stopping`)
  for (const timer of restartTimers.values()) clearTimeout(timer)
  restartTimers.clear()
  for (const name of [...children.keys()]) terminate(name)
  if (children.size === 0) process.exit(0)

  const forceTimer = setTimeout(() => {
    for (const child of children.values()) signalGroup(child.pid, "SIGKILL")
  }, terminateGraceMs)
  forceTimer.unref()
}

validate()

if (process.argv.includes("--check")) {
  console.log(`mcp-gateway configuration valid: ${Object.keys(servers).length} servers`)
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

await reapPreviousRun()

for (const name of Object.keys(servers)) start(name)

const probeTimer = setInterval(() => {
  for (const name of Object.keys(servers)) void probe(name)
}, probeIntervalMs)
probeTimer.unref()
