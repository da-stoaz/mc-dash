# Real server-pack compatibility tests

From `backend/`, with Node 22+ and Docker running:

```sh
npm run build
node scripts/pack-corpus.mjs /path/to/server-pack-zips 100
```

This runs the built backend in a new, isolated `backend/data/corpus-*` directory,
with its own database and loopback HTTP port. It does not contact a production
backend. It creates one Minecraft container at a time, with four CPUs and a
6 GiB memory setting. Existing containers are left alone. Allow additional
memory for Docker, the host, and any existing workloads.

Each completed ZIP is hashed and uploaded through the real API. The test prepares
the pack, starts it, requires a fresh server-ready log message and a successful
RCON command, stops it, then starts and checks it again **without preparing or
rebuilding**. Both stops must leave the container stopped. A successful prepare
or Docker start is not a pass.

The runner rechecks the input directory between packs; unfinished `.part`
downloads are ignored. The count is a maximum, not an assertion that that many
packs exist. The run ends when no more completed ZIPs are available. Supply
distinct packs to measure distinct-pack compatibility: different versions of
one project are separate ZIPs, not independent projects.

`report.json` records the source revision, working-tree state, Docker architecture,
archive hashes, stage outcomes, runtime image and final container state. Numbered
directories contain container logs; `backend.log` contains preparation and API
errors. Test containers and server data are removed after logs are captured.
Input ZIPs are never changed. On a lifecycle-operation timeout the entire batch
stops, leaving the isolated data available for diagnosis.

Settings:

```sh
CORPUS_RAM_MB=8192 CORPUS_TIMEOUT_MINUTES=30 \
  node scripts/pack-corpus.mjs /path/to/server-pack-zips 100
```

The default timeout is 20 minutes per operation or boot. The runner stops before
another pack if less than 20 GiB is free. Downloads performed by the packs require
network access. A nonzero exit means a failed case, interrupted run or batch error;
inspect the report for the actual denominator.

Interpret failures individually: missing launchers, dependency rejection, JVM
errors, unavailable upstream downloads, ARM-native incompatibility, memory limits
and timeouts are different findings. Local Docker Desktop tests disable the Linux
shared memory pool; they do not validate production cgroup enforcement. A pass
validates startup/restart, not gameplay or every mod interaction.
