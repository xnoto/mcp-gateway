import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const repository = new URL("..", import.meta.url).pathname;

async function executable(path, content) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

test("Kubernetes wrapper derives one fixed context without copying credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-gateway-kubernetes-"));
  const bin = join(directory, "bin");
  const runtime = join(directory, "runtime");
  const calls = join(directory, "calls");
  await mkdir(bin);
  await mkdir(runtime);

  await executable(join(bin, "kubectl"), `#!/bin/sh
printf '%s\\n' "$KUBECONFIG" > ${JSON.stringify(join(calls, "source"))}
printf '%s\\n' "$@" > ${JSON.stringify(join(calls, "kubectl"))}
printf '%s\\n' 'apiVersion: v1' 'current-context: staging-eks.angler-elver.ts.net' 'contexts:'
`);
  await executable(join(bin, "npx"), `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(join(calls, "npx"))}
config=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--kubeconfig' ]; then config="$2"; break; fi
  shift
done
test -f "$config"
printf '%s\\n' "$config" > ${JSON.stringify(join(calls, "derived"))}
`);
  await mkdir(calls);

  try {
    await execFile(join(repository, "bin", "kubernetes"), ["staging-eks.angler-elver.ts.net"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: directory,
        KUBECONFIG: join(directory, "source.kubeconfig"),
        XDG_RUNTIME_DIR: runtime,
      },
    });

    const [source, kubectl, npx, derived] = await Promise.all([
      readFile(join(calls, "source"), "utf8"),
      readFile(join(calls, "kubectl"), "utf8"),
      readFile(join(calls, "npx"), "utf8"),
      readFile(join(calls, "derived"), "utf8"),
    ]);
    assert.equal(source.trim(), join(directory, "source.kubeconfig"));
    assert.match(kubectl, /config\nview\n--minify\n--context\nstaging-eks\.angler-elver\.ts\.net/);
    assert.doesNotMatch(kubectl, /--raw|--flatten/);
    assert.match(npx, /kubernetes-mcp-server@0\.0\.66/);
    assert.match(npx, /--cluster-provider\nkubeconfig\n--disable-multi-cluster/);
    assert.match(derived, new RegExp(`^${runtime}/mcp-gateway/kubernetes\\.`));
    assert.deepEqual(await readdir(join(runtime, "mcp-gateway")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
