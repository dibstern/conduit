# Shared-store cutover failure modes

The seams are the production daemon startup layer, daemon readers, session directory,
borrowed relay project tier, and the process harness. The daemon now always uses
the shared store; the earlier opt-in cases below record the preceding stages.

| Failure | Test that catches it |
| --- | --- |
| A daemon-store handle remains open during import or inode replacement. | Startup integration observes preparation scope closure before importer entry and long-lived acquisition afterwards. |
| Preparation creates an empty destination and defeats largest-source seeding. | Startup integration expects a seeded outcome on an absent destination. |
| An existing destination reaches import before migration and projection recovery. | Startup integration leaves an unprojected tail, restarts, and imports a new project. |
| A daemon reader migrates or stamps the shared store. | Startup integration spies on migrations/provenance during reads and compares ownership metadata. |
| A reader or directory lookup returns another project's sessions. | Startup integration checks scoped lists, provider lookup, recovery/count/settle and cleanup probes for both projects. |
| Adapter 2 resolves an unregistered project's session. | Startup integration checks absent registration, removal and re-registration. |
| Adapter 2 indexes project files on registration. | Startup integration registers against the shared directory and checks no source is recreated. |
| A directory SQL failure becomes AmbiguousSession. | Startup integration forces a lookup SQL failure and expects SessionDirectoryReadError. |
| Releasing a relay closes the daemon store. | Startup integration releases a borrowed project tier, then reads and writes through the retained store. |
| Lineage runs before import or opens per-project files. | Startup integration imports a forked child and checks lineage and absent sources after restart. |
| Cross-project parent ownership prevents lineage import. | Startup integration imports the parent and child under distinct stored owners. |
| Unresolved lineage is lost instead of retried durably. | Startup integration retains an unresolved archive and resolves it after a later import. |
| A reader, relay, background probe or restart recreates an imported source. | Startup integration and process E2E enumerate source paths after each stage. |
| The opt-in-off path drifts. | Existing unit/integration suites plus the E2E's initial legacy run. |
| Cold RPC contexts omit the shared store. | Process E2E opens both direct links in fresh pages and lists both projects. |
| A live prompt writes rows under another project. | Process E2E completes a second prompt in B and checks daemon-store ownership. |
| A second opt-in startup changes normalized durable history. | Process E2E compares daemonStoreManifest hashes before and after restart. |
| Evidence varies with ids, paths, timestamps or backup suffixes. | Process E2E writes a normalized 82tn6-shared-store.json artifact. |

## Initial red run

Before production changes, this command exited 1 during collection because
`daemon-shared-store-layer.js` did not exist. No assertions ran, so there were
no individual test failures yet. Log: `/tmp/82tn641-startup-red.log`.

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm exec vitest run --config vitest.integration.config.ts test/integration/persistence/daemon-shared-store-startup.test.ts
```

The declared cases covered import/lineage/readers/lifetime/restart, existing-store
preparation and archived-lineage retry, typed directory failures, and the default
per-file path. A fifth case exercises every cold reader with foreign-project
negatives and checks that reads neither prepare nor mutate the store.

## conduit-test-82tn.6.4.2: unavailable and retained projects

| Failure | Coverage |
| --- | --- |
| A corrupt import permits relay acquisition or writes before a restart repairs it. | Startup integration and process E2E reject acquisition, preserve zero project rows, and keep the healthy project usable. |
| A legacy migration failure looks like an absent, healthy store. | Startup integration exercises a failed legacy rewrite and checks its availability reason. |
| Lineage import updates already stored unavailable history through a healthy ancestor. | Startup integration checks lineage defers without changing the sidecar when unavailable owners already have shared rows. |
| A committed import is blocked by a backup-only failure or source-changed result. | Startup integration checks both remain available. |
| A source that changes before its import commits stays writable and is never imported. | Startup integration checks an uncommitted source-changed result blocks the project. |
| A retained store is omitted, loses its slug, or becomes visible without registration. | Startup integration and process E2E check imported ownership, lists, search and directory visibility. |
| A larger retained source takes a registered project's shared session. | Startup integration makes the retained store larger and checks registered seed and first-owner priority. |
| A retained-only startup cannot create a destination without a seed. | Startup integration imports retained history without registered sources. |
| Opt-in-off startup imports retained stores or publishes import blocks. | Startup integration checks the empty availability map and untouched retained source. |
| Repairing and restarting duplicates or loses original user messages. | Process E2E restores the original bytes, checks the count and renders the cold transcript. |
| Re-adding a removed folder chooses a new slug or hides its imported history. | Process E2E checks the original slug, session list and cold transcript. |
| Unavailable evidence varies by path, slug, id or timestamp. | Process E2E writes a separate normalized 82tn6-shared-store-unavailable.json artifact. |

## conduit-test-82tn.6.4.3: shared store as the only daemon mode

- Startup must import legacy fixtures before acquiring the daemon store, including when the destination does not exist.
- Runtime readers and test SQL must scope shared rows by project; store-wide backfill resets must remain intentional.
- Restart, project edits and relay disposal must not recreate project databases or close the daemon store; removed history must remain retained.
- Legacy fixtures must contain projected user and assistant messages that render through cold session links.
- Backup and restore must move the daemon database and its WAL/SHM sidecars together.
- Cutover artifacts must normalize volatile values and remain byte-identical across repeated runs.
- Standalone relay files and importer sources must remain independent, while no daemon mode selector or per-file fallback survives.
