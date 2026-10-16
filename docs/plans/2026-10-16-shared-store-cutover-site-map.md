The relay borrowing branch and persistence tiers already exist. The remaining work is daemon ownership, replacing seven daemon file-opening paths, and preserving project availability and visibility.

Read-only audit of `wt/82tn6-3` at `d91f772b`. No files or Beads state changed; no tests or builds run. Changes proposed below are inferences from the inspected code.

1\. Site table

| Target | File:line | What it does today | What must change |
|---|---|---|---|
| 1 | [daemon-layers.ts:654](../../src/lib/domain/daemon/Layers/daemon-layers.ts:654) | Startup chains config migration → project-storage migration → fork-lineage migration. The daemon-store importer is absent from this chain. | Establish the ordered preparation/import/store-acquisition barrier here, before downstream readers, servers and background work. Move lineage after import. |
| 1 | [live.ts:90](../../src/lib/persistence/effect/live.ts:90), [persistence-service.ts:95](../../src/lib/domain/persistence/Services/persistence-service.ts:95), [projection-runner-effect.ts:330](../../src/lib/persistence/effect/projection-runner-effect.ts:330) | Store construction migrates through a temporary connection, reclaims, opens the persistent connection, and prepares it. Constructing the runner does **not** run recovery. | Prepare an existing daemon database through short-lived scopes: migrate, recover, close, reclaim. Finish these scopes before import; acquire the long-lived store afterwards. Never bind a project or stamp during daemon-store preparation. |
| 1 | [rewrite-store.ts:41](../../src/lib/persistence/rewrite-store.ts:41), [rewrite-store.ts:154](../../src/lib/persistence/rewrite-store.ts:154) | Rewrite/reclaim opens a source, verifies a temporary copy, then replaces the file. SQLite openings are at lines 64, 85 and 175. | Keep entirely within offline preparation. No persistent event-store handle may survive replacement. |
| 1 | [daemon-store-import.ts:1468](../../src/lib/persistence/migrations/daemon-store-import.ts:1468) | Processes only supplied `{projectId, sourcePath}` entries. Seeds from the largest source when the destination is absent, isolates project failures, finishes backups and writes the report. | Call once during daemon startup with registered **and retained** sources. Preserve the absent-destination seed path. Consume its results before allowing project activity. |
| 1 | [daemon-store-import.ts:477](../../src/lib/persistence/migrations/daemon-store-import.ts:477) | Importer-owned `node:sqlite` handles occur at lines **477, 557, 872, 1074, 1084, 1138, 1202, 1279, 1359**: seed copy, shared-session exclusion, destination import, source/copy checks, marker/backup/scratch checks. Copy normalization uses the Effect persistence layer at line 1125. | Preserve these bounded importer lifetimes. They must finish before the daemon store tier opens. |
| 1 | [daemon-foreground.ts:470](../../src/lib/domain/daemon/Layers/daemon-foreground.ts:470), [daemon-foreground.ts:496](../../src/lib/domain/daemon/Layers/daemon-foreground.ts:496) | Builds `makeDaemonLive`, then probes registered projects and starts relays when runners or recovery candidates exist. | The built runtime must already contain imported-store availability, shared SQL and `PersistenceStore`. Recovery must respect import blocks. |
| 1, 6 | [project-storage-migration.ts:19](../../src/lib/persistence/migrations/project-storage-migration.ts:19) | Before relays, copies registered projects’ legacy `.conduit/events.db` files into project storage using `rewriteStore`; archives originals. Iterates only `config.projects`. | Keep any retained source-layout migration fully before import. Legacy paths must become import inputs rather than runtime fallbacks. |
| 2 | [live.ts](../../src/lib/persistence/effect/live.ts) | `PersistenceStore` carries the borrowed store context. Project tiers construct scoped services without opening/migrating/stamping and reuse the store's projection runner. | Done: the daemon owns the store context; project tiers borrow its lifetime. |
| 2 | [relay-factory-layer.ts:170](../../src/lib/domain/daemon/Layers/relay-factory-layer.ts:170), [relay-factory-layer.ts:480](../../src/lib/domain/daemon/Layers/relay-factory-layer.ts:480) | Factory captures daemon services, but supplies no `PersistenceStore`. Computes a per-project path at line 421 and passes it at line 521. | Require/capture the daemon store and forward its tag in `daemonConfigContext`. Use the daemon path for runtime configuration. Keep writing storage ownership metadata at lines 425–430. |
| 2 | [project-relay-layers.ts:480](../../src/lib/relay/project-relay-layers.ts:480) | Borrows `PersistenceStore` when present; otherwise opens `config.persistenceDbPath` through the per-file composition. | Production daemon relays must always take the borrowing branch. Preserve explicitly standalone fixtures separately. |
| 2 | [live.ts:290](../../src/lib/persistence/effect/live.ts:290), [persistence-service.ts:179](../../src/lib/domain/persistence/Services/persistence-service.ts:179) | Both per-file compositions stamp provenance. `makePersistenceServiceLive` also prepares the schema. | Remove these compositions from daemon live/read paths. Keep stamping for importer private copies. |
| 3 | [daemon-session-reader.ts:65](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:65) | `readProjectSessions` resolves the file at line 86, opens SQLite at 103 and supplies the migrating/stamping service at 108. Called once per selected project by `listDaemonSessions` at 303. | Borrow shared SQL/read queries; retain project scope, pagination, decoration and folder-availability behavior. Remove file-existence checks and preparation. |
| 3 | [daemon-session-reader.ts:142](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:142) | `hasProviderRecoveryCandidate` opens a read-only project connection at 159. SQL already filters project ownership and provider IDs. Called during foreground recovery at line 503. | Execute the scoped query on shared SQL; remove path/open/config-directory dependencies. |
| 3 | [daemon-session-reader.ts:184](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:184) | `countRunningProjectSessions` opens read-only at 200. Counts project sessions and send-command outbox rows. | Borrow shared SQL. Its caller is [project-registry-service.ts:1042](../../src/lib/domain/daemon/Services/project-registry-service.ts:1042), during main-folder changes; replace the preceding per-project migration-path guard at line 1033 with import availability. |
| 3 | [daemon-session-reader.ts:218](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:218) | `hasColdAutoSettleCandidate` opens read-only at 238. Called for uncached projects by [auto-settle-layer.ts:64](../../src/lib/domain/daemon/Layers/auto-settle-layer.ts:64), initially and every minute at 98. | Borrow shared SQL; preserve the existing project-scoped facts query and skip blocked projects. |
| 3 | [daemon-session-reader.ts:386](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:386) | `resolveDaemonOpenCodeSession` scans registered project files, opening at 420 and migrating/stamping at 418. Called by `OpenCodeUseWorktree` at [daemon-ws-rpc-layer.ts:784](../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.ts:784). | Reuse shared SQL with registered-project scope. Preserve provider-binding ambiguity handling; remove preparation and file scans. |
| 3 | [worktree-cleanup-reader.ts:18](../../src/lib/domain/daemon/Services/worktree-cleanup-reader.ts:18) | Resolves a project file at 26 and opens read-only at 78. Event candidates already filter project ownership at 56. | Borrow shared SQL; retain filesystem checks on candidate worktrees. Caller: [worktree-cleanup-layer.ts:85](../../src/lib/domain/daemon/Layers/worktree-cleanup-layer.ts:85); startup/hourly enqueue is at 196. |
| 3 | [daemon-ws-rpc-layer.ts:114](../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.ts:114), [relay-factory-layer.ts:208](../../src/lib/domain/daemon/Layers/relay-factory-layer.ts:208) | RPC handlers and the relay’s daemon-session-query adapter explicitly capture/provide restricted contexts. | Add shared SQL/read services to requirements **and captured contexts**, including the RPC `run` union at line 190 and factory query adapter at 222. Background layers receive them through [daemon-layers.ts:870](../../src/lib/domain/daemon/Layers/daemon-layers.ts:870). |
| 4 | [session-directory.ts](../../src/lib/domain/daemon/Services/session-directory.ts) | The shared directory reads `SELECT project_id FROM sessions WHERE id = ?` and checks current registration. Session IDs are primary keys. | Done: the per-file index and ambiguous-owner error have been removed. |
| 4 | [daemon-layers.ts](../../src/lib/domain/daemon/Layers/daemon-layers.ts), [project-relay-layers.ts](../../src/lib/relay/project-relay-layers.ts) | Daemon relays borrow the shared directory. Standalone WebSocket routing queries its own store and accepts only its own slug. | Done: neither composition uses an in-memory ownership index. |
| 4 | [project-registry-service.ts](../../src/lib/domain/daemon/Services/project-registry-service.ts), [commit-and-signal.ts](../../src/lib/persistence/effect/commit-and-signal.ts) | Ownership and visibility follow committed session rows and current registry membership at lookup time. | Done: registration, commit, recovery and removal bookkeeping hooks have been deleted. |
| 4 | [session-directory.ts](../../src/lib/domain/daemon/Services/session-directory.ts), [server/ws-rpc.ts](../../src/lib/server/ws-rpc.ts), [daemon-ws-rpc-layer.ts](../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.ts) | SQL failures use `SessionDirectoryReadError`; unknown sessions resolve to none. | Done: routing no longer maps directory failures to ambiguous ownership. |
| 5 | [fork-lineage-import.ts:45](../../src/lib/persistence/migrations/fork-lineage-import.ts:45) | Reads `fork-metadata.json` and unresolved archive at 49–50; discovers configured/recent projects at 88–105; opens each project store at 124–126. Reads sessions, parent links and message boundaries, then updates lineage, timestamps, versions and sidebar at 136–205. | Run after import against borrowed daemon SQL. Resolve stored ownership and apply project-scoped updates; preserve cross-project parent links created by first-owner import rules. Preserve unresolved archive retry and durability behavior at 217–298. |
| 6 | [daemon-store-import.ts:1467](../../src/lib/persistence/migrations/daemon-store-import.ts:1467), [project-storage.ts:6](../../src/lib/persistence/project-storage.ts:6) | Importer has no discovery; processes only supplied sources. Retained stores live under `projects/<slug>`. | Supply a deduplicated inventory including inactive storage directories, with legacy fallback sources where their folders are known. Keep `projectEventsDbPath` as a legacy/import resolver rather than globally redirecting it. |
| 6 | [project-registry-service.ts:543](../../src/lib/domain/daemon/Services/project-registry-service.ts:543), [daemon-ws-rpc-layer.ts:565](../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.ts:565), [recent-projects.ts:5](../../src/lib/daemon/recent-projects.ts:5) | Removal drops registry membership, stops relay/runners and clears directory membership, retaining storage. RPC removal records folders in `recent.json` best-effort; recent history is capped at 20. Other removal entrypoints omit that recent write. | Discover retained stores from disk, not only recent history. Keep imported inactive sessions outside current-project list/resolve scopes. |
| 6 | [project-storage.ts:12](../../src/lib/persistence/project-storage.ts:12), [project-storage.ts:45](../../src/lib/persistence/project-storage.ts:45) | `project.json` records `mainFolder`. Slug choice reuses an inactive same-owner slug and reserves live, foreign-owned and unreadable-owner directories. Ownership is written when a relay starts, at factory line 426. | Preserve directories and ownership records after importing/archiving their databases. Re-add must recover the same project ID; registration must not depend on a relay opening a database to establish needed reservations. |
| 7 | [project-registry-service.ts:92](../../src/lib/domain/daemon/Services/project-registry-service.ts:92), [project-registry-service.ts:330](../../src/lib/domain/daemon/Services/project-registry-service.ts:330), [ws-rpc.ts:252](../../src/lib/contracts/ws-rpc.ts:252) | Registry has `Error.error`, but `projectInfos` discards it. `ProjectInfoSchema` has `missing`, **no availability/reason**. The similarly named fields at line 286 describe provider instances. | Add project availability/reason and preserve import failures independently of ordinary retryable relay errors. Recompute on restart from importer results. |
| 7 | [daemon-layers.ts:387](../../src/lib/domain/daemon/Layers/daemon-layers.ts:387), [relay-cache.ts:183](../../src/lib/domain/daemon/Services/relay-cache.ts:183), [project-registry-service.ts:689](../../src/lib/domain/daemon/Services/project-registry-service.ts:689) | Cache factory checks registration, not import availability. Failed construction removes the cache entry; `startRelay` resets Error to Registering. WS loading directly calls `cache.get` at routing line 159; foreground recovery does likewise. | Enforce the import block at the common factory/cache acquisition boundary. Browser requests, recovery, background work and relay replacement must all encounter it. |
| 7 | [daemon-ws-rpc-layer.ts:170](../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.ts:170), [project.svelte.ts:90](../../src/lib/frontend/stores/project.svelte.ts:90), [ProjectScopeItem.svelte:101](../../src/lib/frontend/components/session/ProjectScopeItem.svelte:101) | Registry errors emit `InstanceStatusChanged`, refreshing instances rather than project lists. Browser conversion copies selected project fields and displays no failure reason. | Carry availability through Get/SubscribeProjects, conversion and display; publish project-list updates. HTTP already exposes registry status/error at [http-router-layer.ts:195](../../src/lib/domain/server/Layers/http-router-layer.ts:195), but browser project lists use RPC. |
| 7 | [ws-rpc.ts:603](../../src/lib/contracts/ws-rpc.ts:603), [daemon-session-reader.ts:314](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:314), [session.svelte.ts:670](../../src/lib/frontend/stores/session.svelte.ts:670) | Session lists separately report per-project availability/errors; frontend retains unavailable slugs and drops reasons. | Reflect import failures in this response too, rather than returning an empty healthy history. Preserve reasons where displayed. |
| 8 | [process-harness.ts:475](../../test/helpers/process-harness.ts:475) | Always returns `projects/<slug>/events.db`. | Return `<configDir>/events.db`. Legacy importer sources need an explicit separate path. |

