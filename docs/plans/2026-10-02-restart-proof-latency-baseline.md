# Process harness and send-path baseline

Ticket: `conduit-test-85kb.5`, under `conduit-test-85kb`.

Measured on 2026-10-02 at 05:52:46 UTC, 15:52:46 Australia/Melbourne.
Machine: Apple M4 Max Mac Studio, arm64, Darwin 25.6.0, Node v26.10.0.
Build: worktree at `6ad4ad584ca284bc6b5c455b6c6d56e9e5d3365b`, with this
ticket's process-test instrumentation and review fixes. This is the existing in-process Claude
adapter, before the session-runner migration.

| Measurement | Samples across five batches | Median batch p50, ms | Median batch p99, ms |
| --- | ---: | ---: | ---: |
| Send RPC receipt to provider enqueue | 1,000 | 12.825 | 45.312 |
| SDK event emit to browser WS frame receipt | 3,000 | 0.794 | 7.775 |

Ten unmeasured sends warm one Claude session and its single SDK query per
build. Five batches then each make 200 sequential sends, with three uniquely
identifiable text deltas per send. Comparisons keep both processes alive and
alternate baseline batch 1, candidate batch 1, through batch 5. Each build uses
the same session and query throughout. Both builds must acknowledge fake SDK
activation before any warmup prompt is sent.

Each batch uses nearest-rank p50/p99. Reported p50/p99 values are the medians
of the five batch percentiles, not pooled-sample percentiles. The +2 ms gate
compares unrounded median batch p99s independently for both metrics. An isolated
tail spike cannot set the verdict; repeated tail regressions still fail. The
benchmark rejects missing, duplicated, negative and non-finite samples, waits
for IPC timing marks, and checks that the query stays warm. No model calls or
managed OpenCode processes are involved.

## Measurement boundaries

The real foreground daemon runs in a child process. Its HOME, Conduit config,
Claude profile, cache and project directories live under a fresh `/tmp` root.
OpenCode discovery and managed startup are disabled. An unreachable unmanaged
`http://127.0.0.1:0` placeholder keeps existing OpenCode pollers away from any
developer instance. The harness drives the actual `/rpc` and `/ws` endpoints
using the browser RPC group and its normal WebSocket transport.

The SDK fake is selected at the existing query-factory seam, only when
`NODE_ENV=test`, an IPC channel and `CONDUIT_TEST_CLAUDE_QUERY_MODULE` are all
present. It replaces session and title queries; the child also injects the
existing capability-probe override. A prompt-free browser connection starts
the lazy project relay. The relay acknowledges the selected fake module and
project directory after startup; missing acknowledgment rejects supplied builds
before prompts. The process fake raises the send limit to
10,000 per ten seconds so all batches can run without throttling. Each send
still runs the normal limiter. Other relays retain five sends per ten seconds.

RPC receipt is marked in the server's WebSocket message callback before Effect
RPC routing. Provider enqueue is marked when the fake consumes the prompt from
the streaming-input query. Both endpoints use the child's
`process.hrtime.bigint()` clock. Each fake text delta is marked immediately
before its SDK yield, then matched to its exact browser delta frame. The client
timestamps that frame at the start of its WebSocket callback, before parsing.
Node's `hrtime` uses the host monotonic clock shared by both processes. Marks
travel over child IPC; IPC delivery time is never an endpoint in the metrics.
These measurements include the active test instrumentation's overhead.

The restart test kills the server with SIGKILL after a completed turn, starts a
fresh foreground daemon on the same directories, reconnects, compares the
persisted history and sends another turn. It establishes the reusable process
fixture and completed-history parity. Mid-turn or pending-approval survival
requires the later runner tickets.

## Reproduce and compare

Dependencies must already be installed. Set the worktree's required pnpm flags
before every pnpm command, or export them once for the shell:

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm build
pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/process-harness.test.ts
pnpm bench:send-path --dist dist --output /tmp/send-path-baseline.json
pnpm bench:send-path --dist /path/to/baseline/dist --candidate /path/to/candidate/dist --output /tmp/send-path-comparison.json
```

Both dist directories must contain this ticket's factory/timing seam and have
their runtime dependencies available in an ancestor `node_modules`. The
benchmark starts each build in its own fresh temp directories and cleans them
up afterwards. `--output` saves the machine, date, exact percentiles and all raw
samples. The process tests write repeatable JSON evidence with process IDs,
restart signals, timing marks, browser frames and a log tail under
`test-results/process-harness/`.

The comparison prints every batch's p99s, each build's median batch p50/p99,
and median batch p99 deltas. It exits 1 when either candidate median batch p99
exceeds that run's baseline by more than 2 ms, using unrounded values. Run
comparisons on the same quiet machine. Scheduling, GC and growing session
history can still affect local measurements; median aggregation reduces the
effect of isolated batches and does not remove sustained host noise.

Same-build calibration command, exit 0:

```sh
pnpm bench:send-path --dist dist --candidate dist --output /tmp/conduit-85kb-5-review-comparison.json
```

Output (both builds are the current rebuilt dist):

```text
Machine: {"platform":"darwin","release":"25.6.0","arch":"arm64","cpu":"Apple M4 Max","node":"v26.10.0"}
Method: 5 batches/build, 200 sends/batch, baseline/candidate alternating; median batch p50/p99
batch 1 baseline: enqueue p99=22.138ms forward p99=3.463ms
batch 1 candidate: enqueue p99=10.378ms forward p99=4.284ms
batch 2 baseline: enqueue p99=45.312ms forward p99=9.717ms
batch 2 candidate: enqueue p99=62.932ms forward p99=7.784ms
batch 3 baseline: enqueue p99=48.308ms forward p99=2.821ms
batch 3 candidate: enqueue p99=44.662ms forward p99=2.306ms
batch 4 baseline: enqueue p99=40.066ms forward p99=7.775ms
batch 4 candidate: enqueue p99=33.321ms forward p99=7.122ms
batch 5 baseline: enqueue p99=98.361ms forward p99=10.599ms
batch 5 candidate: enqueue p99=46.383ms forward p99=8.109ms
baseline:  warmup=10 batches=5 sends=1000 events=3000
  send-to-provider-enqueue p50=12.825ms p99=45.312ms
  per-event forward       p50=0.794ms p99=7.775ms
