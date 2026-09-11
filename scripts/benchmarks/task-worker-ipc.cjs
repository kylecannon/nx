// Compare the retained compact graph over JSON IPC with scoped binary IPC.
// Run alternating variants in fresh processes, e.g.:
// node --expose-gc scripts/benchmarks/task-worker-ipc.cjs json 500 3000
// node --expose-gc scripts/benchmarks/task-worker-ipc.cjs binary 500 3000
// Optional: NX_TASK_IPC_BENCH_DIST=packages/nx/dist uses a completed build.
// Elapsed/CPU exclude startup, fixture construction, and digest verification.
// RSS is each process's lifetime peak; do not sum separate process peaks.
// Single-task graphs use the existing JSON channel in both variants.
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const repo = resolve(__dirname, '../..');
const build = process.env.NX_TASK_IPC_BENCH_DIST;
if (!build) {
  const swc = require('@swc/core');
  require.extensions['.ts'] = (mod, filename) =>
    mod._compile(
      swc.transformFileSync(filename, {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      }).code,
      filename
    );
}
const moduleRoot = build || resolve(repo, 'packages/nx');
const extension = build ? 'js' : 'ts';
const { serializeTaskGraph, deserializeTaskGraph } = require(
  resolve(moduleRoot, `src/tasks-runner/task-graph-serialization.${extension}`)
);
const { sendTaskMessage, receiveTaskMessage } = require(
  resolve(moduleRoot, `src/tasks-runner/task-worker-message.${extension}`)
);
function digest(graph) {
  const hash = createHash('sha256');
  for (const [key, value] of Object.entries(graph)) {
    hash.update(JSON.stringify(key));
    if (key === 'tasks')
      for (const [id, task] of Object.entries(value)) {
        hash.update(JSON.stringify(id));
        hash.update(JSON.stringify(task));
      }
    else hash.update(JSON.stringify(value));
  }
  return hash.digest('hex');
}
if (process.argv[2] === 'child') {
  let cpuStart;
  process.once('message', ({ taskGraph }) => {
    const output = deserializeTaskGraph(taskGraph);
    const arrivedAt = performance.timeOrigin + performance.now();
    const cpu = process.cpuUsage(cpuStart);
    const memory = process.memoryUsage();
    const rss = process.resourceUsage().maxRSS / 1024;
    process.send(
      {
        arrivedAt,
        cpuMs: (cpu.user + cpu.system) / 1000,
        peakRssMiB: rss,
        heapMiB: memory.heapUsed / 1024 ** 2,
        digest: digest(output),
      },
      () => process.disconnect()
    );
  });
  receiveTaskMessage();
  global.gc();
  cpuStart = process.cpuUsage();
  process.send({ ready: true });
} else {
  const [variant, countArg, inputsArg] = process.argv.slice(2);
  const count = Number(countArg),
    inputs = Number(inputsArg);
  if (
    !['json', 'binary'].includes(variant) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(inputs) ||
    inputs < 1 ||
    !global.gc
  ) {
    throw Error(
      'Usage: node --expose-gc scripts/benchmarks/task-worker-ipc.cjs <json|binary> <tasks> <inputs>'
    );
  }
  const usePipe = variant === 'binary' && count > 1;
  const shared = Object.fromEntries(
    Array.from({ length: inputs }, (_, i) => [
      `workspace:packages/library-${i}/source/input-${i}.ts`,
      '0123456789abcdef',
    ])
  );
  const tasks = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `project-${i}:build`,
      {
        id: `project-${i}:build`,
        target: { project: `project-${i}`, target: 'build' },
        overrides: {},
        outputs: [],
        hash: `task-hash-${i}`,
        hashDetails: { command: 'build', nodes: { ...shared, unique: `${i}` } },
      },
    ])
  );
  const graph = {
    tasks,
    roots: Object.keys(tasks),
    dependencies: Object.fromEntries(Object.keys(tasks).map((id) => [id, []])),
    continuousDependencies: {},
  };
  const expected = digest(graph);
  const env = { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' };
  delete env.NX_TASK_MESSAGE_FD;
  if (usePipe) env.NX_TASK_MESSAGE_FD = '4';
  const child = fork(__filename, ['child'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc', ...(usePipe ? ['pipe'] : [])],
    execArgv: ['--expose-gc'],
    env,
  });
  const timeout = setTimeout(() => {
    child.kill();
    throw Error('Timed out');
  }, 60000);
  let started, cpuStart, sendMs, parent;
  child.on('message', (message) => {
    if (message.ready) {
      global.gc();
      cpuStart = process.cpuUsage();
      started = performance.timeOrigin + performance.now();
      const payload = {
        taskGraph: serializeTaskGraph(graph),
        targetDescription: tasks['project-0:build'].target,
        overrides: {},
        isVerbose: false,
      };
      if (variant === 'binary') sendTaskMessage(child, payload);
      else
        child.send(payload, (err) => {
          if (err) throw err;
        });
      sendMs = performance.timeOrigin + performance.now() - started;
      return;
    }
    const cpu = process.cpuUsage(cpuStart),
      memory = process.memoryUsage();
    parent = {
      cpuMs: (cpu.user + cpu.system) / 1000,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
      heapMiB: memory.heapUsed / 1024 ** 2,
    };
    if (message.digest !== expected) throw Error('Payload mismatch');
    console.log(
      JSON.stringify({
        variant,
        count,
        inputs,
        sendMs,
        deliveryAndDecodeMs: message.arrivedAt - started,
        parent,
        child: {
          cpuMs: message.cpuMs,
          peakRssMiB: message.peakRssMiB,
          heapMiB: message.heapMiB,
        },
        digest: expected,
      })
    );
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    if (code !== 0 || !parent) process.exitCode = 1;
  });
}
