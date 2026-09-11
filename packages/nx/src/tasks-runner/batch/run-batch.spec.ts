import { TaskGraph } from '../../config/task-graph';
import { BatchMessageType } from './batch-messages';
import { serializeTaskGraph } from '../task-graph-serialization';

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => ({})) }));
vi.mock('../../command-line/run/executor-utils', () => ({
  parseExecutor: () => ['test-plugin', 'build'],
  getExecutorInformation: () => ({
    schema: {},
    batchImplementationFactory: () => execute,
  }),
}));
vi.mock('../../config/configuration', () => ({ readNxJson: () => ({}) }));
vi.mock('../../utils/params', () => ({
  combineOptionsForExecutor: (options) => options,
}));

describe('batch worker task graph transport', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NX_CLI_SET', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['original', 'compact'])(
    'restores both %s graphs before calling the batch executor',
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
      const projectGraph = {
        nodes: Object.fromEntries(
          ['a', 'b'].map((name) => [
            name,
            {
              name,
              type: 'lib',
              data: {
                root: name,
                targets: { build: { executor: 'test-plugin:build' } },
              },
            },
          ])
        ),
        dependencies: { a: [], b: [] },
      };
      const encode = () =>
        JSON.parse(
          JSON.stringify(
            format === 'original' ? input : serializeTaskGraph(input)
          )
        );
      if (format === 'compact') expect(encode()).toHaveProperty('entries');
      const send = vi.spyOn(process, 'send').mockImplementation(() => true);
      const on = vi.spyOn(process, 'on');
      await import('./run-batch');
      const callback = on.mock.calls.find(
        ([event]) => event === 'message'
      )?.[1];
      expect(callback).toBeTypeOf('function');
      try {
        await callback({
          type: BatchMessageType.RunTasks,
          executorName: 'test-plugin:build',
          projectGraph,
          batchTaskGraph: encode(),
          fullTaskGraph: encode(),
        });
        const [batchGraph, , , context] = vi
          .mocked(execute)
          .mock.calls.at(-1) as any;
        expect(JSON.stringify(batchGraph)).toBe(JSON.stringify(input));
        expect(JSON.stringify(context.taskGraph)).toBe(JSON.stringify(input));
        batchGraph.tasks['a:build'].hashDetails.nodes.shared = 'changed';
        expect(
          context.taskGraph.tasks['a:build'].hashDetails.nodes.shared
        ).toBe('value'.repeat(100));
        expect(send).toHaveBeenCalledWith({
          type: BatchMessageType.CompleteBatchExecution,
          results: {},
        });
      } finally {
        process.removeListener('message', callback);
      }
    }
  );
});
