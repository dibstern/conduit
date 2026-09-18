# cqhj suffix delivery report

Worktree: `/Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj`. Branch: `feat/ni8-cqhj-suffix`. Base: `1383e48bbfac00ac00cf3739be80e3eb0dc1bc8b`.

Implemented the 2026-09-19 amendment. Live detail advances now carry append-only text suffixes, while the server still re-queries authoritative current rows. There is no timer or new coalescing algorithm. No existing test was edited. Changes remain uncommitted; no index-writing git command or pnpm command was run.

No `-o` path was supplied in the request. This is the announced default report path.

## State ownership and recovery

The encoder sits immediately after `subscribeSessionDetail` in the RPC handler. It cannot affect the shared orchestrator's read windows, source routing, row versions, or ordering. It transforms an existing `upsert`; it does not introduce an event kind. The generic orchestrator and concrete subscription are unchanged.

Each execution of the encoder owns a `Map` keyed by message ID, allocated inside `Stream.suspend`. It retains the last full row encoded for that subscriber. Keeping the prior strings, rather than lengths alone, lets the encoder verify prefix equality and send a whole row for same-length rewrites or truncation. Cost is O(retained transcript size) per subscriber, including metadata; it is released with the subscription. This is an explicit memory-for-wire tradeoff. No cache belongs to the socket, daemon, project, or reusable stream description.

The encoding covers both message-level text and each part's text, keyed by part ID. Both are present in projected messages, so encoding only the part would leave quadratic message-level traffic. The rest of the row remains authoritative replacement metadata. Each suffix carries its base length and resulting total. Lengths use UTF-16 code units, matching JavaScript append and slice; the benchmark counts serialized UTF-8 bytes instead.

Snapshots and every replay upsert pass through whole. Encoding begins only after `synchronized`. An overflow snapshot clears and reseeds the cache, passes through unchanged, and retains its immediately following marker. Server `Stream.map` preserves the original stream chunks, including replay batching. It neither drops nor reorders envelopes.

The frontend decoder belongs to each RPC issue and runs before resume deduplication. It appends only when both base and resulting lengths agree. It publishes the row only after all fields validate. Full replay rows seed the decoder even when the resume layer suppresses duplicate delivery to the consumer. Consumers continue receiving whole projected messages from one authoritative source.

On a length disagreement, the decoder raises `DetailLengthMismatch`. The resume layer discards `closed`, `open`, and `seen`, closes the failed issue, and reissues without a cursor. The existing cold-start path sends whole rows in a fresh snapshot, followed immediately by `synchronized`. This deliberately resends the whole view rather than adding a unary row-repair RPC that could race later advances. No repair payload is merged with provider events.

On ordinary reconnect, both encoder and decoder caches start empty. Replay remains full and ordered; the first live version of a row absent from replay is also full. Safety does not rely on this reset: the explicit stale-state test retains a server-generated suffix from a five-character prefix, starts a fresh client decoder at resume cursor 7 with no buffer, and observes requests `[7, undefined]`. Only a whole-row snapshot containing `Hello world` reaches the repaired transcript. The missing prefix is caught by the length check.

## Byte evidence

The test commits real `text.delta` events through SQLite projection and the advance bus. It waits for each delivered advance, exercising a fast subscriber that receives every write. It measures the complete serialized envelope, including duplicated message/part text and suffix metadata, after the actual RPC success schema's encoder. Every envelope is JSON-decoded through that schema and the client decoder; the final transcript is asserted correct. RPC/WebSocket framing is not counted; it adds bounded overhead per delivery, not growing full-row text.

Each write adds 16 repetitions of `🦊é`, or 96 UTF-8 bytes, to one streaming assistant part. Opening snapshot and marker bytes are included.

| Part writes | Final text bytes | Full-row bytes, red | Suffix bytes, green |
| ---: | ---: | ---: | ---: |
| 32 | 3,072 | 108,959 | 16,371 |
| 64 | 6,144 | 414,376 | 32,764 |
| 128 | 12,288 | 1,615,463 | 66,106 |
| 256 | 24,576 | 6,376,680 | 132,601 |

