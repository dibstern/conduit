# Audit Synthesis R2 - 2026-05-11 Fix Daemon Effect Server Bind

**Plan audited:** `docs/plans/2026-05-11-fix-daemon-effect-server-bind.md`
**Audit method:** requested `subagent-plan-audit` flow, with one auditor per top-level task where capacity allowed.
**Auditors completed:** Tasks 1-6. Task 7 was audited locally because the agent thread limit was reached.
**Status:** Amend Plan required before execution.

## Amend Plan Findings

### 1. Removing `ctx.port` / `ctx.host` orphans `DaemonConfigRef` initialization

Task 2 removes `port` and `host` from `DaemonLifecycleContext`, but Task 1 still seeds the canonical Ref from `options.ctx.port` / `options.ctx.host` in `makeDaemonLive`. No later task replaces that source.

**Source evidence:** `src/lib/effect/daemon-layers.ts:372-377`

**Amendment:** add explicit `port` and `host` fields to `DaemonLiveOptions`, pass them from `daemon-main.ts`, and seed `makeDaemonConfigFromOptions({ port: options.port, host: options.host, ... })`.

### 2. `startHttpServer` would redirect to `:0` in TLS protocol-detection mode

The proposed Task 2 refactor changes the redirect closure from reading mutable `ctx.port` after `listen()` to reading immutable `config.port`. With `port: 0`, plain HTTP on the TLS listener redirects to `https://host:0/...`.

**Source evidence:** current dynamic path is `src/lib/daemon/daemon-lifecycle.ts:421-465`; planned snippet uses `config.port`.

**Amendment:** introduce `let actualPort = config.port`, use `actualPort` in redirect `Location` and fallback host, update it in the `listen()` callback, and add a TLS + `port: 0` redirect assertion.

### 3. `makeHttpServerLive` tests do not expose `DaemonConfigRefTag` to the assertion Effect

The planned test provides `DaemonConfigRefLive` only as a dependency of `makeHttpServerLive`, but `makeHttpServerLive` is `Layer.scopedDiscard`; it consumes the service and does not output it.

**Amendment:** build a named config-ref layer and merge/provide it so the assertion Effect can also yield `DaemonConfigRefTag`.

### 4. The plan does not prove the real `TlsCertLive -> makeHttpServerLive` handoff

The host-bind test seeds `host: "0.0.0.0"` directly and uses a null TLS layer. That proves only a pre-updated Ref is read, not that `TlsCertLive` updates host before the HTTP layer starts.

**Amendment:** add a composition test with real `TlsCertLive`, mocked `EnsureCertsTag`, `tlsEnabled: true`, `hostExplicit: false`, and `host: "127.0.0.1"`, then assert the server binds to `0.0.0.0`.

### 5. Onboarding still uses stale/null CA material

Task 4 reads `TlsCertTag` only as a boolean gate and still passes `onboardingDeps` through unchanged. In `daemon-main.ts`, those deps are initialized with `caRootPath: null` and `caCertDer: null`, so `/ca/download` remains broken after TLS load.

**Source evidence:** `src/lib/effect/daemon-main.ts:1252-1258`, `src/lib/effect/tls-cert-layer.ts:16-20`, `src/lib/daemon/daemon-lifecycle.ts:523-535`

**Amendment:** in `makeOnboardingServerLive`, call `startOnboardingServer` with `caRootPath: tls.caRootPath`, `caCertDer: tls.caCertDer`, and `staticDir: deps.staticDir`. Add a `/ca/download` regression with non-null `TlsCertTag.caCertDer`.

### 6. The onboarding race-regression test reads the wrong server handle

The planned test reads the HTTPS port from `ctx.upgradeServer.address()`. In TLS protocol-detection mode, `ctx.upgradeServer` is the inner HTTPS server; the listening socket is `ctx.httpServer`.

**Source evidence:** `src/lib/daemon/daemon-lifecycle.ts:414-448`

**Amendment:** read the bound address from `ctx.httpServer.address()` or from the updated config Ref. Keep `ctx.upgradeServer !== null` only as proof that the TLS branch exists.

