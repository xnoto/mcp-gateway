import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

// Runs the supervisor against a child that always exits immediately and
// records every spawn timestamp, so restart timing can be asserted.
async function runSupervisor({ minDelayMs, maxDelayMs, runTimeMs }) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-backoff-"));
  const bin = join(directory, "bin");
  const spawns = join(directory, "spawns");
  const config = join(directory, "servers.json");
  await mkdir(bin);
  await writeFile(
    join(bin, "uvx"),
    `#!/bin/sh\nprintf '%s\\n' "$(date +%s%N)" >> ${JSON.stringify(spawns)}\nexit 1\n`,
    "utf8",
  );
  await chmod(join(bin, "uvx"), 0o755);
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { fake: { port: 18765, command: "uvx", args: [] } } }),
    "utf8",
  );

  const child = spawn("node", [join(repository, "supervisor.mjs")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MCP_GATEWAY_CONFIG: config,
      MCP_GATEWAY_MIN_RESTART_DELAY_MS: String(minDelayMs),
      MCP_GATEWAY_MAX_RESTART_DELAY_MS: String(maxDelayMs),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  await new Promise((resolve) => setTimeout(resolve, runTimeMs));
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));

  let timestamps = [];
  try {
    timestamps = (await readFile(spawns, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(directory, { recursive: true, force: true });
  return timestamps;
}

test("quick failures back off exponentially up to the cap", async () => {
  const timestamps = await runSupervisor({ minDelayMs: 100, maxDelayMs: 400, runTimeMs: 1_400 });

  // Fixed 100ms restarts would spawn ~14 times; backoff 100 -> 200 -> 400 -> 400
  // yields 4-7 spawns depending on node startup jitter.
  assert.ok(timestamps.length >= 3, `expected at least 3 spawns, got ${timestamps.length}`);
  assert.ok(timestamps.length <= 7, `expected at most 7 spawns, got ${timestamps.length}`);

  const gaps = timestamps.slice(1).map((time, index) => time - timestamps[index]);
  const milliseconds = gaps.map((gap) => gap / 1e6);
  assert.ok(
    milliseconds[1] > milliseconds[0] * 1.5,
    `second gap should grow: ${milliseconds.join(", ")}`,
  );
  const lastGap = milliseconds[milliseconds.length - 1];
  assert.ok(lastGap >= 350, `cap gap should be >= 350ms, got ${lastGap}ms`);
}, 15_000);