The CLI and PTY host do not need event-store ownership added. CLI commands already use socket RPC through [cli-core.ts:78](../../src/bin/cli-core.ts:78), with command calls at `cli-command-handlers.ts:122,205,235,272`. The PTY entrypoint calls its independent host at [pty-host.ts:25](../../src/bin/pty-host.ts:25); host lifetime/socket storage begins at [terminal/pty-host.ts:55](../../src/lib/terminal/pty-host.ts:55).

The foreground daemon’s other SQLite handle is the separate `server.lock.sqlite` lease at [daemon-foreground.ts:426](../../src/lib/domain/daemon/Layers/daemon-foreground.ts:426). Offline compaction verification intentionally owns isolated files at [verify-event-compaction.ts:258](../../scripts/verify-event-compaction.ts:258).

2\. Tests and specs

There are **55 files consuming `projectStorePath`**. Five require semantic rewrites beyond changing the helper:

| Test/spec | Assumption that breaks |
|---|---|
| [harness-session-routing.spec.ts:152](../../test/e2e/specs/harness-session-routing.spec.ts:152) | Selecting different files proves project isolation. Shared storage requires project-scoped assertions; querying B’s session through either filename otherwise returns the same row. |
| [harness-daemon-store-import.spec.ts:98](../../test/e2e/specs/harness-daemon-store-import.spec.ts:98) | Creates two histories through the current daemon, then explicitly imports their files and expects seeded/imported outcomes. Obtain separate legacy fixtures; exercise import through startup. Source disappearance checks are at 169. Add restart/no-recreation evidence. |
| [harness-pick-guard.spec.ts:146](../../test/e2e/specs/harness-pick-guard.spec.ts:146) | Counts all sessions at 159 and reads/counts all turns at 3582/5353. Resets the store-wide backfill singleton at **3224, 3397, 3591, 5362**. Scope project assertions and make singleton resets deliberate. |
| [project-provenance.test.ts:31](../../test/integration/daemon/project-provenance.test.ts:31) | Reads complete tables and expects every row to belong to one slug at 234. Separately downgrades project files at 300 and compares whole-file copies at 325. Preserve separate legacy sources, then compare scoped imported histories. |
| [serve-foreground.test.ts:340](../../test/integration/daemon/serve-foreground.test.ts:340) | Corrupts one project’s database while expecting another project to work. Similar setup at 1373. Use project-import/recovery failure scenarios for isolation; global database corruption is a different failure. Fatal-startup corruption at 1214 can target the daemon file. |