Doubling final length nearly quadrupled full-row traffic. It now approximately doubles suffix traffic. The test asserts each doubling stays below 2.2x and total envelope bytes stay below 10x final text bytes. These are byte assertions, not delivery-count assertions. For append-only text and a fixed row shape, each text character is sent once after the initial row, regardless of how many intermediate row versions the re-query discipline skips.

## Files changed

- `src/lib/contracts/ws-rpc.ts`: specialized detail envelope with optional suffix lengths; explicitly types the existing message-level text field.
- `src/lib/domain/relay/Services/session-detail-wire.ts`: per-execution live encoder.
- `src/lib/server/ws-rpc.ts`: applies encoding at the detail RPC boundary.
- `src/lib/frontend/transport/session-detail-wire.ts`: validates and decodes suffixes.
- `src/lib/frontend/transport/shared-client.ts`: decodes each issued detail stream before resume deduplication.
- `src/lib/frontend/transport/resume.ts`: cold resubscription on length disagreement.
- `test/unit/relay/session-detail-wire.test.ts`: eight new behavioral tests, including real persisted-write byte growth and recovery.
- This report.

## TDD evidence

The seams were the authoritative detail subscription's outgoing wire envelopes and the client transport's recovered transcript. The ticket explicitly requested byte counts and corrupted-length recovery at those boundaries. The first encoder and decoder were passthroughs so the reds demonstrated behavioral failures rather than missing imports. No suffix implementation preceded the byte-growth red; no client recovery implementation preceded the corrupted-total red.

### Loop 1: linear wire bytes

Red: the real persisted-write stream delivered quadratic full rows. Green: the encoder sent append-only suffixes. The existing ordering and RPC chunk tests ran unchanged in the green command. This intermediate green covered the server encoder; client decoding followed in loop 2.

Red

```sh
./node_modules/.bin/vitest run test/unit/relay/session-detail-wire.test.ts
```

Exit code: 1.

```text

 RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj

stdout | test/unit/relay/session-detail-wire.test.ts > session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes
wire bytes [{"writes":32,"finalBytes":3072,"deliveredBytes":108959},{"writes":64,"finalBytes":6144,"deliveredBytes":414376},{"writes":128,"finalBytes":12288,"deliveredBytes":1615463},{"writes":256,"finalBytes":24576,"deliveredBytes":6376680}]

 ❯ |unit| test/unit/relay/session-detail-wire.test.ts (1 test | 1 failed) 496ms
   × session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes 496ms
     → expected 3.803045182132729 to be less than 2.2

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| test/unit/relay/session-detail-wire.test.ts > session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes
AssertionError: expected 3.803045182132729 to be less than 2.2
 ❯ next test/unit/relay/session-detail-wire.test.ts:53:62
     51|     const current = measurements[i];
     52|     if (!previous || !current) throw new Error("missing measurement");
     53|     expect(current.deliveredBytes / previous.deliveredBytes).toBeLessT…
       |                                                              ^
     54|     expect(current.deliveredBytes).toBeLessThan(current.finalBytes * 1…
     55|    }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  02:28:06
   Duration  952ms (transform 76ms, setup 27ms, collect 286ms, tests 496ms, environment 0ms, prepare 29ms)

```

Green

```sh
./node_modules/.bin/vitest run test/unit/relay/session-detail-wire.test.ts test/unit/relay/read-model-subscription.test.ts test/unit/relay/session-detail-subscription.test.ts test/unit/contracts/ws-rpc-stream.test.ts
```

Exit code: 0.

```text

 RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj

 ✓ |unit| test/unit/relay/read-model-subscription.test.ts (16 tests) 79ms
 ✓ |unit| test/unit/relay/session-detail-subscription.test.ts (15 tests) 420ms
stdout | test/unit/relay/session-detail-wire.test.ts > session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes
wire bytes [{"writes":32,"finalBytes":3072,"deliveredBytes":16371},{"writes":64,"finalBytes":6144,"deliveredBytes":32764},{"writes":128,"finalBytes":12288,"deliveredBytes":66106},{"writes":256,"finalBytes":24576,"deliveredBytes":132601}]

 ✓ |unit| test/unit/relay/session-detail-wire.test.ts (1 test) 591ms
   ✓ session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes  591ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream.test.ts (8 tests) 159ms

 Test Files  4 passed (4)
      Tests  40 passed (40)
   Start at  02:29:05
   Duration  1.29s (transform 385ms, setup 219ms, collect 1.97s, tests 1.25s, environment 0ms, prepare 143ms)

```

