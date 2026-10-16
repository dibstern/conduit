# Shared-store cutover failure modes

The seams are the production daemon startup layer, daemon readers, session directory,
borrowed relay project tier, and the process harness. The opt-in remains internal.

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
