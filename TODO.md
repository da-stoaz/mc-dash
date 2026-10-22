- [ ] Deferred: harden and isolate the public Minecraft router; audit port exposure and upstream DDoS protection. See [findings and proposed work](docs/router-security.md). Finish player-count/settings work first.

- [x] Implement setting to configure entity-broadcast-range-percentage (default 100%).

- [x] Add a TPS chart using spark tps with forge tps fallback.
  Samples every 10 seconds on the overview, with up to 10 minutes of in-memory history.
  spark healthreport and spark profiler start remain manual diagnostics in the console.


check how it is possible to have only an .env.example but not an .env in root dir of hosted server: 

ls -la
total 5757924
drwxrwxr-x  5 stoaz stoaz       4096 Oct 18 14:17 .
drwx------ 29 stoaz stoaz       4096 Oct 19 14:40 ..
-rw-rw-r--  1 stoaz stoaz       8501 Oct 18 14:04 .env.example
drwxrwxr-x  8 stoaz stoaz       4096 Oct 19 14:47 .git
-rw-rw-r--  1 stoaz stoaz        349 Jun 30 16:56 .gitignore
-rw-rw-r--  1 stoaz stoaz       8977 Aug 22 16:52 DEPLOY.md
-rw-rw-r--  1 stoaz stoaz      18750 Oct 18 14:17 README.md
drwxrwxr-x  6 stoaz stoaz       4096 Oct 18 17:39 backend
-rw-rw-r--  1 stoaz stoaz       3058 Oct 18 14:04 docker-compose.yml
drwxrwxr-x  6 stoaz stoaz       4096 Oct 18 17:41 frontend
-rw-r--r--  1 stoaz stoaz 5896035428 Jul  5 17:23 mc-backup-20260705-172125.tar.gz


and only envs in frontend and backend dirs: 

ls -la
total 464
drwxrwxr-x   6 stoaz stoaz   4096 Oct 18 17:41 .
drwxrwxr-x   5 stoaz stoaz   4096 Oct 18 14:17 ..
-rw-rw-r--   1 stoaz stoaz     82 Jun 17 16:03 .dockerignore
-rw-rw-r--   1 stoaz stoaz     30 Oct 18 14:03 .env.local
drwxrwxr-x   7 stoaz stoaz   4096 Oct 19 14:33 .next
-rw-rw-r--   1 stoaz stoaz    897 Jun 17 16:03 Dockerfile
-rw-rw-r--   1 stoaz stoaz    608 Jun 17 16:03 eslint.config.mjs
-rw-rw-r--   1 stoaz stoaz    288 Aug 16 13:29 next-env.d.ts
-rw-rw-r--   1 stoaz stoaz    252 Oct 18 17:41 next.config.ts
drwxrwxr-x 333 stoaz stoaz  20480 Oct 19 14:32 node_modules
-rw-rw-r--   1 stoaz stoaz 390223 Oct 18 14:17 package-lock.json
-rw-rw-r--   1 stoaz stoaz    930 Oct 18 14:17 package.json
-rw-rw-r--   1 stoaz stoaz     94 Dec 22  2025 postcss.config.js
drwxrwxr-x   2 stoaz stoaz   4096 Aug 16 15:06 public
drwxrwxr-x   5 stoaz stoaz   4096 Jun 17 16:03 src
-rw-rw-r--   1 stoaz stoaz    494 Dec 22  2025 tailwind.config.js
-rw-rw-r--   1 stoaz stoaz    748 Jun 30 16:56 tsconfig.json

ls -la
total 168
drwxrwxr-x   6 stoaz stoaz   4096 Oct 18 17:39 .
drwxrwxr-x   5 stoaz stoaz   4096 Oct 18 14:17 ..
-rw-rw-r--   1 stoaz stoaz     65 Jun 17 16:03 .dockerignore
-rw-rw-r--   1 stoaz stoaz   1530 Oct 18 17:39 .env
-rw-rw-r--   1 stoaz stoaz   2660 Oct 18 14:04 .env.example
-rw-rw-r--   1 stoaz stoaz    803 Jun 17 16:03 Dockerfile
drwxr-xr-x   4 stoaz stoaz   4096 Dec 22  2025 data
drwxrwxr-x   4 stoaz stoaz   4096 Aug 22 22:37 dist
drwxrwxr-x 217 stoaz stoaz  16384 Oct 19 14:47 node_modules
-rw-rw-r--   1 stoaz stoaz 108143 Oct 18 14:17 package-lock.json
-rw-rw-r--   1 stoaz stoaz   1085 Oct 18 14:17 package.json
drwxrwxr-x   4 stoaz stoaz   4096 Oct 19 14:47 src
-rw-rw-r--   1 stoaz stoaz    417 Dec 22  2025 tsconfig.json
