const { parentPort, workerData } = require('node:worker_threads');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const tar = require('tar');

async function run() {
  const { root, entries, archivePath } = workerData;
  const archive = tar.create({ gzip: { level: 1 }, cwd: root, portable: true }, entries);
  const output = createWriteStream(archivePath);
  const timer = setInterval(() => parentPort.postMessage({ bytes: output.bytesWritten }), 250);
  try {
    await pipeline(archive, output);
    parentPort.postMessage({ bytes: output.bytesWritten, done: true });
  } finally {
    clearInterval(timer);
  }
}

run().catch(error => {
  parentPort.postMessage({ error: error.message, code: error.code, path: error.path });
  process.exitCode = 1;
});
