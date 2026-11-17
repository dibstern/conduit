# Run Ledger amendment: main-built runner paths deleted (82tn.32.47, 2026-11-17)

CONTRACT.md 7.4 is done. Runner protocol v6 refuses every main-built (v5) host at hello, so the
legacy send recovery and `LegacySendKey`, the legacy capability classification and its hello-field
readers, the `runner_idle_exit` reading (4.5) and `legacyRunnerRanking` are gone; every v6 host
fences opaquely and is journal-capable. Two pieces stay because the ledger build still uses them:
the reaper-less kill path and the stored-send rebuild, now `runner-stored-send.ts`.
`journals_before_execution` is no longer written, and a recorded 0 stays untrusted. Applied migration
SQL is unchanged. The registry-ranking backfill now reads an empty ranking, which is what a missing
or malformed registry already meant, so sequence order decides. Pre-ledger (main) stores are
unsupported: their cursors with an empty session id are no longer backfilled, so a store whose main
runner still lives fails with "Runner session changed". Where that runner is gone, a run migration
0097 marked `legacy_claim` may already have executed, so the feeder never sends it and nothing claims
it as fed: orphan recovery ends its turn `runner_stopped`, never re-sent. The two-build tests now upgrade from the ledger build 4b2fe6ee to the
current build. Crash-matrix F49 (holderless dispatched run) and F53 (`runner_idle_exit`) are not
applicable, since only main-built hosts produced them.
