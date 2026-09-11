import type { Task, TaskGraph } from '../config/task-graph';

/** Internal IPC representation. Executors still receive an ordinary TaskGraph. */
export interface SerializedTaskGraph {
  graph: TaskGraph;
  entries: [string, string][];
  nodeIndices: Record<string, readonly number[] | Uint32Array>;
}

/**
 * Shared input names and values otherwise appear in the JSON message once per
 * task. Large selections can exceed V8's maximum string length before a worker
 * receives its first task. Intern pairs for transport only; hashes and the
 * graph owned by the runner are left unchanged.
 */
export function serializeTaskGraph(
  taskGraph: TaskGraph
): SerializedTaskGraph | TaskGraph {
  const taskIds = Object.keys(taskGraph.tasks);
  // There are no cross-task entries to share in an empty or single-task graph.
  if (
    taskIds.length < 2 ||
    !Object.prototype.propertyIsEnumerable.call(taskGraph, 'tasks') ||
    typeof (taskGraph as any).toJSON === 'function' ||
    typeof (taskGraph.tasks as any).toJSON === 'function'
  )
    return taskGraph;
  const entries: [string, string][] = [];
  const entryLengths: number[] = [];
  const indexLengths: number[] = [];
  // Account for exactly the JSON characters added/removed by the wire format.
  // Serialize each unique pair once for escaping; never stringify the full graph
  // here, since the original representation may already exceed V8's limit.
  let originalContents = 0;
  let encodedContents =
    JSON.stringify({ graph: {}, entries: [], nodeIndices: {} }).length - 2;
  let encodedTasks = 0;
  function addEntry(key: string, value: string): number {
    const id = entries.length;
    const pair: [string, string] = [key, value];
    const length = JSON.stringify(pair).length;
    entries.push(pair);
    entryLengths.push(length);
    indexLengths.push(String(id).length);
    encodedContents += length + (id > 0 ? 1 : 0);
    return id;
  }
  const nodeIndices: Record<string, number[]> = Object.create(null);
  const indices = new Map<
    string,
    { value: string; id: number; alternatives?: Map<string, number> }
  >();
  const tasks: [string, Task][] = [];
  for (const taskId of taskIds) {
    const task = taskGraph.tasks[taskId];
    if (!Object.prototype.propertyIsEnumerable.call(task, 'hashDetails')) {
      tasks.push([taskId, task]);
      continue;
    }
    const details = task.hashDetails;
    // Leave custom detail shapes on the original JSON path.
    if (
      !details?.nodes ||
      !Object.prototype.propertyIsEnumerable.call(details, 'nodes') ||
      typeof details.nodes !== 'object' ||
      Array.isArray(details.nodes) ||
      typeof (task as any).toJSON === 'function' ||
      typeof (details as any).toJSON === 'function' ||
      typeof details.nodes.toJSON === 'function'
    ) {
      tasks.push([taskId, task]);
      continue;
    }
    const nodes: number[] = [];
    let supported = true;
    let originalNodeContents = 0;
    let encodedNodeContents = 0;
    for (const key of Object.keys(details.nodes)) {
      const value = details.nodes[key];
      if (value === undefined) {
        continue; // JSON.stringify also omits undefined object properties.
      }
      if (typeof value !== 'string') {
        supported = false;
        break;
      }
      const entry = indices.get(key);
      let id: number;
      if (!entry) {
        id = addEntry(key, value);
        indices.set(key, { value, id });
      } else if (entry.value === value) {
        id = entry.id;
      } else {
        entry.alternatives ??= new Map();
        id = entry.alternatives.get(value);
        if (id === undefined) {
          id = addEntry(key, value);
          entry.alternatives.set(value, id);
        }
      }
      // ["key","value"] is two characters longer than "key":"value".
      originalNodeContents += entryLengths[id] - 2 + (nodes.length > 0 ? 1 : 0);
      encodedNodeContents += indexLengths[id] + (nodes.length > 0 ? 1 : 0);
      nodes.push(id);
    }
    if (supported) {
      nodeIndices[taskId] = nodes;
      originalContents += originalNodeContents;
      // Task id, colon, brackets and (after the first task) a comma.
      encodedContents +=
        JSON.stringify(taskId).length +
        3 +
        encodedNodeContents +
        (encodedTasks++ > 0 ? 1 : 0);
      // Replacing the value retains the original property order through IPC.
      tasks.push([taskId, { ...task, hashDetails: { ...details, nodes: {} } }]);
    } else {
      tasks.push([taskId, task]);
    }
  }
  // Low-overlap graphs must not become larger or newly hit the string limit.
  if (encodedContents >= originalContents) return taskGraph;
  return {
    graph: { ...taskGraph, tasks: Object.fromEntries(tasks) },
    entries,
    nodeIndices,
  };
}

export function deserializeTaskGraph(
  serialized: SerializedTaskGraph | TaskGraph
): TaskGraph {
  // Keep compatibility with callers which send the original IPC message shape.
  if ('tasks' in serialized) {
    return serialized;
  }
  for (const [taskId, ids] of Object.entries(serialized.nodeIndices)) {
    // Populate without invoking inherited setters, just like JSON.parse. Then
    // restore the normal prototype; every task gets its own mutable object.
    const nodes: Record<string, string> = Object.create(null);
    for (const id of ids) {
      const [key, value] = serialized.entries[id];
      nodes[key] = value;
    }
    Object.setPrototypeOf(nodes, Object.prototype);
    serialized.graph.tasks[taskId].hashDetails.nodes = nodes;
  }
  return serialized.graph;
}
