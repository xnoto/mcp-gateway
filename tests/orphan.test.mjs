import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

function bootSeconds() {
  return Math.round(Date.now() / 1_000 - uptime());
}

// Resolves to "exited" when the process ends, or "alive" once the wait is up.
function settle(child, waitMs) {
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve("exited"))),
    new Promise((resolve) => setTimeout(() => resolve("alive"), waitMs)),
  ]);
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

// A long-lived process group standing in for a leaked proxy tree.
function spawnGroup() {
  const child = spawn("sh", ["-c", "while : ; do sleep 0.2 ; done"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function fixture({ uvx }) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-orphan-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "uvx"), uvx, "utf8");
  await chmod(join(bin, "uvx"), 0o755);
  const config = join(directory, "servers.json");
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { fake: { port: 18771, command: "uvx", args: [] } } }),
    "utf8",
  );
  return { directory, bin, config, state: join(directory, "state.json") };
}

function startSupervisor({ bin, config, state }) {
  return spawn("node", [join(repository, "supervisor.mjs")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MCP_GATEWAY_CONFIG: config,
      MCP_GATEWAY_STATE: state,
      MCP_GATEWAY_MIN_RESTART_DELAY_MS: "50",
      MCP_GATEWAY_MAX_RESTART_DELAY_MS: "200",
      MCP_GATEWAY_TERMINATE_GRACE_MS: "500",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

test("stopping a server kills the whole downstream tree", async () => {
  const grandchild = join(tmpdir(), `mcp-gateway-grandchild-${process.pid}`);
  const context = await fixture({
    uvx: `#!/bin/sh
sh -c 'while : ; do sleep 0.2 ; done' &
printf '%s\\n' "$!" > ${JSON.stringify(grandchild)}
exec sleep 30
`,
  });

  try {
    const supervisor = startSupervisor(context);
    const pid = await until(async () => {
      const raw = await readFile(grandchild, "utf8").catch(() => "");
      const value = Number(raw.trim());
      return Number.isInteger(value) && value > 1 ? value : null;
    }, 10_000);
    assert.ok(pid, "fake server never reported its grandchild");

    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));

    // The grandchild is not a child of the supervisor, so its death can only
    // be observed by signalling it.
    const gone = await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }, 10_000);
    assert.ok(gone, `grandchild ${pid} survived the supervisor`);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
    await rm(grandchild, { force: true });
  }
}, 30_000);

test("a previous run's orphaned process groups are swept at startup", async () => {
  const context = await fixture({ uvx: "#!/bin/sh\nexec sleep 30\n" });
  const victim = spawnGroup();

  try {
    await writeFile(
      context.state,
      JSON.stringify({ boot: bootSeconds(), groups: { fake: victim.pid } }),
      "utf8",
    );

    const supervisor = startSupervisor(context);
    const outcome = await settle(victim, 10_000);
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));
    assert.equal(outcome, "exited", `orphaned group ${victim.pid} survived startup`);
  } finally {
    victim.kill("SIGKILL");
    await rm(context.directory, { recursive: true, force: true });
  }
}, 30_000);

test("state recorded under a different boot is not acted on", async () => {
  const context = await fixture({ uvx: "#!/bin/sh\nexec sleep 30\n" });
  const bystander = spawnGroup();

  try {
    await writeFile(
      context.state,
      JSON.stringify({ boot: bootSeconds() - 86_400, groups: { fake: bystander.pid } }),
      "utf8",
    );

    const supervisor = startSupervisor(context);
    const outcome = await settle(bystander, 3_000);
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => supervisor.once("exit", resolve));
    assert.equal(outcome, "alive", `recycled pid ${bystander.pid} was killed on stale state`);
  } finally {
    bystander.kill("SIGKILL");
    await rm(context.directory, { recursive: true, force: true });
  }
}, 30_000);
