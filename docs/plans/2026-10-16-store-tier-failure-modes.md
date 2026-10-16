# Store-tier failure modes

The store owns its connection and replay. Projects borrow those services and own their scoped reads, writes and directory refresh.

| Failure | Evidence |
| --- | --- |
| Closing a project closes the shared connection. | Release A, then read and append through B. |
| Concurrent recovery projects the same event twice. | Yield after cursor reads, start both recoveries, and count each event's projector calls. |
| Project construction migrates a shared store. | Observe that project construction invokes no migrator. |
| Project construction stamps another project's command rows or merges provider metadata. | Compare command rows and provider_command_meta before and after opening B. |
| A project's scoped session list includes another project's sessions and messages. | Use production EventStore and scoped ReadQuery lists through A and B, then read each listed session's messages. |
| Recovery indexes another project's sessions. | Each directory stub receives only its project's ids after store-wide replay. |
| The store runner overrides the project's runner in the composed Context. | Resolve the composed runner, compare its methods with the store runner, and observe directory replacement on every recover. |
| Recovery becomes project-filtered and skips another project's tail. | Leave A and B events pending and recover concurrently through both project tiers. |
| Per-file provenance stamping runs before schema preparation or after consumers start. | Existing provenance and importer tests remain green. |
| Layer memoization makes separate file compositions share a connection or service. | Existing multi-file composition tests remain green; preserve fresh store construction. |
| Store tuning or finalizer order changes. | Existing writer-profile test checks startup, periodic and close optimization. |
| A replay failure or interruption retains the recovery permit. | Use an Effect semaphore whose permit is released on every exit. |
| Evidence changes with random ids, time, or recovery scheduling. | Normalize the manifest and compare artifact bytes from two runs. |

## Test seams

The integration test builds one production store Context and borrows it through PersistenceStore, the same branch used by relay composition. It exercises production EventStore, ProjectionRunner and ReadQuery services in separately disposable project scopes. Directory stubs record the external indexing calls; a counting projector exposes duplicate replay without relying on idempotent production projections.

## Initial red run

Before implementation, `pnpm exec vitest run --config vitest.integration.config.ts test/integration/persistence/store-tier.test.ts` failed both tests with `TypeError: makePersistenceStoreLayer is not a function`:

- `isolates projects, serializes store-wide recovery, refreshes project directories and borrows store lifetime`
- `opens a project without migrating or stamping existing commands and provider metadata`

The concurrency test was also checked with the recovery permit temporarily removed. It failed because both callers replayed the tail. The permit was restored before the final verification.