### Loop 2: length disagreement repairs the transcript

Red: the deliberately corrupted total reached the consumer as an upsert instead of causing a whole-row resend. Green: decoding checks both lengths, the resume cursor resets, the real server subscription sends a fresh snapshot, and a subsequent `!` advance produces `Hello world!` correctly. Existing resume and RPC ordering tests remained unchanged.

Red

```sh
./node_modules/.bin/vitest run test/unit/relay/session-detail-wire.test.ts
```

Exit code: 1.

```text

 RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj

stdout | test/unit/relay/session-detail-wire.test.ts > session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes
wire bytes [{"writes":32,"finalBytes":3072,"deliveredBytes":16371},{"writes":64,"finalBytes":6144,"deliveredBytes":32764},{"writes":128,"finalBytes":12288,"deliveredBytes":66106},{"writes":256,"finalBytes":24576,"deliveredBytes":132601}]

 ❯ |unit| test/unit/relay/session-detail-wire.test.ts (2 tests | 1 failed) 531ms
   × session detail wire > a corrupted total requests a whole-row snapshot and streaming continues correctly 67ms
     → expected 'upsert' to be 'snapshot' // Object.is equality
   ✓ session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes  463ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| test/unit/relay/session-detail-wire.test.ts > session detail wire > a corrupted total requests a whole-row snapshot and streaming continues correctly
AssertionError: expected 'upsert' to be 'snapshot' // Object.is equality

Expected: "snapshot"
Received: "upsert"

 ❯ next test/unit/relay/session-detail-wire.test.ts:60:24
     58|    yield* commit([canonicalEvent("text.delta", "s", { messageId: "m", …
     59|    const repair = yield* Queue.take(output);
     60|    expect(repair._tag).toBe("snapshot");
       |                        ^
     61|    if (repair._tag !== "snapshot") throw new Error("expected whole-row…
     62|    expect(repair.rows).toMatchObject([{ message: { text: "Hello world"…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  02:30:06
   Duration  1.20s (transform 105ms, setup 41ms, collect 485ms, tests 531ms, environment 0ms, prepare 34ms)

```

Green

```sh
./node_modules/.bin/vitest run test/unit/relay/session-detail-wire.test.ts test/unit/frontend/transport/resume.test.ts test/unit/contracts/ws-rpc-stream.test.ts
```

Exit code: 0.

```text

 RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj

 ✓ |unit| test/unit/frontend/transport/resume.test.ts (16 tests) 325ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream.test.ts (8 tests) 165ms
stdout | test/unit/relay/session-detail-wire.test.ts > session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes
wire bytes [{"writes":32,"finalBytes":3072,"deliveredBytes":16371},{"writes":64,"finalBytes":6144,"deliveredBytes":32764},{"writes":128,"finalBytes":12288,"deliveredBytes":66106},{"writes":256,"finalBytes":24576,"deliveredBytes":132601}]

 ✓ |unit| test/unit/relay/session-detail-wire.test.ts (2 tests) 610ms
   ✓ session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes  526ms

 Test Files  3 passed (3)
      Tests  26 passed (26)
   Start at  02:31:01
   Duration  1.25s (transform 366ms, setup 138ms, collect 1.57s, tests 1.10s, environment 0ms, prepare 105ms)

```

### Type integration

The initial type check found the pre-existing schema exposed message text only through its unknown index signature, immutable decoded arrays were being assigned to, and the test issue still required services. The fixes explicitly type text, replace decoded parts immutably, and provide the test's captured Effect context. No prohibited casts were used.

Red

```sh
./node_modules/.bin/tsgo --noEmit
```

Exit code: 2.