Additional direct layout assumptions:

| File:line | Required adjustment |
|---|---|
| [worktree-cleanup.test.ts:549](../../test/integration/daemon/worktree-cleanup.test.ts:549) | Directly opens the project path to insert outbox handoff state. |
| [multi-folder-git.test.ts:369](../../test/integration/daemon/multi-folder-git.test.ts:369) | Directly reads project-file session/sidebar/Git versions. |
| [daemon-rpc-routing.test.ts:45](../../test/integration/daemon/daemon-rpc-routing.test.ts:45) | Seeds two files, with session inserts omitting `project_id`. Seed one shared store with explicit ownership. |
| [project-storage-migration.test.ts:33](../../test/integration/daemon/project-storage-migration.test.ts:33) | Treats the project path as runtime destination. Destination assertions/reads at 150, 172, 174, 234, 261, 306, 328 need updating; legacy fallback at 227 needs replacement by import/block behavior. |
| [shared-store-scope.test.ts:634](../../test/integration/persistence/shared-store-scope.test.ts:634) | Symlinks shared storage into project paths for cold readers; repeats at 840. Remove that compatibility setup and provide shared SQL. |
| [harness-project-edit.spec.ts:228](../../test/e2e/specs/harness-project-edit.spec.ts:228) | Checks storage-directory existence, not daemon-file ownership or absence of recreated project databases. Strengthen the cutover assertion. |
| [harness-store-contention.spec.ts:143](../../test/e2e/specs/harness-store-contention.spec.ts:143) | Records either storage layout as acceptable. Require shared storage. |
| [daemon-session-reader.test.ts:115](../../test/unit/daemon/daemon-session-reader.test.ts:115) | Per-file fixtures omit project IDs. Independent corrupt-file scenarios at 677/1154 need intentional import/error fixtures. |
| [worktree-cleanup-reader.test.ts:22](../../test/unit/daemon/worktree-cleanup-reader.test.ts:22), [auto-settle-layer.test.ts:195](../../test/unit/daemon/auto-settle-layer.test.ts:195) | Cold-reader fixtures need shared SQL instead of per-project destinations. |
| [session-rows.test.ts:70](../../test/unit/relay/session-rows.test.ts:70) | Reader-parity fixture includes daemon reads; update its daemon context/destination. |
| [fork-lineage-migration.test.ts:34](../../test/unit/persistence/fork-lineage-migration.test.ts:34) | Directly invokes lineage over project files created at 107, 275, 315, 367, 435. Run against shared imported fixtures; retain archive/durability cases. |
| [daemon-shared-store-startup.test.ts](../../test/integration/persistence/daemon-shared-store-startup.test.ts) | Shared-adapter coverage verifies live ownership, unknown sessions and registry visibility. Obsolete per-file index and bookkeeping tests have been removed. |

