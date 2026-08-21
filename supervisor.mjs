import { spawn } from "node:child_process"
import { readFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { probeMcp } from "./probe.mjs"

const configPath =
  process.env.MCP_GATEWAY_CONFIG ?? join(homedir(), ".config", "mcp-gateway", "servers.json")
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
const restartDelayMs = 5_000
const startupGraceMs = 120_000
const probeIntervalMs = 30_000
const failedProbesBeforeRestart = 3
const children = new Map()
const restartTimers = new Map()
const startTimes = new Map()
const probeFailures = new Map()
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

function scheduleRestart(name) {
  if (stopping || restartTimers.has(name)) return
  const timer = setTimeout(() => {
    restartTimers.delete(name)
    start(name)
  }, restartDelayMs)
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
  })
  children.set(name, child)
  startTimes.set(name, Date.now())
  probeFailures.set(name, 0)

  child.on("error", (error) => {
    console.error(`[mcp-gateway] ${name} failed to start: ${error.message}`)
  })

  child.on("exit", (code, signal) => {
    children.delete(name)
    startTimes.delete(name)
    probeFailures.delete(name)
    if (stopping) {
      if (children.size === 0) process.exit(0)
      return
    }
    console.error(
      `[mcp-gateway] ${name} exited (${signal ?? `code ${code}`}); restarting in ${restartDelayMs / 1_000}s`,
    )
    scheduleRestart(name)
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
  } catch (error) {
    const failures = (probeFailures.get(name) ?? 0) + 1
    probeFailures.set(name, failures)
    console.error(
      `[mcp-gateway] ${name} probe failed (${failures}/${failedProbesBeforeRestart}): ${error.message}`,
    )
    if (failures >= failedProbesBeforeRestart) {
      probeFailures.set(name, 0)
      children.get(name)?.kill("SIGTERM")
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
  for (const child of children.values()) child.kill("SIGTERM")
  if (children.size === 0) process.exit(0)

  const forceTimer = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL")
  }, 5_000)
  forceTimer.unref()
}

validate()

if (process.argv.includes("--check")) {
  console.log(`mcp-gateway configuration valid: ${Object.keys(servers).length} servers`)
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

for (const name of Object.keys(servers)) start(name)

const probeTimer = setInterval(() => {
  for (const name of Object.keys(servers)) void probe(name)
}, probeIntervalMs)
probeTimer.unref()