```text
src/lib/domain/relay/Services/session-detail-wire.ts(49,23): error TS4111: Property 'text' comes from an index signature, so it must be accessed with ['text'].
src/lib/domain/relay/Services/session-detail-wire.ts(49,66): error TS4111: Property 'text' comes from an index signature, so it must be accessed with ['text'].
src/lib/domain/relay/Services/session-detail-wire.ts(49,81): error TS4111: Property 'text' comes from an index signature, so it must be accessed with ['text'].
src/lib/frontend/transport/session-detail-wire.ts(34,58): error TS4111: Property 'text' comes from an index signature, so it must be accessed with ['text'].
src/lib/frontend/transport/session-detail-wire.ts(37,56): error TS4111: Property 'text' comes from an index signature, so it must be accessed with ['text'].
src/lib/frontend/transport/session-detail-wire.ts(42,44): error TS2339: Property 'text' does not exist on type '{ id: string; role: "assistant" | "user"; parts?: readonly ({ readonly id: string; readonly type: string; readonly text?: string | undefined; readonly renderedHtml?: string | undefined; readonly state?: { ...; } | undefined; readonly callID?: string | undefined; readonly tool?: string | undefined; readonly time?: un...'.
src/lib/frontend/transport/session-detail-wire.ts(43,36): error TS2542: Index signature in type 'readonly ({ readonly id: string; readonly type: string; readonly text?: string | undefined; readonly renderedHtml?: string | undefined; readonly state?: { readonly [x: string]: unknown; } | undefined; readonly callID?: string | undefined; readonly tool?: string | undefined; readonly time?: unknown; } & { ...; })[]' only permits reading.
test/unit/relay/session-detail-wire.test.ts(41,24): error TS2345: Argument of type '(resumeFromSequence: number | undefined) => import("/Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj/node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/dts/Stream").Stream<{ readonly _tag: "snapshot"; readonly rows: readonly ({ readonly _tag: "transcriptMessage"; readonly message: { readonly id: string;...' is not assignable to parameter of type '(resumeFromSequence: number | undefined) => import("/Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj/node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/dts/Stream").Stream<{ readonly _tag: "snapshot"; readonly rows: readonly ({ readonly _tag: "transcriptMessage"; readonly message: { readonly id: string;...'.
  Type 'import("/Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj/node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/dts/Stream").Stream<{ readonly _tag: "snapshot"; readonly rows: readonly ({ readonly _tag: "transcriptMessage"; readonly message: { readonly id: string; readonly role: "assistant" | "user"; readon...' is not assignable to type 'import("/Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj/node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/dts/Stream").Stream<{ readonly _tag: "snapshot"; readonly rows: readonly ({ readonly _tag: "transcriptMessage"; readonly message: { readonly id: string; readonly role: "assistant" | "user"; readon...'. Two different types with this name exist, but they are unrelated.
    Type 'ReadQueryEffectTag | SessionEventBusTag' is not assignable to type 'never'.
      Type 'ReadQueryEffectTag' is not assignable to type 'never'.
test/unit/relay/session-detail-wire.test.ts(55,64): error TS2345: Argument of type 'object' is not assignable to parameter of type '{ readonly _tag: "snapshot"; readonly rows: readonly ({ readonly _tag: "transcriptMessage"; readonly message: { readonly id: string; readonly role: "assistant" | "user"; readonly parts?: readonly ({ readonly id: string; readonly type: string; ... 5 more ...; readonly time?: unknown; } & { ...; })[] | undefined; read...'.
```

Green

```sh
./node_modules/.bin/tsgo --noEmit
```

Exit code: 0. No stdout or stderr.

The additional stale-state reconnect, duplicate replay, missed/reordered/duplicate suffix, rewrite/truncation, removed-part, independent-execution, and replacement-snapshot checks passed on their first run without further functional changes. They are regression coverage, not additional claimed red/green fixes. The final byte test also validates schema round-trip and reconstructed text.

## Verification

The worktree initially lacked `node_modules`. Installed dependencies were copied into this worktree from the main checkout; no dependency installation or source-tree modification outside this worktree was performed.

The requested commands were captured with `tee` before `tail` and shell `pipefail`, so their underlying exit codes were retained. The following is the actual final 6,000-byte tail, including the partial UTF-8 character at its boundary.

Requested relay/persistence verification

```sh
./node_modules/.bin/vitest run test/unit/relay/ test/unit/persistence/ 2>&1 | tail -c 6000
```

Exit code: 1.