The remaining **50 helper consumers** principally need the runtime-path change. These are operative anchors, one per file:

```text
test/e2e/provider/claude-runner-real-sdk.test.ts:127
test/e2e/specs/harness-create-latency.spec.ts:180
test/e2e/specs/harness-deep-rewind.spec.ts:91
test/e2e/specs/harness-page-budget.spec.ts:183
test/e2e/specs/harness-recreated-message-resume.spec.ts:194
test/e2e/specs/harness-restart-load.spec.ts:390
test/e2e/specs/harness-resume-checksum.spec.ts:202
test/e2e/specs/harness-rewind-resume.spec.ts:157
test/e2e/specs/harness-session-cache.spec.ts:214
test/e2e/specs/harness-tool-previews.spec.ts:414
test/e2e/specs/harness-transcript-performance.spec.ts:190
test/integration/daemon/account-folder-changes.integration.ts:61
test/integration/daemon/claude-launch-folder.test.ts:94
test/integration/daemon/claude-prewarm.test.ts:25
test/integration/daemon/claude-process-runner-lifecycle.test.ts:40
test/integration/daemon/claude-process-runner.test.ts:15
test/integration/daemon/claude-queue-restart.test.ts:10
test/integration/daemon/claude-runner-restart.test.ts:28
test/integration/daemon/claude-runner-upgrade.test.ts:40
test/integration/daemon/claude-session-rewind.test.ts:106
test/integration/daemon/claude-session-workspace-hint.test.ts:49
test/integration/daemon/claude-session-workspace.test.ts:64
test/integration/daemon/claude-steer-recovery.test.ts:21
test/integration/daemon/claude-turn-retry.test.ts:75
test/integration/daemon/claude-turn-status-restart.test.ts:35
test/integration/daemon/cursor-driver-unavailable.test.ts:23
test/integration/daemon/draft-session-worktree.test.ts:152
test/integration/daemon/multi-folder-worktree-missing.test.ts:215
test/integration/daemon/multi-folder-worktree.test.ts:458
test/integration/daemon/new-session-worktree.test.ts:184
test/integration/daemon/opencode-connection-health.test.ts:181
test/integration/daemon/opencode-idle-stop.test.ts:72
test/integration/daemon/opencode-instances-use.test.ts:208
test/integration/daemon/opencode-reconcile.test.ts:55
test/integration/daemon/opencode-stale-status-read.test.ts:11
test/integration/daemon/opencode-startup-quiet.test.ts:78
test/integration/daemon/opencode-unanswered-turn.test.ts:11
test/integration/daemon/opencode-worktree.test.ts:64
test/integration/daemon/project-extra-folders.test.ts:222
test/integration/daemon/project-save.test.ts:47
test/integration/daemon/project-setup-script.test.ts:78
test/integration/daemon/session-workspace-fork.test.ts:51
test/integration/daemon/session-workspace-isolated-missing.test.ts:58
test/integration/daemon/session-workspace-missing.test.ts:53
test/integration/daemon/session-workspace.test.ts:63
test/integration/daemon/session-worktree-settlement.test.ts:87
test/integration/daemon/turn-timeline.test.ts:76
test/integration/daemon/worktree-branch-rename.test.ts:217
test/integration/daemon/worktree-cleanup.test.ts:734
test/integration/daemon/worktree-session-deletion.test.ts:245
```

