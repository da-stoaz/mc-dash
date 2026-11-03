# Supplied server-pack baseline: 15 packs

Run: 2026-11-02, 17:36–17:58 Europe/Vienna. Reviewed 2026-11-03. Source revision: `dd9f610f2cde97cf17fdefa9c327dc2834dbf514`.

**6 restart passes; 9 failures (5 preparation failures, 4 first-boot failures).** All six restart passes have nonzero final shutdown exit codes: five 137 and one 143. No captured final container state reports an OOM kill. These are startup/restart passes, not clean shutdown or gameplay certification.

The runner used real ZIP uploads and the production prepare/start/stop HTTP endpoints. Each pass required a fresh ready log message and successful RCON `list` on both boots. There was no prepare/rebuild between the boots. Application code remained unchanged during the baseline.

Environment: Docker Desktop Linux aarch64, 16 GiB Docker memory, sequential pack execution, four CPUs and 6144 MiB container limit per pack, 20-minute operation/boot timeouts. Linux shared memory-pool enforcement disabled. Results do not establish production AMD64 behavior or world durability.

The original target was 100; only these 15 supplied archives were attempted. The user subsequently limited this batch to 15. This is not a random or representative 100-pack sample.

| Pack archive | Startup/restart result | Finding |
| --- | --- | --- |
| DeceasedCraft_Server_Beta_5.10.17.zip | Fail | Preparation rejects the pack: Forge installer is present, but there is no Linux launch script yet. |
| RLCraft Server Pack 1.12.2 - Release v2.9.3.zip | Fail | Preparation rejects the pack: archive contains no supported launcher or installer. |
| All_of_Create_v2.6_serverpack.zip | Pass with shutdown warning | Both boots and RCON checks passed; final shutdown exit 137, not OOM. |
| Biohazard_Beta_0.4.6.1_server_pack.zip | Pass with shutdown warning | Both boots and RCON checks passed; final shutdown exit 137, not OOM. |
| CARPG Dragonfyre V3C Beta Serv.zip | Pass with shutdown warning | Both boots and RCON checks passed; final shutdown exit 137, not OOM. |
| CARPG Ultimate V8E Serv.zip | Fail | False dependency rejection: Simply Swords range [1.19, 1.19.2) is accepted by Forge 43.5.1 compatibility rules. |
| Craft to Exile 2 SERVER-2.1.4.zip | Pass with shutdown warning | Both boots and RCON checks passed; final shutdown exit 137, not OOM. |
| Cursed Walking - 1.20.1 - v3.3(patch) Server Pack.zip | Fail | Runtime detection fails despite forge-auto-install.txt specifying Minecraft 1.20.1 / Forge 47.4.0. |
| From_the_Fog_Reimagined_server_pack.zip | Pass with shutdown warning | Both boots and RCON checks passed; final shutdown exit 143, not OOM. |
| NeoTech-Reborn-Server.zip | Fail | Java 17 selected; bootstrap launcher fails with unsupported class version 65.0 (Java 21). |
| Prominence_II_Hasturian_Era_4.1.6_server_pack.zip | Pass with shutdown warning | Both boots and RCON checks passed; final shutdown exit 137, not OOM. |
| ServerFiles-0.13.0-beta.zip | Fail | ATM11: Java 8 selected; JVM rejects G1PeriodicGCInterval before NeoForge installation. |
| SkyFactory-4_Server_4_2_4.zip | Fail | Start script runs before Forge installation; forge-1.12.2-14.23.5.2860.jar is missing. Java 17 was selected. |
| SkyFactory_5_Server_5.0.8.zip | Fail | Preparation cannot determine runtime for dependency repair; archive includes Install.sh and Forge 1.20.1-47.4.0 installer. |
| VerityCraft-Server-Pack-MC-1.20.1-15.2.0.zip | Fail | Forge rejects Continuity dependencies on connectormod/fabric_api. Launcher exits 0 despite failed Minecraft startup; correctly not counted as ready. |

## Confirmed compatibility-check defect

Forge 43.5.1 maps Minecraft 1.19.2 to compatible Minecraft 1.19.1 ranges (and Forge 42.0.9 / JavaFML 42). MC Dash rejects CARPG Ultimate before its loader can apply this rule. See `VersionSupportMatrix.java` in the [official Forge loader source archive](https://maven.minecraftforge.net/net/minecraftforge/fmlloader/1.19.2-43.5.1/fmlloader-1.19.2-43.5.1-sources.jar). The existing NeoForge 1.21.1-specific alias fix does not cover this case.

## Evidence and limitations

- Raw report, archive SHA-256 hashes, stage timings and final container states: [report.json](../data/corpus-CxBTwV/report.json).
- Backend diagnostics: [backend.log](../data/corpus-CxBTwV/backend.log). Numbered folders in that run directory match the table order and contain container logs.
- The first runner revision saved Docker stdout to container.log; stderr was also emitted to the runner terminal. A supplementary collector captured combined logs for longer-running later cases, but some fast failures have no combined log. The ATM11 JVM error and SkyFactory 4 missing-JAR error above were verified from the completed runner terminal output. The retained runner now captures both streams directly.
- VerityCraft fails inside Forge. Whether its incompatibility originates in the archive or MC Dash preparation needs a controlled follow-up; it is not yet attributed solely to MC Dash.
- The baseline did not separately persist both shutdown exit codes; final shutdown states are retained. The runner now records each stop separately.
- Test ZIPs were not changed. These findings are a baseline; no application fixes were included in this task.

Rerun instructions: [README.md](README.md).
