import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));

async function waitForExit(exited, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

test("GitHub manifest uses the existing launcher on a unique loopback port", async () => {
  const { mcpServers } = JSON.parse(await readFile(join(repository, "servers.json"), "utf8"));
  assert.deepEqual(mcpServers.github, {
    port: 8767,
    command: "/bin/sh",
    args: ["-c", 'exec "$HOME/.config/mcp-gateway/bin/github"'],
  });
  const ports = Object.values(mcpServers).map((server) => server.port);
  assert.equal(new Set(ports).size, ports.length);
  await execFile(process.execPath, [join(repository, "supervisor.mjs"), "--check"], {
    env: { PATH: process.env.PATH, MCP_GATEWAY_CONFIG: join(repository, "servers.json") },
    timeout: 5000,
  });
});

test("GitHub launcher scopes the fixture credential and fails closed when missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-github-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const marker = join(directory, "podman-called");
  await mkdir(bin);
  await writeFile(join(directory, ".shellenv"), "GITHUB_MCP_TOKEN=non-production-fixture\n"); // pragma: allowlist secret -- synthetic non-production fixture, not a GitHub token
  await writeFile(join(bin, "podman"), `#!/bin/sh
printf '%s\\n' invoked > "$RECORD_FILE"
[ "$#" -eq 6 ] || exit 21
[ "$1" = run ] && [ "$2" = --rm ] && [ "$3" = -i ] || exit 22
[ "$4" = --env ] && [ "$5" = GITHUB_PERSONAL_ACCESS_TOKEN ] || exit 23
[ "$6" = ghcr.io/github/github-mcp-server:v1.9.0 ] || exit 24
[ "\${GITHUB_PERSONAL_ACCESS_TOKEN-}" = non-production-fixture ] || exit 25
[ "\${GITHUB_MCP_TOKEN+x}" != x ] || exit 26
[ "\${GITHUB_TOKEN+x}" != x ] || exit 27
printf '%s\\n' "$@"
`);
  await chmod(join(bin, "podman"), 0o755);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: directory,
    LANG: "C",
    RECORD_FILE: marker,
  };
  const run = () => execFile("/bin/sh", [join(repository, "bin", "github")], {
    env,
    timeout: 5000,
  });
  const { stdout } = await run();
  assert.deepEqual(stdout.trim().split("\n"), [
    "run", "--rm", "-i", "--env", "GITHUB_PERSONAL_ACCESS_TOKEN",
    "ghcr.io/github/github-mcp-server:v1.9.0",
  ]);
  await rm(marker);
  await rm(join(directory, ".shellenv"));
  await assert.rejects(run());
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await writeFile(join(directory, ".shellenv"), "OTHER_SETTING=fixture\n");
  await assert.rejects(run());
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("independent HTTP sessions share one backend without cross-routing responses", {
  timeout: 60_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-http-"));
  let child;
  let exitPromise = Promise.resolve();
  t.after(async () => {
    try {
      signalGroup(child, "SIGTERM");
      await waitForExit(exitPromise, 2000);
      signalGroup(child, "SIGKILL");
      await waitForExit(exitPromise, 2000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const fixture = [
    "import asyncio, os",
    "from mcp.server.fastmcp import FastMCP",
    'mcp = FastMCP("shared-github-test")',
    "@mcp.tool()",
    "async def echo(value: str, delay_ms: int) -> str:",
    "    await asyncio.sleep(delay_ms / 1000)",
    '    return f"{value}:{os.getpid()}"',
    "mcp.run()",
  ].join("\n");
  child = spawn("mcp-proxy", [
    "--host", "127.0.0.1", "--port", String(port), "--pass-environment",
    "--", "python3", "-c", fixture,
  ], {
    detached: true,
    env: { PATH: process.env.PATH, HOME: directory, LANG: "C" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let failure;
  let ended = false;
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
  exitPromise = new Promise((resolve) => {
    child.once("error", (error) => { failure = error; ended = true; resolve(); });
    child.once("exit", () => { ended = true; resolve(); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (true) {
    if (failure) throw failure;
    assert.equal(ended, false, diagnostic);
    try {
      const response = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.ok) break;
    } catch {}
    assert.ok(Date.now() < deadline, `proxy startup timed out: ${diagnostic}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const headers = (session) => ({
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-03-26",
    ...(session ? { "Mcp-Session-Id": session } : {}),
  });
  const post = (body, session) => fetch(`${origin}/mcp`, {
    method: "POST",
    headers: headers(session),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const parse = async (response) => {
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const message = JSON.parse(body);
    assert.equal(message.error, undefined);
    return message.result;
  };
  const initialize = async () => {
    const response = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "gateway-ci", version: "1" },
      },
    });
    await parse(response);
    const session = response.headers.get("Mcp-Session-Id");
    assert.ok(session);
    const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    await notification.text();
    assert.equal(notification.status, 202);
    return session;
  };
  const first = await initialize();
  const second = await initialize();
  assert.notEqual(first, second);
  for (const session of [first, second]) {
    const result = await parse(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session));
    assert.ok(result.tools.some((tool) => tool.name === "echo"));
  }
  const call = async (session, value, delay_ms) => {
    const result = await parse(await post({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "echo", arguments: { value, delay_ms } },
    }, session));
    assert.notEqual(result.isError, true);
    return result.content[0].text;
  };
  const [slow, fast] = await Promise.all([
    call(first, "first", 250), call(second, "second", 10),
  ]);
  assert.match(slow, /^first:\d+$/);
  assert.match(fast, /^second:\d+$/);
  const backendPid = slow.split(":")[1];
  assert.equal(fast, `second:${backendPid}`);
  const deleted = await fetch(`${origin}/mcp`, {
    method: "DELETE", headers: headers(first), signal: AbortSignal.timeout(5000),
  });
  await deleted.text();
  assert.ok([200, 202, 204].includes(deleted.status));
  assert.equal(await call(second, "survivor", 0), `survivor:${backendPid}`);
  const third = await initialize();
  assert.notEqual(third, second);
  assert.notEqual(third, first);
  assert.equal(await call(third, "reconnected", 0), `reconnected:${backendPid}`);
});