Two qualifications apply:

- Retarget DB/WAL/SHM backup-and-restore sets together in [harness-session-cache.spec.ts:748](../../test/e2e/specs/harness-session-cache.spec.ts:748) and [harness-resume-checksum.spec.ts:491](../../test/e2e/specs/harness-resume-checksum.spec.ts:491).
- Preserve genuinely independent importer/standalone files: [daemon-store-import-manifest.ts:663](../../test/helpers/daemon-store-import-manifest.ts:663), [daemon-store-import-failures.test.ts:176](../../test/integration/persistence/daemon-store-import-failures.test.ts:176), [relay-stack-opencode-runtime-ingress-wiring.test.ts:307](../../test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts:307), and the standalone cases at [claude-steer-recovery.test.ts:361](../../test/integration/daemon/claude-steer-recovery.test.ts:361). Generic persistence/relay helpers also intentionally accept independent filenames at `persistence-factories.ts:300`, `effect-projection-harness.ts:57`, `temp-events-db.ts:6`, `relay-harness.ts:58`, and `e2e-harness.ts:93,246`.

3\. Ordering and lifetime hazards

- **Import must have an exclusive lifetime boundary.** The importer uses `node:sqlite`; the runtime driver uses `better-sqlite3`, explicitly contrasted in [daemon-store-import.ts:875](../../src/lib/persistence/migrations/daemon-store-import.ts:875). Its offline precondition is at line 1156. Reclaim and seed can replace an inode at [rewrite-store.ts:121](../../src/lib/persistence/rewrite-store.ts:121) and importer line 521. Inference: merely avoiding simultaneous writes is insufficient; release every destination handle before import.
- **Do not create an empty destination during “prepare existing.”** The importer chooses its seed only when the destination is absent at [daemon-store-import.ts:1484](../../src/lib/persistence/migrations/daemon-store-import.ts:1484). Preparing through an opening layer first would defeat that branch.
- **Layer merging does not express the required sequence.** Foundation components are siblings in `Layer.mergeAll` at [daemon-layers.ts:640](../../src/lib/domain/daemon/Layers/daemon-layers.ts:640). Use an explicit dependency barrier before directory construction at 803, servers at 830, background work at 870, and foreground recovery at 496.
- **Cold-reader stamping is destructive on shared storage.** [persistence-service.ts:60](../../src/lib/domain/persistence/Services/persistence-service.ts:60) rewrites differing command ownership and merges/deletes provider metadata. Replace both daemon uses of `makePersistenceServiceLive`; supplying shared SQL alone is unsafe.
- **Store ownership must outlive every relay.** The borrowed-context contract is at [live.ts](../../src/lib/persistence/effect/live.ts). Preserve one recovery semaphore at [projection-runner-effect.ts:111](../../src/lib/persistence/effect/projection-runner-effect.ts:111) and its permit around cursor reads at 532. Project tiers reuse the store's runner. Existing lifetime evidence is [store-tier.test.ts](../../test/integration/persistence/store-tier.test.ts).
- **Import blocks must survive ordinary retry transitions.** `startRelay` resets errors at registry line 704; `markReady` replaces non-ready states at [project-registry-service.ts:465](../../src/lib/domain/daemon/Services/project-registry-service.ts:465). Inference: recording an import failure as an ordinary relay Error alone permits accidental unblocking.
- **Keep recovery global while scoping project actions.** Store-wide projector cursors require store-wide replay, documented at [shared-store-scope-failure-modes.md:29](../../docs/plans/2026-10-16-shared-store-scope-failure-modes.md:29). Likewise, the global worktree-use safety query intentionally sees foreign sessions at [session-worktree-deletion.ts:31](../../src/lib/domain/relay/Services/session-worktree-deletion.ts:31).
- **Retain parent links across ownership boundaries.** Duplicate sessions keep their first owner under [ADR-0006:41](../../docs/adr/0006-daemon-store-import-normalises-copies-and-keeps-the-first-owner.md:41); non-shared children retain those parent links at [daemon-store-import.ts:571](../../src/lib/persistence/migrations/daemon-store-import.ts:571). Inference: lineage parent eligibility cannot require both sessions to share the child’s project ID.