### 7. Existing direct onboarding tests are omitted from the migration

Changing `startOnboardingServer(ctx, deps)` to `startOnboardingServer(ctx, deps, config)` breaks every direct caller in `test/unit/daemon/daemon-onboarding.test.ts`. The old "TLS not active" test also belongs at the Layer level after this refactor.

**Amendment:** add a Task 4 step to update `test/unit/daemon/daemon-onboarding.test.ts` and move the TLS gate assertion to `makeOnboardingServerLive`.

### 8. `SetupInfoProvider` cannot directly require `DaemonConfigRefTag` in the current router construction

Task 5 proposes `Layer.effect(SetupInfoProvider, yield* DaemonConfigRefTag)`, but `routerLayer` is constructed before `daemonRuntime = ManagedRuntime.make(makeDaemonLive(...))`. The production `DaemonConfigRefTag` is created inside `makeDaemonLive`, so the router layer has no provider at construction time.

**Source evidence:** `src/lib/effect/daemon-main.ts:1199-1240`, `src/lib/effect/daemon-main.ts:1337-1339`

**Amendment:** either create/share the config Ref before router construction, or keep `SetupInfoProvider` dependency-free and have its accessors read a runtime config snapshot after startup, like the planned `getStatus` approach. Remove or narrow the `Layer.Layer<any, never, never>` annotation so missing requirements are visible.

### 9. Task 5 misses `buildConfig()` and the returned daemon `port`

Task 5 lists `tlsEnabled` readers but misses `buildConfig()`, which persists `tls`. It also removes `port = ctx.port` without replacing `buildConfig().port` or the returned handle's `get port()` path with the Ref value. `--port 0` can remain persisted/reported as `0`.

**Source evidence:** `src/lib/effect/daemon-main.ts:424-462`, `src/lib/effect/daemon-main.ts:1345-1346`, `src/lib/effect/daemon-main.ts:1628-1631`

**Amendment:** add a config snapshot helper or Ref read path for `buildConfig()`, `getStatus()`, and `daemon.port`; specify fallback behavior before the runtime exists.

### 10. `getStatus().keepAwake` would become stale if sourced from the Ref

Task 5 changes `getStatus()` to read `keepAwake` from `DaemonConfigRef`, but current `set_keep_awake` / restart paths update the local variable and `KeepAwakeTag`, not the Ref.

**Source evidence:** `src/lib/effect/daemon-main.ts:502-532`, `src/lib/effect/daemon-main.ts:1078-1104`

**Amendment:** either keep `keepAwake` status on the existing local for this task, or update all keep-awake write paths to mutate the Ref before changing status reads.

### 11. Manual verification commands include wrong routes and invocations

Task 6 curls `/api/health`, but the router registers `/health` and `/api/status`. It also uses `pnpm conduit --stop`, but this repo has no `conduit` script; the source-tree command should go through `pnpm exec tsx src/bin/cli.ts --stop`.

**Source evidence:** `src/lib/server/effect-http-router.ts:181`, `src/lib/server/effect-http-router.ts:461`, `package.json:22`, `src/bin/cli-core.ts:228`

**Amendment:** use `/api/status` or `/health`; replace daemon stop/start commands with actual package commands; remove the inaccurate claim that `pnpm dev` includes `--restart-daemon`.

### 12. Manual smoke hardcodes machine state

Task 6 hardcodes `100.80.98.50` and assumes TLS material exists. That can report a false implementation failure when Tailscale IP or mkcert state differs.

**Amendment:** add a TLS preflight (`mkcert -CAROOT` or existing cert files) and derive `TS_IP` dynamically (`tailscale ip -4` or daemon status). Abort as environment-blocked if prerequisites are missing.

### 13. PR task has stale attribution and branch details

Task 7's generated PR body ends with a Claude Code footer even though this execution path is Codex-driven. It also pushes `fix-daemon-effect-server-bind`; Codex branch convention here defaults to `ds/` unless the user explicitly chooses otherwise.

