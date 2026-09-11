import { fork, type ChildProcess } from 'child_process';
import { once } from 'events';
import { join } from 'path';
import { deserialize } from 'v8';
import type { TaskGraph } from '../config/task-graph';
import { frameHeader } from '../utils/consume-messages-from-socket';
import {
  deserializeTaskGraph,
  serializeTaskGraph,
  type SerializedTaskGraph,
} from './task-graph-serialization';
import {
  deserializeTaskMessage,
  receiveTaskMessage,
  sendTaskMessage,
  serializeTaskMessage,
} from './task-worker-message';

function graph(): TaskGraph {
  const overrides = { nested: { value: 1 } };
  return {
    roots: ['a'],
    tasks: Object.fromEntries(
      ['a', 'b'].map((id) => [
        id,
        {
          id,
          target: { project: id, target: 'build' },
          overrides,
          outputs: [],
          hash: `hash-${id}`,
          startTime: 123,
          hashDetails: {
            command: 'build',
            nodes: {
              ...Object.fromEntries(
                Array.from({ length: 100 }, (_, i) => [
                  `input-${i}`,
                  'shared-value'.repeat(10),
                ])
              ),
              distinct: id,
            },
          },
        },
      ])
    ),
    dependencies: { a: [], b: ['a'] },
    continuousDependencies: {},
  };
}

function restore(message: ReturnType<typeof deserializeTaskMessage>) {
  for (const key of ['taskGraph', 'batchTaskGraph', 'fullTaskGraph']) {
    if (message[key])
      message[key] = deserializeTaskGraph(
        message[key] as SerializedTaskGraph | TaskGraph
      );
  }
  return message;
}