4\. Proposed sequential split

This is a proposed implementation sequence, not a change made during the audit.

1. **Prove the complete daemon cutover through an internal opt-in. Highest risk.** Add ordered offline preparation/import/acquisition; publish `PersistenceStore`; switch all seven daemon file-opening paths; select directory adapter 2; move lineage; enforce import blocking at relay acquisition. Add one process E2E proving two legacy projects import, then create/read/resolve through the shared daemon store and restart without recreating source files. Emit a normalized manifest plus report/backups as the artifact. Existing default behavior stays usable until activation. The relevant construction points are [daemon-layers.ts:654](../../src/lib/domain/daemon/Layers/daemon-layers.ts:654), relay borrowing at [project-relay-layers.ts:480](../../src/lib/relay/project-relay-layers.ts:480), and the current process import spec at [harness-daemon-store-import.spec.ts:98](../../test/e2e/specs/harness-daemon-store-import.spec.ts:98).

2. **Complete retained-project and failure behavior.** Discover inactive sources; preserve ownership/reservations; propagate availability/reasons through project RPC and UI; test failed-project isolation, restart retry, removed-session hiding and re-add visibility. Keep this on the same opt-in until complete. Source discovery and visibility boundaries are [project-storage.ts:45](../../src/lib/persistence/project-storage.ts:45), [daemon-session-reader.ts:264](../../src/lib/domain/daemon/Services/daemon-session-reader.ts:264), and [project-registry-service.ts:543](../../src/lib/domain/daemon/Services/project-registry-service.ts:543).