**Amendment:** remove the Claude footer or replace it with the correct attribution for the actual authoring tool, and either use `ds/fix-daemon-effect-server-bind` or explicitly mark the non-prefixed branch as intentional.

## Additional Plan Hygiene

- Replace `pnpm grep` in Step 2.1; this repo has no `grep` script. Use `rg`.
- Do not commit the Task 2 state while `pnpm check` is knowingly red. Either combine Tasks 2-5 into one green migration commit or explicitly document that intermediate commits are allowed to be red.
- Update Task 1's composition test to use `test/unit/effect/layer-wiring.test.ts` or a new dedicated file, not `test/unit/effect/daemon-layers.test.ts`.
- Avoid `as DaemonLiveOptions` in test snippets; use the existing fixture plus `satisfies DaemonLiveOptions`.
- If Step 5.7 changes `SetupInfoProvider`, include `src/lib/server/effect-http-router.ts` and the existing setup-info route tests in the file list and commit recipe.

## Amendments Applied

| Finding | Task | Amendment |
|---|---|---|
| 1 - `ctx.port` / `ctx.host` removal orphans config init | 1 | Added explicit `port` and `host` fields to `DaemonLiveOptions`; plan now seeds `DaemonConfigRef` from `options.port` / `options.host` and passes those values from `daemon-main.ts`. |
| 2 - TLS redirect can leak `:0` | 2 | Rewrote `startHttpServer` instructions to use a server-local `actualPort` in the redirect closure and added TLS + `port: 0` redirect coverage. |
| 3 - tests cannot read consumed `DaemonConfigRefTag` | 3 | Added named config-layer guidance and required merging/providing the same config layer to the assertion Effect. |
| 4 - no real `TlsCertLive` handoff proof | 3 | Added a real `TlsCertLive` + mocked `EnsureCertsTag` handoff test proving host override reaches HTTP bind. |
| 5 - onboarding CA material stays null | 4 | Changed `makeOnboardingServerLive` instructions to pass `tls.caRootPath` and `tls.caCertDer` into `startOnboardingServer`; added `/ca/download` regression coverage. |
| 6 - onboarding test reads wrong handle | 4 | Plan now instructs tests to read the listening address from `ctx.httpServer.address()` or the Ref, not `ctx.upgradeServer.address()`. |
| 7 - direct onboarding tests omitted | 4 | Added explicit step to update `test/unit/daemon/daemon-onboarding.test.ts` and move TLS gating coverage to the Layer test. |
| 8 - `SetupInfoProvider` cannot require `DaemonConfigRefTag` | 5 | Replaced direct Tag dependency with dependency-free synchronous accessors backed by a runtime config snapshot. |
| 9 - `buildConfig()` and daemon `port` missed | 5 | Added snapshot-backed `buildConfig()`, `getStatus()`, and returned daemon `port` getter instructions, including `port: 0` assertions. |
| 10 - keep-awake status can become stale | 5 | Added migration of keep-awake write paths before switching status to snapshot/Ref reads. |
| 11 - wrong manual routes/commands | 6 | Replaced `/api/health` with `/api/status`, `pnpm conduit --stop` with `pnpm exec tsx src/bin/cli.ts --stop`, and corrected foreground start command. |
| 12 - hardcoded machine state | 6 | Added TLS prerequisite check and dynamic `TS_IP` discovery. |
| 13 - stale PR attribution/branch | 7 | Changed branch to `ds/fix-daemon-effect-server-bind` and removed Claude Code footer. |
| Plan hygiene | 1-7 | Replaced `pnpm grep` with `rg`, removed red intermediate commits by making Tasks 2-5 one commit, moved composition test to `layer-wiring.test.ts`, and removed unsafe `as DaemonLiveOptions` guidance. |

## Audit Files

- `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-1.md`
- `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-2.md`
- `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-3.md`
- `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-4-r2.md`
- `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-5.md`
- `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-6.md`

No source tests were run for this audit; this was a source-first planning review.
