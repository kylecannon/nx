// Run each variant in a fresh process, alternating order between samples.
// node --expose-gc scripts/benchmarks/task-graph-serialization.cjs raw 500 3000
// node --expose-gc scripts/benchmarks/task-graph-serialization.cjs compact 500 3000
// Peak RSS includes fixture construction and module loading. Other measures
// cover encode/stringify/parse/decode only, excluding verification.
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const swc = require('@swc/core');
const { Module } = require('node:module');
const source = resolve(
  __dirname,
  '../../packages/nx/src/tasks-runner/task-graph-serialization.ts'
);
const compiled = swc.transformFileSync(source, {
  jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
  module: { type: 'commonjs' },
}).code;
const mod = new Module(source);
mod._compile(compiled, source);
const { serializeTaskGraph, deserializeTaskGraph } = mod.exports;
const [variant, countArg, inputsArg] = process.argv.slice(2);
const count = Number(countArg),
  inputs = Number(inputsArg);
if (
  !['raw', 'compact'].includes(variant) ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !Number.isSafeInteger(inputs) ||
  inputs < 1 ||
  !global.gc
) {
  throw new Error(
    'Usage: node --expose-gc scripts/benchmarks/task-graph-serialization.cjs <raw|compact> <tasks> <inputs>'
  );
}
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
function digest(g) {
  const d = createHash('sha256');
  for (const task of Object.values(g.tasks)) d.update(JSON.stringify(task));
  return d.digest('hex');
}
const expected = digest(graph);
global.gc();
const cpu = process.cpuUsage();
const start = performance.now();
const wire = variant === 'raw' ? graph : serializeTaskGraph(graph);
const encoded = performance.now();
const text = JSON.stringify(wire);
const stringified = performance.now();
const received = JSON.parse(text);
const parsed = performance.now();
const output = variant === 'raw' ? received : deserializeTaskGraph(received);
const finished = performance.now();
const used = process.cpuUsage(cpu);
const rss = process.resourceUsage().maxRSS / 1024;
if (digest(output) !== expected) throw Error('Payload mismatch');
console.log(
  JSON.stringify({
    variant,
    count,
    inputs,
    bytes: Buffer.byteLength(text),
    encodeMs: encoded - start,
    stringifyMs: stringified - encoded,
    parseMs: parsed - stringified,
    decodeMs: finished - parsed,
    totalMs: finished - start,
    cpuMs: (used.user + used.system) / 1000,
    peakRssMiB: rss,
    digest: expected,
  })
);
