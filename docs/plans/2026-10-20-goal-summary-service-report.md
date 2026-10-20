# Goal summary service failure modes and evidence

Scope: conduit-test-aoqb.41, server only. All test evidence is synthetic.
The agreed seams are detector input/key generation, the relay summary service
with a fake Claude one-shot, goal RPC handlers, and the projected session feed.

## Failure modes recorded before implementation

The following are the service and handler test names, written before production code:

- `reads never generate and reopening the same blocker makes zero additional calls`
- `a changed blocker generates once and model changes invalidate the cache`
- `two concurrent opens share one model call`
- `a progress check during generation returns a stale summary under its captured key`
- `more checks on the same blocker during generation keep the result current`
- `an older generation cannot overwrite a newer goal summary`
- `summaries off reject without calling Claude and report summaryEnabled false`
- `no checks reject without calling Claude`
- `query and empty failures return short plain RPC errors and allow retry`
- `a timed out query is aborted after sixty seconds and allows retry`
- `cancelling one opener does not cancel another opener's shared generation`
- `pause, resume, completion, clearing and replacement invalidate the cached summary`
- `pause and resume between opens invalidate an otherwise unchanged active goal`
- `least recently used goal summaries are evicted after two hundred identities`
- `summaries use the recap model and daemon default Claude login`
- `goal RPCs keep missing-session and unsupported-provider guards and only generate on request`

These cover unexpected paid calls on reads/reopens, duplicate concurrent calls,
wrong identity or lifecycle reuse, stale results mislabeled as current, an older
completion replacing newer evidence, unbounded cache retention, wrong model or
account, private SDK errors reaching clients, empty text, stuck reservations after
failure/cancellation/timeout, missing cancellation of SDK work, and guard bypasses.
The pure-input and detector/projection reports record their own failure modes.

## Implementation and verification

The service is `src/lib/domain/relay/Services/goal-summary-service.ts`, composed
in `src/lib/relay/project-relay-layers.ts`. RPC handlers are in
`src/lib/server/ws-rpc/sessions.ts`; details and cached metadata share a SQL
transaction. The pure input/key module is reported separately.

The service tests first failed because its production module did not exist.
After implementation, all 16 service tests passed. The final focused command
below passed 58 tests across the input/key, service, and session RPC suites.
The input/key clock-rollback regression failed before detector-only timestamp
normalization was added. All evidence is synthetic.

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false STORYBOOK_PORT=6397 ACCEPTANCE_PORT=4397 PATH=/tmp/redesign/oc-1.19.1/node_modules/.bin:$PATH
mise exec -- pnpm exec vitest run test/unit/persistence/goal-summary-input.test.ts test/unit/persistence/goal-summary-service.test.ts test/unit/server/ws-rpc-sessions.test.ts </dev/null
```

Output was logged with a byte-capped tail and its original exit code preserved.
Scoped Biome checks passed. The parent report records final broad gates and
post-build isolated integration specs.

Independent review found an interruptible gap between reserving a key and
forking its worker. The reservation/start block is now uninterruptible, with an
explicitly interruptible worker owned by the relay scope. Follow-up review
reported no remaining material issues. Cancellation and timeout tests remain
green. This keeps concurrent request sharing without tying work to one opener.