```text
��⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/status-poller-broadcast.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:1986:21
 ❯ listenInCluster node:net:2065:12
 ❯ node:net:2274:7
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/permission-rehydration-wiring.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:1986:21
 ❯ listenInCluster node:net:2065:12
 ❯ node:net:2274:7
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/per-tab-routing-e2e.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:1986:21
 ❯ listenInCluster node:net:2065:12
 ❯ node:net:2274:7
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "wires relay-stack SSE events through Effect persistence into the read model". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:1986:21
 ❯ listenInCluster node:net:2065:12
 ❯ node:net:2274:7
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/relay-stack-default-overrides.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "applies public default-agent commands through the relay-owned command path". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:1986:21
 ❯ listenInCluster node:net:2065:12
 ❯ node:net:2274:7
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "keeps named OpenCode stream provider bindings isolated through the shared ingress". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:1986:21
 ❯ listenInCluster node:net:2065:12
 ❯ node:net:2274:7
 ❯ processTicksAndRejections node:internal/process/task_queues:90:21

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' }
This error originated in "test/unit/relay/relay-stack-default-overrides.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "starts when OpenCode is unavailable so non-OpenCode providers can load". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  5 failed | 93 passed (98)
      Tests  5 failed | 1168 passed | 12 skipped (1185)
     Errors  8 errors
   Start at  02:35:14
   Duration  39.30s (transform 2.86s, setup 2.19s, collect 31.70s, tests 107.80s, environment 4ms, prepare 1.85s)

```

Vitest reports 1,168 passed, 12 skipped, five failing files and eight listener errors. The five files are sandbox artifacts from `listen EPERM: operation not permitted 127.0.0.1`, with consequent setup/test timeouts, not observed suffix regressions:

- `test/unit/relay/per-tab-routing-e2e.test.ts`
- `test/unit/relay/permission-rehydration-wiring.test.ts`
- `test/unit/relay/status-poller-broadcast.test.ts`
- `test/unit/relay/relay-stack-default-overrides.test.ts`
- `test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts`

The requested suite therefore did not exit green in this sandbox. No non-socket failure appeared.

Requested type verification

```sh
./node_modules/.bin/tsgo --noEmit 2>&1 | tail -c 2000
```

Exit code: 0. No stdout or stderr.

Frontend type verification

```sh
./node_modules/.bin/tsgo --noEmit --project src/lib/frontend/tsconfig.json
```

Exit code: 0. No stdout or stderr.

Focused behavioral, ordering, transport and Effect guardrails

```sh
./node_modules/.bin/vitest run test/unit/relay/session-detail-wire.test.ts test/unit/relay/read-model-subscription.test.ts test/unit/relay/session-detail-subscription.test.ts test/unit/relay/shell-subscription.test.ts test/unit/contracts/ws-rpc-stream.test.ts test/unit/frontend/transport/resume.test.ts test/unit/effect/runtime-boundary-grep.test.ts
```

Exit code: 0.

```text

 RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj

 ✓ |unit| test/unit/effect/runtime-boundary-grep.test.ts (105 tests) 233ms
 ✓ |unit| test/unit/relay/read-model-subscription.test.ts (16 tests) 105ms
 ✓ |unit| test/unit/frontend/transport/resume.test.ts (16 tests) 349ms
 ✓ |unit| test/unit/relay/session-detail-subscription.test.ts (15 tests) 543ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream.test.ts (8 tests) 176ms
stdout | test/unit/relay/session-detail-wire.test.ts > session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes
wire bytes [{"writes":32,"finalBytes":3072,"deliveredBytes":16371},{"writes":64,"finalBytes":6144,"deliveredBytes":32764},{"writes":128,"finalBytes":12288,"deliveredBytes":66106},{"writes":256,"finalBytes":24576,"deliveredBytes":132601}]

 ✓ |unit| test/unit/relay/session-detail-wire.test.ts (8 tests) 775ms
   ✓ session detail wire > delivers linear UTF-8 bytes across N persisted streaming part writes  668ms
 ✓ |unit| test/unit/relay/shell-subscription.test.ts (17 tests) 658ms

 Test Files  7 passed (7)
      Tests  185 passed (185)
   Start at  02:34:32
   Duration  1.79s (transform 707ms, setup 380ms, collect 3.86s, tests 2.84s, environment 0ms, prepare 258ms)

```

All contract tests

```sh
./node_modules/.bin/vitest run test/unit/contracts/
```

Exit code: 0.