describe('binary task messages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses binary typed arrays only for Nx-owned tables and preserves JSON metadata', () => {
    const input = graph();
    const metadata = {
      optional: undefined,
      nan: NaN,
      infinity: Infinity,
      negativeZero: -0,
      date: new Date('2020-01-01T00:00:00Z'),
      ignored() {},
      custom: { toJSON: (key: string) => ({ key, converted: true }) },
      array: [undefined, , NaN],
    };
    input.tasks.a.overrides.metadata = metadata;
    const message = {
      taskGraph: serializeTaskGraph(input),
      overrides: input.tasks.a.overrides,
      isVerbose: false,
    };
    const payload = serializeTaskMessage(message);
    const wire = deserialize(payload);
    expect(wire.graphs[0].indices).toBeInstanceOf(Uint32Array);
    expect(wire.graphs[0].lengths).toBeInstanceOf(Uint32Array);
    const actual = restore(deserializeTaskMessage(payload));
    const expected = restore(JSON.parse(JSON.stringify(message)));
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    const actualGraph = actual.taskGraph as TaskGraph;
    expect(actualGraph.tasks.a.overrides).not.toBe(
      actualGraph.tasks.b.overrides
    );
    expect(actual.overrides).not.toBe(actualGraph.tasks.a.overrides);
    actualGraph.tasks.a.overrides.nested.value = 2;
    expect(actualGraph.tasks.b.overrides.nested.value).toBe(1);
    expect(
      Object.getOwnPropertyDescriptor(
        actualGraph.tasks.a.hashDetails.nodes,
        'input-0'
      )
    ).toEqual({
      value: 'shared-value'.repeat(10),
      writable: true,
      configurable: true,
      enumerable: true,
    });
    actualGraph.tasks.a.hashDetails.nodes['input-0'] = 'changed';
    expect(actualGraph.tasks.b.hashDetails.nodes['input-0']).toBe(
      'shared-value'.repeat(10)
    );
  });

  it.each(['task', 'details', 'nodes'])(
    'honors custom toJSON on %s',
    (location) => {
      const input = graph();
      const target =
        location === 'task'
          ? input.tasks.a
          : location === 'details'
            ? input.tasks.a.hashDetails
            : input.tasks.a.hashDetails.nodes;
      Object.defineProperty(target, 'toJSON', {
        value: (key: string) => ({ custom: key }),
        enumerable: false,
      });
      const message = { taskGraph: serializeTaskGraph(input) };
      expect(
        JSON.stringify(
          restore(deserializeTaskMessage(serializeTaskMessage(message)))
        )
      ).toBe(JSON.stringify(restore(JSON.parse(JSON.stringify(message)))));
    }
  );

  it('keeps uncompact graphs on JSON and retains unsupported-value errors', () => {
    const input = graph();
    delete input.tasks.b;
    const message = {
      taskGraph: serializeTaskGraph(input),
      overrides: { ignored() {}, optional: undefined },
    };
    const payload = serializeTaskMessage(message);
    expect(payload[0]).not.toBe(0xff);
    expect(deserializeTaskMessage(payload)).toEqual(
      JSON.parse(JSON.stringify(message))
    );
    expect(() => serializeTaskMessage({ ...message, extra: 1n })).toThrow();
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => serializeTaskMessage({ ...message, extra: cycle })).toThrow();
  });

  it('round-trips both batch graphs without sharing mutable state', () => {
    const input = graph();
    const encoded = serializeTaskGraph(input);
    const message = {
      type: 0,
      batchTaskGraph: encoded,
      fullTaskGraph: encoded,
      projectGraph: { nodes: {}, dependencies: {} },
    };
    const actual = restore(
      deserializeTaskMessage(serializeTaskMessage(message))
    );
    expect(actual.batchTaskGraph).toEqual(input);
    expect(actual.fullTaskGraph).toEqual(input);
    (actual.batchTaskGraph as TaskGraph).tasks.a.hashDetails.nodes['input-0'] =
      'changed';
    expect(
      (actual.fullTaskGraph as TaskGraph).tasks.a.hashDetails.nodes['input-0']
    ).toBe('shared-value'.repeat(10));
  });

  it('takes fresh snapshots of changing hashes, overrides, and timing fields', () => {
    const input = graph();
    const first = serializeTaskMessage({
      taskGraph: serializeTaskGraph(input),
    });
    input.tasks.a.hash = 'updated-hash';
    input.tasks.a.hashDetails.nodes['input-0'] = 'updated-input';
    input.tasks.a.startTime = 456;
    input.tasks.a.overrides.nested.value = 2;
    const second = serializeTaskMessage({
      taskGraph: serializeTaskGraph(input),
    });
    const before = restore(deserializeTaskMessage(first))
      .taskGraph as TaskGraph;
    const after = restore(deserializeTaskMessage(second)).taskGraph;
    expect(before.tasks.a.hash).toBe('hash-a');
    expect(before.tasks.a.startTime).toBe(123);
    expect(before.tasks.a.overrides.nested.value).toBe(1);
    expect(JSON.stringify(after)).toBe(JSON.stringify(input));
  });

  it('preserves task ids, input names, Unicode, and property order', () => {
    const input = graph();
    input.tasks = Object.fromEntries(
      ['__proto__', 'constructor', '2', '10', '日本語'].map((id, i) => [
        id,
        {
          ...input.tasks.a,
          id,
          hash: `hash-${i}`,
          hashDetails: {
            command: 'build',
            nodes: {
              ...input.tasks.a.hashDetails.nodes,
              ...Object.fromEntries([
                ['__proto__', 'value'],
                ['2', 'numeric'],
                ['日本語', '\ud800'],
              ]),
            },
          },
        },
      ])
    );
    const actual = restore(
      deserializeTaskMessage(
        serializeTaskMessage({ taskGraph: serializeTaskGraph(input) })
      )
    ).taskGraph as TaskGraph;
    expect(JSON.stringify(actual)).toBe(JSON.stringify(input));
    expect(
      Object.getPrototypeOf(actual.tasks['__proto__'].hashDetails.nodes)
    ).toBe(Object.prototype);
    expect(
      Object.hasOwn(actual.tasks['__proto__'].hashDetails.nodes, '__proto__')
    ).toBe(true);
  });

  it('does not open a pipe for legacy callers', () => {
    vi.stubEnv('NX_TASK_MESSAGE_FD', undefined);
    expect(() => receiveTaskMessage()).not.toThrow();
    const child = { stdio: [], send: vi.fn() };
    const message = { taskGraph: graph() };
    sendTaskMessage(child as unknown as ChildProcess, message);
    expect(child.send).toHaveBeenCalledWith(message);
    expect(() =>
      sendTaskMessage(child as unknown as ChildProcess, Buffer.from('data'))
    ).toThrow('unavailable');
  });
});

