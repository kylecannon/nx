import type { ChildProcess } from 'child_process';
import { Socket } from 'net';
import { deserialize, serialize } from 'v8';
import {
  consumeMessagesFromSocket,
  isJsonMessage,
  writeMessage,
} from '../utils/consume-messages-from-socket';
import type { TaskGraph } from '../config/task-graph';
import type { SerializedTaskGraph } from './task-graph-serialization';

export const TASK_MESSAGE_FD = 4;

const graphKeys = ['taskGraph', 'batchTaskGraph', 'fullTaskGraph'] as const;
type GraphKey = (typeof graphKeys)[number];
type TaskMessage = Partial<
  Record<GraphKey, TaskGraph | SerializedTaskGraph>
> & {
  [key: string]: unknown;
};

export const TASK_MESSAGE_TYPE = 'NX_TASK_MESSAGE';

export function isTaskMessageEnvelope(
  message: unknown
): message is { type: typeof TASK_MESSAGE_TYPE; payload: Buffer } {
  return (
    message !== null &&
    typeof message === 'object' &&
    'type' in message &&
    message.type === TASK_MESSAGE_TYPE &&
    'payload' in message &&
    Buffer.isBuffer(message.payload)
  );
}

interface BinaryGraph {
  key: GraphKey;
  entries: [string, string][];
  taskIds: string[];
  lengths: Uint32Array;
  indices: Uint32Array;
}

interface BinaryTaskMessage {
  json: string;
  graphs: BinaryGraph[];
}

/**
 * Only the input tables produced by serializeTaskGraph use V8 serialization.
 * JSON still normalizes executor options, custom toJSON values and shared
 * references in the rest of the message. Never use these bytes as a task hash.
 */
export function serializeTaskMessage(message: TaskMessage): Buffer {
  const metadata = { ...message };
  const graphs: BinaryGraph[] = [];
  for (const key of graphKeys) {
    const graph = message[key];
    if (!graph || 'tasks' in graph) continue;
    const taskIds = Object.keys(graph.nodeIndices);
    let count = 0;
    for (const id of taskIds) count += graph.nodeIndices[id].length;
    // Keep the existing JSON path if an index or offset cannot fit in uint32.
    if (count > 0xffffffff || graph.entries.length > 0x100000000) continue;
    const lengths = new Uint32Array(taskIds.length);
    const indices = new Uint32Array(count);
    let offset = 0;
    for (let i = 0; i < taskIds.length; i++) {
      const ids = graph.nodeIndices[taskIds[i]];
      lengths[i] = ids.length;
      indices.set(ids, offset);
      offset += ids.length;
    }
    graphs.push({ key, entries: graph.entries, taskIds, lengths, indices });
    // Retain the wrapper and its property order, including the `graph` key
    // observed by custom JSON conversion inside the task graph.
    metadata[key] = { ...graph, entries: null, nodeIndices: null };
  }
  if (graphs.length === 0) {
    return Buffer.from(JSON.stringify(message));
  }
  return serialize({ json: JSON.stringify(metadata), graphs });
}

export function deserializeTaskMessage(payload: Buffer): TaskMessage {
  if (isJsonMessage(payload)) return JSON.parse(payload.toString('utf8'));
  const { json, graphs }: BinaryTaskMessage = deserialize(payload);
  const message: TaskMessage = JSON.parse(json);
  for (const { key, entries, taskIds, lengths, indices } of graphs) {
    const graph = message[key] as SerializedTaskGraph;
    graph.entries = entries;
    const nodeIndices: SerializedTaskGraph['nodeIndices'] = Object.create(null);
    let offset = 0;
    for (let i = 0; i < taskIds.length; i++) {
      const end = offset + lengths[i];
      nodeIndices[taskIds[i]] = indices.subarray(offset, end);
      offset = end;
    }
    graph.nodeIndices = nodeIndices;
  }
  return message;
}

/** One startup message per worker; ordinary process.send IPC remains JSON. */
export function sendTaskMessage(
  child: ChildProcess,
  message: TaskMessage | Buffer
): void {
  const pipe = child.stdio[TASK_MESSAGE_FD] as Socket;
  if (!pipe) {
    if (Buffer.isBuffer(message)) {
      throw new Error('Task worker binary IPC pipe is unavailable.');
    }
    child.send(message);
    return;
  }
  pipe.on('error', (error) => child.emit('error', error));
  try {
    writeMessage(
      pipe,
      Buffer.isBuffer(message) ? message : serializeTaskMessage(message)
    );
    pipe.end();
  } catch (error) {
    pipe.destroy();
    throw error;
  }
}

/** Register after the worker's existing message handler. */
export function receiveTaskMessage(): void {
  const fd = process.env.NX_TASK_MESSAGE_FD;
  delete process.env.NX_TASK_MESSAGE_FD;
  // Older callers can continue to send the original message through Node IPC.
  if (fd === undefined || fd === '') return;
  const pipe = new Socket({ fd: Number(fd), readable: true, writable: false });
  let received = false;
  const pending: unknown[][] = [];
  const originalEmit = process.emit;
  let waiting = true;
  // The ordinary IPC channel can overtake the large startup frame. Defer its
  // message events until startup has been delivered, including any listeners
  // installed by preloads. Restore dispatch before invoking executor code.
  const deferredEmit = function (
    this: NodeJS.Process,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (waiting && event === 'message') {
      pending.push(args);
      return this.listenerCount('message') > 0;
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  } as typeof process.emit;
  process.emit = deferredEmit;
  const restoreDispatch = () => {
    waiting = false;
    if (process.emit === deferredEmit) process.emit = originalEmit;
  };
  const fail = (error: Error) => {
    restoreDispatch();
    pending.length = 0;
    pipe.destroy();
    console.error(error);
    process.exit(1);
  };
  pipe.on(
    'data',
    consumeMessagesFromSocket((payload) => {
      if (received) return;
      try {
        const message = deserializeTaskMessage(payload);
        received = true;
        pipe.destroy();
        restoreDispatch();
        process.emit('message', message, undefined);
        for (const args of pending) {
          Reflect.apply(process.emit, process, ['message', ...args]);
        }
        pending.length = 0;
      } catch (error) {
        fail(error);
      }
    }, fail)
  );
  pipe.on('error', fail);
  pipe.on('end', () => {
    if (!received) {
      fail(
        new Error('Task worker IPC ended before receiving the startup message.')
      );
    }
  });
}