```text

 RUN  v3.2.4 /Users/dstern/src/personal/conduit/.worktrees/ni8-cqhj

 ✓ |unit| test/unit/contracts/providers/sdk-version-lock.test.ts (3 tests) 2ms
 ✓ |unit| test/unit/contracts/contracts-boundary.test.ts (3 tests) 3ms
 ✓ |unit| test/unit/contracts/providers/claude-agent-sdk.test.ts (3 tests) 3ms
 ✓ |unit| test/unit/contracts/providers/opencode-sdk.test.ts (15 tests) 4ms
 ✓ |unit| test/unit/contracts/e2e-session-list-fixtures.test.ts (14 tests) 4ms
 ✓ |unit| test/unit/contracts/providers/provider-runtime-event.test.ts (20 tests) 33ms
 ✓ |unit| test/unit/contracts/provider-instance.test.ts (4 tests) 3ms
 ✓ |unit| test/unit/contracts/session-wire-type.test.ts (6 tests) 4ms
 ✓ |unit| test/unit/contracts/envelope-schema.test.ts (1 test) 2ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream-members.test.ts (2 tests) 17ms
 ✓ |unit| test/unit/contracts/session-detail-item-schema.test.ts (1 test) 3ms
 ✓ |unit| test/unit/contracts/ws-rpc-contract.test.ts (11 tests) 29ms
 ✓ |unit| test/unit/contracts/ws-rpc-stream.test.ts (8 tests) 146ms

 Test Files  13 passed (13)
      Tests  91 passed (91)
   Start at  02:35:42
   Duration  1.02s (transform 525ms, setup 636ms, collect 3.89s, tests 253ms, environment 1ms, prepare 403ms)

```

Scoped lint

```sh
./node_modules/.bin/biome check src/lib/contracts/ws-rpc.ts src/lib/domain/relay/Services/session-detail-wire.ts src/lib/frontend/transport/session-detail-wire.ts src/lib/frontend/transport/resume.ts src/lib/frontend/transport/shared-client.ts src/lib/server/ws-rpc.ts test/unit/relay/session-detail-wire.test.ts
```

Exit code: 0.

```text
Checked 7 files in 38ms. No fixes applied.
```

Whitespace verification

```sh
git diff --check
```

Exit code: 0. No stdout or stderr.

Existing tests unchanged relative to the requested base

```sh
git diff --exit-code 1383e48b -- test
```

Exit code: 0. No stdout or stderr.

All 72 existing tests in the focused ordering/subscription/resume suites passed unchanged. The eight new tests and 105 Effect guardrails also passed. The implementation does not modify composer components, feature files, visual baselines or the acceptance harness; no visual acceptance or browser build was run. A final comment clarified the recovery exception in the resume module after the test runs; no executable code changed afterward.

## Residual risks and limits

- Full snapshot repair resends the whole transcript. Repeated corruption, reconnects, or non-append rewrites are outside the healthy streaming-byte bound.
- The guarantee concerns streamed text for a fixed row structure. Growing tool results or an ever-growing number of parts/metadata fields can still cause repeated non-text bytes; those fields are not delta-encoded.
- Server re-query/materialization, prefix comparison, and client concatenation still process growing strings. This fixes wire growth, not CPU or database cost.
- Length checks detect missing, duplicated or reordered nonempty suffixes when a subsequent envelope exposes the discontinuity. They do not detect arbitrary equal-length content corruption, or a silently missing final frame with no subsequent traffic. Normal WebSocket ordering and reconnect replay remain responsible for transport delivery; this implementation adds no checksum or application-level delivery acknowledgement.
- Encoding and decoding are paired protocol changes. The current shared client consumes the new encoding, but an old browser bundle that ignores suffix metadata is not compatible with a newly deployed encoder. A mixed-version rollout would need capability negotiation or coordinated reloads.
- Socket-listening integration coverage remains unverified in this sandbox. No live provider or browser session was used.
- A read-only independent review found no normal-path ordering defect. It noted a theoretical mixed interruption-plus-length-mismatch cause could reach the mismatch retry before the existing cancellation branch; no production path producing that mixed cause was identified or claimed tested.

Raw captured evidence remains under `.evidence/cqhj/`. No Beads task was closed or shared tracker state mutated. This is an uncommitted implementation handoff, not a merged or published delivery.
