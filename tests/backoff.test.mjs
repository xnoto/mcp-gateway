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
      MCP_GATEWAY_STATE: join(directory, "state.json"),
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
  const minDelayMs = 100;
  const maxDelayMs = 400;
  const timestamps = await runSupervisor({ minDelayMs, maxDelayMs, runTimeMs: 1_400 });

  // Fixed 100ms restarts would spawn ~14 times; backoff 100 -> 200 -> 400 -> 400
  // yields 4-7 spawns depending on node startup jitter.
  assert.ok(timestamps.length >= 3, `expected at least 3 spawns, got ${timestamps.length}`);
  assert.ok(timestamps.length <= 7, `expected at most 7 spawns, got ${timestamps.length}`);

  const gaps = timestamps.slice(1).map((time, index) => (time - timestamps[index]) / 1e6);
  const report = gaps.map((gap) => gap.toFixed(1)).join(", ");

  // Every gap carries the same spawn overhead on top of its scheduled delay,
  // so gaps are compared against the delay they were scheduled for and growth
  // is measured as a difference rather than a ratio; a ratio reads the shared
  // overhead as shrinkage and flakes at these deliberately short delays.
  gaps.forEach((gap, index) => {
    const scheduled = Math.min(minDelayMs * 2 ** index, maxDelayMs);
    assert.ok(gap >= scheduled * 0.9, `gap ${index} should be >= ${scheduled}ms: ${report}`);
  });

  assert.ok(
    gaps[1] - gaps[0] >= minDelayMs * 0.5,
    `second gap should grow by about ${minDelayMs}ms: ${report}`,
  );
  const lastGap = gaps[gaps.length - 1];
  assert.ok(lastGap >= maxDelayMs * 0.9, `cap gap should be >= ${maxDelayMs}ms: ${report}`);
}, 15_000);