3. **Activate the shared store and retire daemon per-file assumptions.** Make it the default, remove the temporary opt-in, retarget `projectStorePath`, update the consumer inventory and semantic tests above, and retain explicit importer/standalone fixtures. Include cold-start, restart, relay disposal and no-source-recreation evidence. Update the architecture description currently naming per-project history at [architecture.md:53](../../docs/agent-guide/architecture.md:53).

   Done in conduit-test-82tn.6.4.3: the daemon always owns `<configDir>/events.db`; runtime consumers use shared storage and legacy sources remain explicit fixtures.

   Cleanup done in conduit-test-82tn.6.2: removed the per-file session directory, ambiguity handling and ownership bookkeeping; standalone routing uses a slug-checked store lookup.

Step 1 carries the highest risk because it combines persistent-data migration with connection lifetime and startup ordering. The later default switch should add no new storage behavior.

5\. Open questions for a human

- **Backup-only failure:** should a committed import with `backupError` block its project, or remain usable while reporting the backup failure? The result distinguishes import failure from backup failure at [daemon-store-import.ts:67](../../src/lib/persistence/migrations/daemon-store-import.ts:67); backup failure preserves the committed import under [ADR-0006:55](../../docs/adr/0006-daemon-store-import-normalises-copies-and-keeps-the-first-owner.md:55).
- **Duplicate ownership involving removed projects:** retain the largest-store seed rule across all sources, even when a removed project wins a shared session and consequently keeps it hidden? Current first-owner policy is [ADR-0006:41](../../docs/adr/0006-daemon-store-import-normalises-copies-and-keeps-the-first-owner.md:41); largest-source selection is [daemon-store-import.ts:1484](../../src/lib/persistence/migrations/daemon-store-import.ts:1484).
- **Unowned retained history:** how should a user associate imported history with a folder when `project.json` is missing or unreadable? Current behavior deliberately reserves that slug instead of reusing it at [project-storage.ts:65](../../src/lib/persistence/project-storage.ts:65).

