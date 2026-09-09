import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const serviceLabel = "com.xnoto.mcp-gateway";
const serviceUnit = "mcp-gateway.service";

async function writeExecutable(path, content) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function runRestart(platform, serviceExit = 0) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-restart-"));
  const bin = join(directory, "bin");
  const call = join(directory, "call");
  await writeFile(join(directory, ".keep"), "", "utf8");
  await writeExecutable(join(bin, "uname"), "#!/bin/sh\nprintf '%s\\n' \"$MCP_GATEWAY_TEST_PLATFORM\"\n");
  await writeExecutable(join(bin, "id"), "#!/bin/sh\nprintf '501\\n'\n");
  for (const command of ["launchctl", "systemctl"]) {
    await writeExecutable(
      join(bin, command),
      `#!/bin/sh\nprintf '${command}\\n' > \"$MCP_GATEWAY_TEST_CALL\"\nprintf '%s\\n' \"$@\" >> \"$MCP_GATEWAY_TEST_CALL\"\nexit \"$MCP_GATEWAY_TEST_SERVICE_EXIT\"\n`,
    );
  }

  try {
    let result;
    try {
      const output = await execFileAsync("make", ["restart"], {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MCP_GATEWAY_TEST_CALL: call,
          MCP_GATEWAY_TEST_PLATFORM: platform,
          MCP_GATEWAY_TEST_SERVICE_EXIT: String(serviceExit),
        },
      });
      result = { code: 0, ...output };
    } catch (error) {
      result = {
        code: typeof error.code === "number" ? error.code : 1,
        stderr: error.stderr ?? "",
        stdout: error.stdout ?? "",
      };
    }

    let invocation = null;
    try {
      invocation = (await readFile(call, "utf8")).trim().split("\n");
    } catch {
      // An unsupported platform must not invoke a service manager.
    }
    return { ...result, invocation };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("restart dispatches the macOS LaunchAgent", async () => {
  const result = await runRestart("Darwin");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.invocation, [
    "launchctl",
    "kickstart",
    "-k",
    `gui/501/${serviceLabel}`,
  ]);
});

test("restart dispatches the Linux user service", async () => {
  const result = await runRestart("Linux");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.invocation, ["systemctl", "--user", "restart", serviceUnit]);
});

test("restart rejects unsupported platforms without a service call", async () => {
  const result = await runRestart("FreeBSD");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unsupported platform: FreeBSD/);
  assert.equal(result.invocation, null);
});

test("restart propagates a service-manager failure", async () => {
  const result = await runRestart("Linux", 23);
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.invocation, ["systemctl", "--user", "restart", serviceUnit]);
});
