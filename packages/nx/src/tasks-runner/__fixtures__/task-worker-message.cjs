const { transformFileSync } = require('@swc/core');

// Run the production TS transport in a real child process without depending on
// potentially stale dist files. The regular executor IPC channel remains JSON.
require.extensions['.ts'] = (mod, filename) => {
  mod._compile(
    transformFileSync(filename, {
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'commonjs' },
    }).code,
    filename
  );
};
const { receiveTaskMessage } = require('../task-worker-message.ts');
const { deserializeTaskGraph } = require('../task-graph-serialization.ts');
const originalEmit = process.emit;
process.on('message', (message) => {
  if (message.control) {
    process.send({
      value: message.value,
      ignored() {},
      convertedReply: { toJSON: () => 'json-reply' },
    });
  } else {
    process.send({
      taskGraph: deserializeTaskGraph(message.taskGraph),
      hasPrivateFdEnv: Object.hasOwn(process.env, 'NX_TASK_MESSAGE_FD'),
      restoredDispatch: process.emit === originalEmit,
    });
  }
});
receiveTaskMessage();
if (process.argv[2] === 'queued') {
  process.emit('message', { control: true, value: 'queued-1' });
  process.emit('message', { control: true, value: 'queued-2' });
}
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