describe('task message pipe', () => {
  const children = new Set<ChildProcess>();
  afterEach(() => {
    for (const child of children) child.kill();
    children.clear();
  });

  async function start(binary = true, args: string[] = []) {
    const child = fork(
      join(__dirname, '__fixtures__/task-worker-message.cjs'),
      args,
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc', binary ? 'pipe' : 'ignore'],
        execArgv: [],
        env: {
          ...process.env,
          NX_DAEMON: 'false',
          NX_NO_CLOUD: 'true',
          NX_TASK_MESSAGE_FD: binary ? '4' : undefined,
        },
      }
    );
    children.add(child);
    const ready = await once(child, 'message');
    expect(ready[0]).toEqual({ ready: true });
    return child;
  }

  it.each([false, true])(
    'round-trips actual startup and ordinary JSON IPC (binary=%s)',
    async (binary) => {
      const child = await start(binary);
      const input = graph();
      const received = once(child, 'message');
      sendTaskMessage(child, {
        taskGraph: serializeTaskGraph(input),
        overrides: input.tasks.a.overrides,
      });
      const [reply] = await received;
      expect(reply.taskGraph).toEqual(JSON.parse(JSON.stringify(input)));
      expect(reply.hasPrivateFdEnv).toBe(false);
      expect(reply.restoredDispatch).toBe(true);
      const response = once(child, 'message');
      child.send({ control: true, value: { toJSON: () => 'json-conversion' } });
      expect((await response)[0]).toEqual({
        value: 'json-conversion',
        convertedReply: 'json-reply',
      });
      const exit = once(child, 'exit');
      child.disconnect();
      expect((await exit)[0]).toBe(0);
      children.delete(child);
    }
  );

  it('delivers startup before queued ordinary IPC messages and restores dispatch', async () => {
    const child = await start(true, ['queued']);
    const replies: any[] = [];
    const received = new Promise<void>((resolve) => {
      child.on('message', (reply) => {
        replies.push(reply);
        if (replies.length === 3) resolve();
      });
    });
    const input = graph();
    sendTaskMessage(child, { taskGraph: serializeTaskGraph(input) });
    await received;
    expect(replies[0].taskGraph).toEqual(JSON.parse(JSON.stringify(input)));
    expect(replies[0].restoredDispatch).toBe(true);
    expect(replies.slice(1)).toEqual([
      { value: 'queued-1', convertedReply: 'json-reply' },
      { value: 'queued-2', convertedReply: 'json-reply' },
    ]);
    const exit = once(child, 'exit');
    child.disconnect();
    await exit;
    children.delete(child);
  });

  it('reads fragmented frames through the dedicated pipe', async () => {
    const child = await start();
    const input = graph();
    const payload = serializeTaskMessage({
      taskGraph: serializeTaskGraph(input),
    });
    const received = once(child, 'message');
    const pipe = child.stdio[4] as import('net').Socket;
    const header = frameHeader(payload.length);
    for (const part of [
      header.subarray(0, 2),
      header.subarray(2),
      payload.subarray(0, 11),
    ]) {
      pipe.write(part);
      await new Promise((resolve) => setImmediate(resolve));
    }
    pipe.end(payload.subarray(11));
    expect((await received)[0].taskGraph).toEqual(
      JSON.parse(JSON.stringify(input))
    );
    const exit = once(child, 'exit');
    child.disconnect();
    await exit;
    children.delete(child);
  });

  it('fails an incomplete startup frame instead of hanging', async () => {
    const child = await start();
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const exit = once(child, 'exit');
    (child.stdio[4] as import('net').Socket).end('NX_MSG_100:incomplete');
    expect((await exit)[0]).toBe(1);
    expect(stderr).toContain('before receiving the startup message');
    children.delete(child);
  });
});
