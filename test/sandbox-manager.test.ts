const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox } = require("../dist/sandbox-manager.js");
const { execSync } = require("child_process");

function readStdout(proc) {
  return new Promise((resolve, reject) => {
    let output = "";
    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

test("createSandbox allows subprocess execution only with explicit opt-in", async () => {
  const settings = {
    useDocker: false,
    allowUnsandboxedSubprocess: true,
  };
  const sandbox = await createSandbox(settings);
  const cwd = process.cwd();
  const proc = sandbox.spawn("print('hello from sandbox')", cwd);
  const output = await readStdout(proc);
  assert.match(output, /hello from sandbox/);
  assert.equal(sandbox.getRuntimeWorkspaceRoot(cwd), cwd);
  await sandbox.cleanup();
});

test("createSandbox rejects implicit unsandboxed subprocess mode", async () => {
  await assert.rejects(
    createSandbox({ useDocker: false, allowUnsandboxedSubprocess: false }),
    /PTC requires a sandboxed runtime/
  );
});


// --- Docker integration tests (skip if Docker unavailable) ---

let dockerAvailable = false;
try {
  const dockerBin = execSync('which docker', { encoding: 'utf-8' }).trim();
  execSync(`"${dockerBin}" --version`, { stdio: 'ignore' });
  dockerAvailable = true;
} catch {}

function runInSandbox(sandbox, code, cwd) {
  return new Promise((resolve, reject) => {
    const proc = sandbox.spawn(code, cwd);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    proc.on('error', reject);
  });
}

function getContainerCount() {
  try {
    const out = execSync('docker ps --filter name=pi-ptc- --format "{{.ID}}"', { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

function getRunningContainerIds() {
  try {
    const out = execSync('docker ps --filter name=pi-ptc- --format "{{.ID}}"', { encoding: 'utf-8' });
    return out.trim().split('\n').filter(Boolean).sort();
  } catch { return []; }
}

test('Docker: first call starts a container', { skip: !dockerAvailable }, async () => {
  const sandbox = await createSandbox({ useDocker: true, allowUnsandboxedSubprocess: false });
  const cwd = process.cwd();

  const before = getContainerCount();
  const result = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd);
  assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /HOST=/);

  const after = getContainerCount();
  await sandbox.cleanup();

  assert.ok(after >= before + 1, `expected at least ${before + 1} container(s), got ${after}`);
});

test('Docker: same cwd reuses container across multiple calls', { skip: !dockerAvailable }, async () => {
  const sandbox = await createSandbox({ useDocker: true, allowUnsandboxedSubprocess: false });
  const cwd = process.cwd();

  const r1 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd);
  assert.equal(r1.exitCode, 0, `call 1 stderr: ${r1.stderr}`);
  const after1 = getRunningContainerIds();
  assert.equal(after1.length, 1, `expected 1 container after first call, got ${after1.length}`);

  const r2 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd);
  assert.equal(r2.exitCode, 0, `call 2 stderr: ${r2.stderr}`);
  const after2 = getRunningContainerIds();

  await sandbox.cleanup();

  // Same hostname = same container
  const h1 = r1.stdout.match(/HOST=(\S+)/)?.[1];
  const h2 = r2.stdout.match(/HOST=(\S+)/)?.[1];
  assert.equal(h1, h2, `different hostnames: call1=${h1} call2=${h2} — container not reused`);

  // Container count unchanged = no new container created
  assert.deepEqual(after1, after2, 'container was not reused — different container IDs');
});

test('Docker: different cwd creates new container, stops old one', { skip: !dockerAvailable }, async () => {
  const sandbox = await createSandbox({ useDocker: true, allowUnsandboxedSubprocess: false });
  const cwd1 = process.cwd();
  const cwd2 = '/tmp';

  const r1 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd1);
  assert.equal(r1.exitCode, 0, `call 1 stderr: ${r1.stderr}`);
  const h1 = r1.stdout.match(/HOST=(\S+)/)?.[1];

  const r2 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd2);
  assert.equal(r2.exitCode, 0, `call 2 stderr: ${r2.stderr}`);
  const h2 = r2.stdout.match(/HOST=(\S+)/)?.[1];

  await sandbox.cleanup();

  assert.notEqual(h1, h2, `same hostname for different cwds: ${h1} — container not recreated`);
});

test('Docker: switching back to original cwd creates yet another new container', { skip: !dockerAvailable }, async () => {
  const sandbox = await createSandbox({ useDocker: true, allowUnsandboxedSubprocess: false });
  const cwd1 = process.cwd();
  const cwd2 = '/tmp';

  const r1 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd1);
  const r2 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd2);
  const r3 = await runInSandbox(sandbox, 'import os; print(f"HOST={os.uname().nodename}")', cwd1);

  await sandbox.cleanup();

  const h1 = r1.stdout.match(/HOST=(\S+)/)?.[1];
  const h2 = r2.stdout.match(/HOST=(\S+)/)?.[1];
  const h3 = r3.stdout.match(/HOST=(\S+)/)?.[1];

  assert.notEqual(h1, h2, 'cwd1→cwd2 should create new container');
  assert.notEqual(h2, h3, 'cwd2→cwd1 should create new container');
  assert.notEqual(h1, h3, 'returning to cwd1 should not reuse original container');
});

test('Docker: cleanup stops container', { skip: !dockerAvailable }, async () => {
  const sandbox = await createSandbox({ useDocker: true, allowUnsandboxedSubprocess: false });
  const cwd = process.cwd();

  await runInSandbox(sandbox, 'print("hello")', cwd);
  const before = getContainerCount();
  assert.ok(before >= 1, `expected at least 1 container, got ${before}`);

  await sandbox.cleanup();

  const after = getContainerCount();
  assert.equal(after, 0, `expected 0 containers after cleanup, got ${after}`);
});
