import { readFileSync } from "node:fs"
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

const checks = await Promise.allSettled(
  Object.entries(servers).map(async ([name, server]) => {
    await probeMcp(server.port)
    return name
  }),
)

const unavailable = checks.flatMap((result, index) =>
  result.status === "rejected"
    ? [`${Object.keys(servers)[index]}: ${result.reason?.message ?? result.reason}`]
    : [],
)

if (unavailable.length > 0) {
  console.error(`mcp-gateway unavailable proxies:\n${unavailable.join("\n")}`)
  process.exit(1)
}

console.log(`mcp-gateway healthy: ${checks.length} MCP servers`)
