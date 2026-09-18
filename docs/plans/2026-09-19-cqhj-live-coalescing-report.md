conduit-test-cqhj implementation report

Worktree: `ni8-coalesce`; branch: `feat/ni8-coalesce`; base: `76f6c186fb56c3dfd0df1ee261b8b48c9ea388af`. Changes are uncommitted. No tracker commands, pnpm, staging, stashing, or other worktrees were used.

Added live-only, self-clocked row coalescing in the shared orchestrator. All existing ordering and RPC chunk/ACK assertions pass unchanged. This implements an explicit delivery-window contract, but **does not establish that the epic's fast-client quadratic-wire risk is resolved**. See the baseline comparison below.

Investigation and decision

The requested files now live under `src/lib/domain/relay/Services/`. `session-detail-subscription.ts` returns the complete projected message, and `src/lib/persistence/effect/projectors-effect.ts:523` stamps the owning message on each part write.

Historical provider arrival evidence exists in `test/e2e/fixtures/recorded/*.opencode.json.gz`. `test/helpers/recording-proxy.ts:271-280` records SSE arrival differences with `Date.now()`. Accumulating these delays and grouping nonempty `message.part.delta` events by message and part gives 18 same-part gaps across the recordings: median 223.5 ms, positive-gap median 230 ms, range 0–585 ms, two zero gaps. Empty terminal deltas were excluded because they otherwise account for most apparent zero-delay bursts.

For `chat-streaming.opencode.json.gz`, recorded March 27 with OpenCode 1.3.0 and `opencode/big-pickle`, nonempty same-part gaps are 220, 477, 515, 585, and 525 ms. These are provider-batched text chunks, not individual model tokens. They measure historical provider receipt, not current database part-write cadence. Claude trace capture writes raw SDK messages without per-delta arrival timestamps (`src/lib/provider/claude/sdk-trace-capture.ts:43-45`). The 50 tokens/second figure in `docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations.md:37-56` is an assumption, not a measured result. No live measurement was possible here.

A fixed timer cannot be derived convincingly from this small, already-batched corpus. A short timer would delay most recorded updates without merging them; a long timer capable of merging typical recorded gaps would visibly delay delivery. I chose self-clocking, without an invented millisecond constant. This also agrees with the batch-level coalescing approach in `docs/plans/2026-04-23-effect-ts-protocol-additions.md:407-445`.

The mechanism has an actual transport clock. The installed `@effect/rpc/src/RpcServer.ts:391-401` writes each stream chunk and waits for a client ACK; the socket protocol enables ACKs at line 1512. `RpcClient.ts:550-559` acknowledges mailbox admission, not rendering. The underlying `@effect/platform/src/Socket.ts:507-514` merely invokes `ws.send()` synchronously, so using socket write completion alone would not provide the same backpressure.

While downstream is busy, Effect's scoped `Stream.aggregate` consumes live read groups and retains the last pending upsert per source key. Replacing A1 with A3 removes A1 from its earlier position: A1, B2, A3 becomes B2, A3. Surviving groups retain their separate delivery boundaries. Removals and recovery snapshot/marker pairs close the aggregation window. Opening snapshots and reconnect replay bypass aggregation entirely. The existing bus capacity of 256 is a pending-row backpressure threshold, not a timer; one intact read group can exceed it. No group or marker is split to enforce that threshold.

Files changed

- `src/lib/domain/relay/Services/read-model-subscription.ts`: shared live aggregation, source identity contract, preserved group boundaries. Existing bounded read windows and row sequence numbers remain intact.
- `src/lib/domain/relay/Services/session-detail-subscription.ts` and `shell-subscription.ts`: supply row keys. No subscription-specific coalescer.
- `test/unit/relay/read-model-coalescing.test.ts`: controlled 200-write reduction, cross-row ordering, recovery marker grouping, distinct-row chunk grouping.
- `test/unit/relay/read-model-subscription.test.ts`: identity plumbing in the existing fake source and a new capacity/overflow/recovery test. Existing test bodies and expectations were not changed.
- `test/unit/relay/session-detail-subscription.test.ts`: real SQLite/projector/advance integration with 200 part writes behind a held subscriber ACK. Existing tests were not changed.
- This report records the investigation and captured evidence.

