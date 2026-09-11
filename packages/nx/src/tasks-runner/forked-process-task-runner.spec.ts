import { fork, type ForkOptions } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { TaskGraph } from '../config/task-graph';
import { consumeMessagesFromSocket } from '../utils/consume-messages-from-socket';
import { ForkedProcessTaskRunner } from './forked-process-task-runner';
import { PseudoTerminal } from './pseudo-terminal';
import { deserializeTaskGraph } from './task-graph-serialization';
import {
  deserializeTaskMessage,
  TASK_MESSAGE_TYPE,
} from './task-worker-message';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  fork: vi.fn(),
}));

vi.mock('./utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils')>()),
  getCliPath: () => '/test/run-executor.js',
}));

function graph(count = 2): TaskGraph {
  return {
    roots: ['a'],
    dependencies: {},
    continuousDependencies: {},
    tasks: Object.fromEntries(
      ['a', 'b'].slice(0, count).map((id) => [
        id,
        {
          id,
          target: { project: id, target: 'build' },
          overrides: { __overrides_unparsed__: [] },
          outputs: [],
          hash: `hash-${id}`,
          hashDetails: {
            command: 'build',
            nodes: { shared: 'value'.repeat(100) },
          },
        },
      ])
    ),
  };
}

describe('task-worker startup routes', () => {
  let child: any;
  let messages: ReturnType<typeof deserializeTaskMessage>[];
  let options: ForkOptions;
  const streams: PassThrough[] = [];

  beforeEach(() => {
    messages = [];
    vi.mocked(fork).mockImplementation(((
      _path: string,
      config: ForkOptions
    ) => {
      options = config;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const pipe = config.stdio[4] === 'pipe' ? new PassThrough() : null;
      streams.push(stdout, stderr, ...(pipe ? [pipe] : []));
      pipe?.on(
        'data',
        consumeMessagesFromSocket((data) =>
          messages.push(deserializeTaskMessage(data))
        )
      );
      child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdio: [null, stdout, stderr, null, pipe],
        send: vi.fn(),
      });
      return child;
    }) as typeof fork);
  });

  afterEach(() => {
    for (const stream of streams.splice(0)) stream.destroy();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'uses the pipe for legacy worker startup (piped output=%s)',
    async (pipeOutput) => {
      const input = graph();
      const runner = new ForkedProcessTaskRunner(
        { lifeCycle: {} } as any,
        false
      );
      await runner.forkProcessLegacy(input.tasks.a, {
        taskGraph: input,
        env: { NX_DAEMON: 'false' },
        temporaryOutputPath: '/unused',
        streamOutput: false,
        pipeOutput,
      });
      expect(options.stdio).toEqual([
        'inherit',
        pipeOutput ? 'pipe' : 'inherit',
        pipeOutput ? 'pipe' : 'inherit',
        'ipc',
        'pipe',
      ]);
      expect(options.env.NX_TASK_MESSAGE_FD).toBe('4');
      expect(options.serialization).toBeUndefined();
      expect(child.send).not.toHaveBeenCalled();
      expect(messages).toHaveLength(1);
      expect(deserializeTaskGraph(messages[0].taskGraph)).toEqual(input);
    }
  );

  it('keeps one-task launches on existing JSON IPC', async () => {
    const input = graph(1);
    const runner = new ForkedProcessTaskRunner({ lifeCycle: {} } as any, false);
    await runner.forkProcessLegacy(input.tasks.a, {
      taskGraph: input,
      env: { NX_DAEMON: 'false' },
      temporaryOutputPath: '/unused',
      streamOutput: false,
      pipeOutput: true,
    });
    expect(options.stdio[4]).toBe('ignore');
    expect(options.env.NX_TASK_MESSAGE_FD).toBeUndefined();
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ taskGraph: input })
    );
    expect(messages).toHaveLength(0);
  });

  it('uses the pipe for both batch graphs, including a single-task batch', async () => {
    const full = graph();
    const batch = graph(1);
    const projectGraph = { nodes: {}, dependencies: {} };
    const runner = new ForkedProcessTaskRunner({ lifeCycle: {} } as any, false);
    await runner.forkProcessForBatch(
      { id: 'batch', executorName: 'test:build', taskGraph: batch },
      projectGraph,
      full,
      { NX_DAEMON: 'false' }
    );
    expect(options.env.NX_TASK_MESSAGE_FD).toBe('4');
    expect(options.serialization).toBeUndefined();
    expect(child.send).not.toHaveBeenCalled();
    expect(deserializeTaskGraph(messages[0].batchTaskGraph)).toEqual(batch);
    expect(deserializeTaskGraph(messages[0].fullTaskGraph)).toEqual(full);
    expect(messages[0].projectGraph).toEqual(projectGraph);
  });

  it.each([1, 2])('configures the PTY bridge for %s tasks', async (count) => {
    const input = graph(count);
    const process = { send: vi.fn(), getPid: () => undefined, onExit: vi.fn() };
    const terminal = { fork: vi.fn(async () => process) };
    const runner = new ForkedProcessTaskRunner({ lifeCycle: {} } as any, true);
    vi.spyOn(PseudoTerminal, 'isSupported').mockReturnValue(true);
    vi.spyOn(runner as any, 'createPseudoTerminal').mockResolvedValue(terminal);
    await runner.forkProcess(input.tasks.a, {
      taskGraph: input,
      env: { NX_DAEMON: 'false' },
      temporaryOutputPath: '/unused',
      streamOutput: false,
      pipeOutput: true,
      disablePseudoTerminal: false,
    });
    expect(
      (terminal.fork.mock.calls[0] as any)[2].jsEnv.NX_TASK_MESSAGE_FD
    ).toBe(count > 1 ? '4' : '');
    const [message, format] = process.send.mock.calls[0];
    if (count > 1) {
      expect(format).toBe('v8');
      expect(message.type).toBe(TASK_MESSAGE_TYPE);
      const decoded = deserializeTaskMessage(message.payload);
      expect(deserializeTaskGraph(decoded.taskGraph)).toEqual(input);
    } else {
      expect(format).toBeUndefined();
      expect(message.taskGraph).toEqual(input);
    }
  });
});
