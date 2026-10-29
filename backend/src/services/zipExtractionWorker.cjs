// ZIP parsing and decompression are synchronous in adm-zip. Keep them off the
// API event loop so job-status requests and the Minecraft router remain usable.
const { workerData } = require('node:worker_threads');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { zipPath, packDir } = workerData;
const zip = new AdmZip(zipPath);
for (const entry of zip.getEntries()) {
  const relative = path.relative(path.resolve(packDir), path.resolve(packDir, entry.entryName));
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) ||
      ((entry.header.attr >>> 16) & 0o170000) === 0o120000) {
    throw new Error(`Unsafe archive entry: ${entry.entryName}`);
  }
}
zip.extractAllTo(packDir, true);