TDD evidence

The seam was the public read-model orchestrator stream. Each implementation loop began with a failing behavioral test at that seam. Full captured run output follows; paths and line numbers reflect the file at each run.

1. Live coalescing. The controlled source commits each part write before yielding its advance, making all 200 versions observable. The original orchestrator delivered 200 upserts; the requirement is at most three across the held delivery window, including the complete final 200-character value. Added row identity and live aggregation after the red run.

Red command:
`./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts`

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ❯ |unit| test/unit/relay/read-model-coalescing.test.ts (1 test | 1 failed) 30ms
   × coalesces 200 part writes while the previous delivery is in flight 29ms
     → expected 200 to be less than or equal to 3

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| test/unit/relay/read-model-coalescing.test.ts > coalesces 200 part writes while the previous delivery is in flight
AssertionError: expected 200 to be less than or equal to 3
 ❯ next test/unit/relay/read-model-coalescing.test.ts:56:26
     54|   expect(delivered.slice(0, 2)).toEqual([{ _tag: "snapshot", rows: [],…
     55|   const updates = delivered.filter((envelope) => envelope._tag === "up…
     56|   expect(updates.length).toBeLessThanOrEqual(3);
       |                          ^
     57|   expect(updates.at(-1)).toEqual({ _tag: "upsert", item: { id: "messag…
     58|  }).pipe(Effect.provide(SessionEventBusLive)),

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  00:54:50
   Duration  405ms (transform 25ms, setup 39ms, collect 198ms, tests 30ms, environment 0ms, prepare 31ms)
```

Green command:
`./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts test/unit/relay/read-model-subscription.test.ts`

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ✓ |unit| test/unit/relay/read-model-coalescing.test.ts (1 test) 32ms
 ✓ |unit| test/unit/relay/read-model-subscription.test.ts (16 tests) 90ms

 Test Files  2 passed (2)
      Tests  17 passed (17)
   Start at  00:55:31
   Duration  392ms (transform 36ms, setup 52ms, collect 282ms, tests 123ms, environment 0ms, prepare 49ms)
```

2. Recovery boundary. The next test exposed aggregation splitting a recovery snapshot from its synchronized marker. Changed the aggregation input to intact read groups.

Red command:
`./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts`

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ❯ |unit| test/unit/relay/read-model-coalescing.test.ts (2 tests | 1 failed) 47ms
   ✓ coalesces 200 part writes while the previous delivery is in flight 31ms
   × keeps a recovery snapshot and synchronized together across live coalescing 15ms
     → expected [ { _tag: 'upsert', …(2) }, …(1) ] to deeply equal [ { _tag: 'snapshot', …(2) }, …(1) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| test/unit/relay/read-model-coalescing.test.ts > keeps a recovery snapshot and synchronized together across live coalescing
AssertionError: expected [ { _tag: 'upsert', …(2) }, …(1) ] to deeply equal [ { _tag: 'snapshot', …(2) }, …(1) ]

- Expected
+ Received

  [
    {
+     "_tag": "upsert",
+     "item": {
+       "id": "a",
+       "text": "1",
+     },
+     "sequence": 1,
+   },
+   {
      "_tag": "snapshot",
      "rows": [
        {
          "id": "a",
          "text": "2",
        },
      ],
      "sequence": 2,
-   },
-   {
-     "_tag": "synchronized",
    },
  ]

 ❯ next test/unit/relay/read-model-coalescing.test.ts:83:31
     81|   const batches = Chunk.toReadonlyArray(chunks).map(Chunk.toReadonlyAr…
     82|   const recovery = batches.find((batch) => batch.some((envelope) => en…
     83|   expect(recovery?.slice(-2)).toEqual([
       |                               ^
     84|    { _tag: "snapshot", rows: [{ id: "a", text: "2" }], sequence: 2 },
     85|    { _tag: "synchronized" },

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  00:56:48
   Duration  365ms (transform 27ms, setup 30ms, collect 144ms, tests 47ms, environment 0ms, prepare 29ms)
```

Green command:
`./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts test/unit/relay/read-model-subscription.test.ts`

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ✓ |unit| test/unit/relay/read-model-coalescing.test.ts (2 tests) 36ms
 ✓ |unit| test/unit/relay/read-model-subscription.test.ts (16 tests) 104ms

 Test Files  2 passed (2)
      Tests  18 passed (18)
   Start at  00:57:14
   Duration  461ms (transform 39ms, setup 52ms, collect 344ms, tests 141ms, environment 0ms, prepare 53ms)
```

3. Delivery boundaries. The first broad proving run exposed two existing RPC chunk/ACK contract failures. A new orchestrator-seam test reproduced merging two distinct rows into one chunk. Changed pending state to retain original read groups and emit surviving groups separately. No existing contract test was changed.

Red command:
`./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts`

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ❯ |unit| test/unit/relay/read-model-coalescing.test.ts (4 tests | 1 failed) 57ms
   ✓ coalesces 200 part writes while the previous delivery is in flight 30ms
   ✓ keeps the last version of every row in its original sequence position 11ms
   ✓ keeps a recovery snapshot and synchronized together across live coalescing 5ms
   × retains separate delivery groups for distinct rows 12ms
     → expected [ [ …(2) ], …(1) ] to deeply equal [ [ …(2) ], …(2) ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| test/unit/relay/read-model-coalescing.test.ts > retains separate delivery groups for distinct rows
AssertionError: expected [ [ …(2) ], …(1) ] to deeply equal [ [ …(2) ], …(2) ]

- Expected
+ Received

@@ -15,12 +15,10 @@
        "item": {
          "id": "row-1",
        },
        "sequence": 1,
      },
-   ],
-   [
      {
        "_tag": "upsert",
        "item": {
          "id": "row-2",
        },

 ❯ next test/unit/relay/read-model-coalescing.test.ts:264:68
    262|   );
    263|   const chunks = yield* stream({ source, bus: { ...bus, subscribeAdvan…
    264|   expect(Chunk.toReadonlyArray(chunks).map(Chunk.toReadonlyArray)).toE…
       |                                                                    ^
    265|    [{ _tag: "snapshot", rows: [], sequence: 0 }, { _tag: "synchronized…
    266|    [{ _tag: "upsert", item: { id: "row-1" }, sequence: 1 }],

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 3 passed (4)
   Start at  01:05:00
   Duration  535ms (transform 32ms, setup 51ms, collect 279ms, tests 57ms, environment 0ms, prepare 35ms)
```

Green command:
`./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts test/unit/relay/read-model-subscription.test.ts test/unit/contracts/ws-rpc-stream.test.ts`

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ✓ |unit| test/unit/relay/read-model-coalescing.test.ts (4 tests) 51ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream.test.ts (8 tests) 157ms
 ✓ |unit| test/unit/relay/read-model-subscription.test.ts (17 tests) 1112ms
   ✓ ReadModelSubscription > recovers a lost removal after coalescing reaches its row limit  1013ms

 Test Files  3 passed (3)
      Tests  29 passed (29)
   Start at  01:05:24
   Duration  1.57s (transform 309ms, setup 165ms, collect 1.29s, tests 1.32s, environment 0ms, prepare 110ms)
```

Additional verification

Cross-row retention and capacity/overflow recovery tests passed without further production changes. The overflow test fills the aggregation threshold, evicts a removal from the sliding bus, and checks ordered delivery followed by a replacement snapshot, synchronized, and a subsequent live update.

Final focused command:
```sh
./node_modules/.bin/vitest run test/unit/relay/read-model-coalescing.test.ts test/unit/relay/read-model-subscription.test.ts test/unit/relay/session-detail-subscription.test.ts test/unit/relay/shell-subscription.test.ts test/unit/contracts/ws-rpc-stream.test.ts test/unit/effect/runtime-boundary-grep.test.ts
```

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ✓ |unit| test/unit/effect/runtime-boundary-grep.test.ts (105 tests) 205ms
 ✓ |unit| test/unit/relay/read-model-coalescing.test.ts (4 tests) 60ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream.test.ts (8 tests) 180ms
 ✓ |unit| test/unit/relay/shell-subscription.test.ts (9 tests) 300ms
 ✓ |unit| test/unit/relay/session-detail-subscription.test.ts (16 tests) 510ms
 ✓ |unit| test/unit/relay/read-model-subscription.test.ts (17 tests) 1166ms
   ✓ ReadModelSubscription > recovers a lost removal after coalescing reaches its row limit  1051ms

 Test Files  6 passed (6)
      Tests  159 passed (159)
   Start at  01:06:32
   Duration  1.64s (transform 491ms, setup 310ms, collect 2.33s, tests 2.42s, environment 0ms, prepare 205ms)
```

Requested proving commands, quoted exactly:

```sh
./node_modules/.bin/tsgo --noEmit
```

No diagnostic output. Exit 0.

```sh
./node_modules/.bin/vitest run test/unit/relay test/unit/contracts test/unit/server
```

Final captured summary:
```text
 Test Files  7 failed | 104 passed (111)
      Tests  17 failed | 1077 passed | 12 skipped (1106)
     Errors  12 errors
   Start at  01:05:55
   Duration  40.82s (transform 2.86s, setup 3.00s, collect 42.63s, tests 144.47s, environment 8ms, prepare 3.16s)
```

Exit 1. The remaining seven failing files require socket listeners. The log contains `listen EPERM: operation not permitted 127.0.0.1`, server-startup failures, and listener-related hook/test timeouts. These files are `relay/per-tab-routing-e2e`, `relay/permission-rehydration-wiring`, `relay/status-poller-broadcast`, `relay/relay-stack-default-overrides`, `relay/relay-stack-opencode-runtime-ingress-wiring`, `server/effect-ws-handler`, and `server/http-server-layer`. The existing RPC chunk/ACK failures from the earlier run are fixed in this final run. The full requested suite is not green in this sandbox.

Full logs remain in `/private/tmp/cqhj-evidence/`, including `proving-vitest-final.log`, `tsgo.log`, and every red/green run. Scoped Biome checks and `git diff --check` pass. No browser build or visual gate was run; this change adds no frontend imports, code, assets, or styling. No new Node builtins or prohibited casts were introduced.

Baseline comparison and residual risks

**The real persisted-write test also passes on the original orchestrator.** I temporarily restored only the original orchestrator from HEAD, ran that test, and restored the implementation in a finally block. This is a characterization/integration safeguard, not evidence of a new 200-to-three production improvement:

```text
RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-coalesce

 ✓ |unit| test/unit/relay/session-detail-subscription.test.ts (16 tests | 15 skipped) 148ms

 Test Files  1 passed (1)
      Tests  1 passed | 15 skipped (16)
   Start at  01:00:55
   Duration  597ms (transform 92ms, setup 27ms, collect 296ms, tests 148ms, environment 0ms, prepare 26ms)
```

The controlled seam test is deliberately different: its finite stream makes every committed version available to the read before advancing again. It proves explicit reduction for the generic source contract. Actual independent providers can overwrite SQL rows while the old orchestrator waits for an ACK, so old bounded queries already skip many intermediate versions in that scenario.

Self-clocking bounds delivery by downstream windows and row cardinality, not by elapsed time. Fast clients can still receive one full message per provider write. Thus this change alone does not prove the original fast-client O(N²) byte growth is eliminated. Even fixed-rate snapshots reduce frequency, not necessarily asymptotic byte growth when response duration grows with token count; a strict byte bound would need deltas or a different protocol.

Aggregation occurs after full-row reads and history construction. It saves pending delivery payloads, not SQL or materialization work, and may perform more eager reads while an ACK is held. No current provider latency trace, browser smoothness measurement, or production byte benchmark was available to establish the net benefit. Independent review found no remaining ordering/resource defect but confirmed these product limits. The parent should not treat the epic's central performance risk as proven closed on this evidence.