candidate: warmup=10 batches=5 sends=1000 events=3000
  send-to-provider-enqueue p50=12.244ms p99=44.662ms
  per-event forward       p50=0.850ms p99=7.122ms
PASS send-to-provider-enqueue: median batch p99 delta=-0.650ms, allowed=+2ms
PASS per-event forward: median batch p99 delta=-0.653ms, allowed=+2ms
```

Same-build tail variability:

| Measurement | Baseline batch p99 range, ms | Candidate batch p99 range, ms | Median p99 delta, ms |
| --- | ---: | ---: | ---: |
| Enqueue | 22.138–98.361 | 10.378–62.932 | −0.650 |
| Forward | 2.821–10.599 | 2.306–8.109 | −0.653 |

These ranges are descriptive calibration from five batches per process, not
confidence intervals. Despite substantial individual-batch variation, both
same-build median deltas remained within the fixed gate. This is one local
calibration run; five batches cannot guarantee a verdict free of host noise.

The initial single-batch run at 03:08:26 UTC recorded enqueue p50/p99 of
7.637/28.135 ms and forwarding p50/p99 of 0.977/5.643 ms. Later single-batch
enqueue p99s were 15.714 and 16.476 ms. Those historical measurements motivated
the repeated-batch method and are superseded as the comparison baseline.

Deterministic benchmark CLI tests check alternating batch order, exactly 200
sends/600 events per batch, isolated candidate and baseline tail spikes,
repeated regressions in either metric, the exact +2 ms boundary, and activation
failure before warmup. They exercise aggregation and exit codes with scripted
marks; the calibration above exercises the actual daemon and browser sockets.

## Verification

The pnpm environment flags above were exported for every pnpm invocation.
The original `pnpm build` and the review's `pnpm build:server` exited 0.
The exact remaining checks were:

```sh
pnpm check 2>&1 | tail -c 3000
pnpm lint 2>&1 | tail -c 4000
pnpm exec biome check package.json src/lib/domain/relay/Layers/relay-layer.ts src/lib/relay/project-relay-layers.ts src/lib/relay/relay-stack.ts src/lib/server/ws-rpc-handler.ts test/helpers/fake-claude-process-sdk.ts test/helpers/process-harness-server.ts test/helpers/process-harness.ts test/integration/daemon/process-harness.test.ts test/integration/daemon/process-harness-build.test.ts test/integration/daemon/send-path-benchmark.test.ts test/fixtures/send-path/process-harness.ts test/bench/send-path.ts docs/plans/2026-10-02-restart-proof-latency-baseline.md
pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/process-harness.test.ts test/integration/daemon/process-harness-build.test.ts test/integration/daemon/send-path-benchmark.test.ts
pnpm exec vitest run test/unit/effect/runtime-boundary-grep.test.ts
git diff --check
```

All checks exited 0: zero Svelte errors/warnings, 13 clean Biome-supported files,
13 passing process/CLI tests, 104 passing runtime guardrails, and no whitespace
errors. Full lint retained its existing design-token warnings and component
ownership exceptions, with zero hard/new violations. Pipeline commands used
`pipefail` so failures could not be hidden by the output cap. Process artifacts
record child exits and disposed temp roots; a separate
artifact records stale-build rejection without invoking the real-SDK tripwire.
The streamed-response test deliberately delays enqueue IPC delivery by 250 ms
and waits up to five seconds for the mark before checking its count.

On IPC parent loss, the child requests shutdown and explicitly exits after
shutdown settles. A child-local three-second deadline also exits a hung shutdown,
including parent loss during startup. Tests distinguish normal exit 0 and hung
shutdown exit 1 from a parent-issued SIGKILL. Ordinary fixture disposal retains
its SIGTERM/three-second SIGKILL fallback. The full test suite, visual suite and
live providers were outside this ticket's verification scope.

Every recorded child PID was checked absent and every recorded temp root was
checked removed.
