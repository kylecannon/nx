import { constants } from 'node:buffer';
import type { Task, TaskGraph } from '../config/task-graph';
import {
  deserializeTaskGraph,
  serializeTaskGraph,
} from './task-graph-serialization';

function graph(): TaskGraph {
  const task = (id: string): Task => ({
    id,
    target: { project: id, target: 'build' },
    overrides: { nested: { value: 1 } },
    outputs: [`dist/${id}`],
    cache: true,
    hash: `hash-${id}`,
    hashDetails: {
      command: `command-${id}`,
      nodes: {
        shared: 'same',
        distinct: id,
        repeated: 'common-value'.repeat(40),
      },
      implicitDeps: { config: 'implicit' },
      runtime: { version: 'runtime' },
    },
    startTime: 123,
  });
  return {
    roots: ['a'],
    tasks: { a: task('a'), b: task('b') },
    dependencies: { a: [], b: ['a'] },
    continuousDependencies: { a: [], b: ['a'] },
  };
}

function roundTrip(input: TaskGraph) {
  return deserializeTaskGraph(
    JSON.parse(JSON.stringify(serializeTaskGraph(input)))
  );
}

describe('task graph serialization', () => {
  it('preserves graph fields, hashes, details and JSON property order', () => {
    const input = graph();
    const before = JSON.stringify(input);
    const actual = roundTrip(input);
    expect(JSON.stringify(actual)).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
    const serialized = serializeTaskGraph(input);
    if (!('entries' in serialized)) throw new Error('Expected shared entries');
    expect(serialized.entries).toEqual([
      ['shared', 'same'],
      ['distinct', 'a'],
      ['repeated', 'common-value'.repeat(40)],
      ['distinct', 'b'],
    ]);
  });

  it('preserves ordinary independent objects and writable data properties', () => {
    const actual = roundTrip(graph());
    const first = actual.tasks.a.hashDetails.nodes;
    const second = actual.tasks.b.hashDetails.nodes;
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(first, 'shared')).toEqual({
      value: 'same',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    first.shared = 'changed';
    delete first.distinct;
    expect(second).toEqual({
      shared: 'same',
      distinct: 'b',
      repeated: 'common-value'.repeat(40),
    });
  });

  it('does not invoke inherited setters or lose special keys during reconstruction', () => {
    const input = graph();
    input.tasks.a.hashDetails.nodes = JSON.parse(
      '{"__proto__":"own","constructor":"ctor","1":"integer","東京":"unicode","":"empty","intercepted":"data"}'
    );
    input.tasks.a.hashDetails.nodes.repeated =
      input.tasks.b.hashDetails.nodes.repeated;
    const packet = JSON.parse(JSON.stringify(serializeTaskGraph(input)));
    expect(packet).toHaveProperty('entries');
    const setter = vi.fn();
    Object.defineProperty(Object.prototype, 'intercepted', {
      set: setter,
      configurable: true,
    });
    try {
      const actual = deserializeTaskGraph(packet);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(input));
      expect(Object.hasOwn(actual.tasks.a.hashDetails.nodes, '__proto__')).toBe(
        true
      );
      expect(setter).not.toHaveBeenCalled();
    } finally {
      delete Object.prototype['intercepted'];
    }
  });

  it('retains uncomputed, empty and custom hash details on their original JSON path', () => {
    const input = graph();
    delete input.tasks.a.hash;
    delete input.tasks.a.hashDetails;
    input.tasks.b.hashDetails.nodes = {};
    expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
    for (const details of [
      null,
      { command: 'custom' },
      { nodes: [1, 2] },
      { nodes: { scalar: 123, object: { x: 1 } } },
    ]) {
      input.tasks.b.hashDetails = details as any;
      expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
    }
  });

  it('observes in-place hash changes and matches JSON handling of undefined values', () => {
    const input = graph();
    const first = roundTrip(input);
    input.tasks.a.hashDetails.nodes.shared = 'new';
    input.tasks.a.hashDetails.nodes.omitted = undefined;
    input.tasks.a.hash = 'new-hash';
    const second = roundTrip(input);
    expect(first.tasks.a.hashDetails.nodes.shared).toBe('same');
    expect(JSON.stringify(second)).toBe(JSON.stringify(input));
  });

  it('accepts the previous wire format and empty selections', () => {
    const original = graph();
    expect(deserializeTaskGraph(original)).toBe(original);
    const empty = {
      roots: [],
      tasks: {},
      dependencies: {},
      continuousDependencies: {},
    };
    expect(roundTrip(empty)).toEqual(empty);
  });

  it('does not make non-enumerable hash details visible through IPC', () => {
    const input = graph();
    input.tasks.c = { ...input.tasks.a, id: 'hidden-details' };
    Object.defineProperty(input.tasks.c, 'hashDetails', { enumerable: false });
    input.tasks.d = {
      ...input.tasks.b,
      id: 'hidden-nodes',
      hashDetails: { ...input.tasks.b.hashDetails },
    };
    Object.defineProperty(input.tasks.d.hashDetails, 'nodes', {
      enumerable: false,
    });
    expect(serializeTaskGraph(input)).toHaveProperty('entries');
    expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
  });

  it('preserves uncomputed tasks alongside encoded hash details', () => {
    const input = graph();
    input.tasks.c = { ...input.tasks.a, id: 'uncomputed' };
    delete input.tasks.c.hash;
    delete input.tasks.c.hashDetails;
    expect(serializeTaskGraph(input)).toHaveProperty('entries');
    expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
  });

  it('keeps single-task graphs on their existing JSON path', () => {
    const input = graph();
    delete input.tasks.b;
    expect(serializeTaskGraph(input)).toBe(input);
    expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
  });

  it('honors custom JSON serialization in task hash details', () => {
    for (const location of ['task', 'details', 'nodes']) {
      const input = graph();
      const target =
        location === 'task'
          ? input.tasks.a
          : location === 'details'
            ? input.tasks.a.hashDetails
            : input.tasks.a.hashDetails.nodes;
      Object.defineProperty(target, 'toJSON', {
        value: () => ({ custom: 'serialized' }),
        enumerable: false,
      });
      expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
    }
  });

  it('preserves task ids that overlap with Object.prototype properties', () => {
    const input = graph();
    input.tasks = Object.fromEntries([
      ['__proto__', input.tasks.a],
      ['constructor', input.tasks.b],
    ]);
    expect(JSON.stringify(roundTrip(input))).toBe(JSON.stringify(input));
  });

  it('keeps disjoint details and long task ids on the smaller original path', () => {
    const input = graph();
    input.tasks.a.hashDetails.nodes = { a: 'unique-a' };
    input.tasks.b.hashDetails.nodes = { b: 'unique-b' };
    expect(serializeTaskGraph(input)).toBe(input);
    const prefix = 'very-long-project-id'.repeat(100);
    input.tasks = Object.fromEntries(
      Object.values(input.tasks).map((task, i) => [prefix + i, task])
    );
    expect(serializeTaskGraph(input)).toBe(input);
  });

  it('never grows the JSON payload, including escaped keys and values', () => {
    for (const count of [2, 3, 10, 101]) {
      for (const value of [
        '',
        'x',
        'a'.repeat(100),
        '\"\n\t',
        '東京',
        '\ud800',
      ]) {
        const input = graph();
        input.tasks = Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `project-\"\n-${i}`,
            {
              ...input.tasks.a,
              hashDetails: {
                command: 'build',
                nodes: {
                  ['shared-\"\n']: value,
                  [`unique-${i}`]: value,
                },
              },
            },
          ])
        );
        const before = JSON.stringify(input);
        const after = JSON.stringify(serializeTaskGraph(input));
        expect(after.length).toBeLessThanOrEqual(before.length);
        expect(JSON.stringify(deserializeTaskGraph(JSON.parse(after)))).toBe(
          before
        );
      }
    }
  });

  it('can transport details whose repetition exceeds the JSON string limit', () => {
    const input = graph();
    const value = 'x'.repeat(16 * 1024 * 1024);
    const task = {
      ...input.tasks.a,
      hashDetails: { command: 'build', nodes: { shared: value } },
    };
    input.tasks = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `project-${i}:build`,
        { ...task, id: `project-${i}:build` },
      ])
    );
    // Establish the original payload's lower bound without allocating that string.
    expect(JSON.stringify(task).length * 40).toBeGreaterThan(
      constants.MAX_STRING_LENGTH
    );
    const serialized = JSON.stringify(serializeTaskGraph(input));
    expect(serialized.length).toBeLessThan(constants.MAX_STRING_LENGTH);
    const actual = deserializeTaskGraph(JSON.parse(serialized));
    expect(Object.keys(actual.tasks)).toEqual(Object.keys(input.tasks));
    for (const [id, expected] of Object.entries(input.tasks)) {
      expect(actual.tasks[id]).toEqual(expected);
    }
  });

  it('reduces repeated detail payloads without removing information', () => {
    const input = graph();
    const nodes = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `project-${i}:source/input-${i}.ts`,
        `hash-value-${i}`,
      ])
    );
    input.tasks = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => {
        const task = {
          ...input.tasks.a,
          id: `project-${i}`,
          hashDetails: { command: 'build', nodes: { ...nodes } },
        };
        return [task.id, task];
      })
    );
    const raw = JSON.stringify(input);
    const serialized = JSON.stringify(serializeTaskGraph(input));
    expect(serialized.length).toBeLessThan(raw.length / 5);
    expect(JSON.stringify(deserializeTaskGraph(JSON.parse(serialized)))).toBe(
      raw
    );
  });
});
