import {
  deserializeTaskMessage,
  serializeTaskMessage,
} from '../src/tasks-runner/task-worker-message';
import { TaskGraph } from '../src/config/task-graph';
import { run } from '../src/command-line/run/run';
import { serializeTaskGraph } from '../src/tasks-runner/task-graph-serialization';

vi.mock('../src/command-line/run/run', () => ({ run: vi.fn(async () => 0) }));

describe('run-executor task graph transport', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NX_TASK_MESSAGE_FD', undefined);
    vi.stubEnv('NX_WORKSPACE_ROOT', '/workspace');
    vi.stubEnv('NX_TERMINAL_OUTPUT_PATH', '');
    vi.stubEnv('NX_CLI_SET', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['original', 'compact', 'binary'])(
    'passes the complete %s graph to the executor',
    async (format) => {
      const input: TaskGraph = {
        roots: ['a:build'],
        dependencies: { 'a:build': [], 'b:build': ['a:build'] },
        continuousDependencies: {},
        tasks: Object.fromEntries(
          ['a', 'b'].map((project) => [
            `${project}:build`,
            {
              id: `${project}:build`,
              target: { project, target: 'build' },
              overrides: {},
              outputs: [],
              hash: `hash-${project}`,
              hashDetails: {
                command: 'build',
                nodes: { shared: 'value'.repeat(100), project },
              },
            },
          ])
        ),
      };
      const binaryWire =
        format === 'binary'
          ? deserializeTaskMessage(
              serializeTaskMessage({ taskGraph: serializeTaskGraph(input) })
            ).taskGraph
          : null;
      const wire =
        binaryWire ??
        JSON.parse(
          JSON.stringify(
            format === 'original' ? input : serializeTaskGraph(input)
          )
        );
      if (format === 'compact') expect(wire).toHaveProperty('entries');
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      const on = vi.spyOn(process, 'on');
      await import('./run-executor');
      const callback = on.mock.calls.find(
        ([event]) => event === 'message'
      )?.[1];
      expect(callback).toBeTypeOf('function');
      try {
        await callback({
          targetDescription: input.tasks['a:build'].target,
          overrides: {},
          taskGraph: wire,
          isVerbose: false,
        });
        const received = vi.mocked(run).mock.calls.at(-1)[5];
        expect(JSON.stringify(received)).toBe(JSON.stringify(input));
        expect(
          Object.getOwnPropertyDescriptor(
            received.tasks['a:build'].hashDetails.nodes,
            'shared'
          )
        ).toEqual({
          value: 'value'.repeat(100),
          writable: true,
          configurable: true,
          enumerable: true,
        });
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        process.removeListener('message', callback);
      }
    }
  );
});
