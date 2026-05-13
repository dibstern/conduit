# Effect.ts Mainline Completion Progress

Phase 0 baseline captured from `/Users/dstern/.config/codex/worktrees/bb7e/conduit` on branch
`ds/effect-mainline-completion`.

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `startDaemonProcess` imported by CLI.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition.
- [x] `PersistenceLayer.open(...)` in daemon or relay production paths.
- [x] `Effect.promise(` on rejectable operations.
- [x] `concurrency: "unbounded"` on dynamic collections.
- [ ] Throwing helpers called from Effect programs.
- [ ] App-internal `Effect.runPromise` / `Effect.runSync`.

Notes:

- The baseline grep intentionally uses a broad `throw new .*Error` pattern. Later phases need to triage
  which hits are actually throwing helpers reached from Effect programs versus ordinary external-boundary
  or frontend code.
- `Layer.succeed(...)` has some legitimate test/helper-style uses. The migration target is production relay
  and daemon composition that wraps already-constructed imperative instances.

## Environment Baseline

```text
$ node --version
v22.19.0

$ pnpm --version
10.33.0
```

Dependency setup note:

```text
$ pnpm check
> conduit-code@0.1.3 check /Users/dstern/.config/codex/worktrees/bb7e/conduit
> tsgo --noEmit && tsgo --noEmit --project src/lib/frontend/tsconfig.json

sh: tsgo: command not found
ELIFECYCLE Command failed.
WARN Local package.json exists, but node_modules missing, did you mean to install?
```

The worktree did not have `node_modules`, so dependencies were installed from the existing lockfile before
capturing the real baseline:

```text
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
...
Done in 3.7s using pnpm v10.33.0
```

No package pins were relaxed.

## Baseline Grep

Command:

```bash
rg -n "startDaemonProcess|Layer\\.succeed\\(|PersistenceLayer\\.open|Effect\\.promise|concurrency: \"unbounded\"|Effect\\.run(Promise|Sync)|throw new .*Error" src
```

Output:

```text
src/lib/handlers/session.ts:217:			{ concurrency: "unbounded" },
src/bin/cli-core.ts:11:import { startDaemonProcess } from "../lib/effect/daemon-main.js";
src/bin/cli-core.ts:122:		await startDaemonProcess({
src/bin/cli-core.ts:162:		const daemon = await startDaemonProcess({
src/lib/instance/gap-endpoints.ts:70:		if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
src/lib/instance/gap-endpoints.ts:83:		if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
src/lib/relay/session-event-bridge.ts:16: * Uses Effect.runSync(PubSub.publish(...)) — safe because PubSub.sliding
src/lib/relay/session-event-bridge.ts:31:			Effect.runSync(
src/lib/relay/session-event-bridge.ts:44:			Effect.runSync(PubSub.publish(bus, event));
src/lib/daemon/project-registry.ts:187:			throw new Error(`Project "${slug}" is already registered`);
src/lib/daemon/project-registry.ts:229:			throw new Error(`Project "${slug}" is already registered`);
src/lib/daemon/project-registry.ts:243:			throw new Error(`Project "${slug}" not found`);
src/lib/daemon/project-registry.ts:246:			throw new Error(`Project "${slug}" already has a relay`);
src/lib/daemon/project-registry.ts:316:			throw new Error(`Project "${slug}" not found`);
src/lib/daemon/project-registry.ts:374:			throw new Error(`Project "${slug}" not found`);
src/lib/effect/session-status-poller.ts:294:			concurrency: "unbounded",
src/lib/effect/session-status-poller.ts:592:// above, running them via Effect.runSync/runPromise with a pre-built runtime.
src/lib/instance/sdk-factory.ts:43:				Effect.runPromise(fetchWithRetry(input, init, options.retry ?? {})));
src/lib/instance/instance-manager.ts:132:			throw new Error(`Instance "${id}" already exists`);
src/lib/instance/instance-manager.ts:135:			throw new Error(
src/lib/instance/instance-manager.ts:146:				throw new Error(`Invalid URL for instance "${id}": ${config.url}`);
src/lib/instance/instance-manager.ts:183:			throw new Error(`Instance "${id}" not found`);
src/lib/instance/instance-manager.ts:221:		if (!instance) throw new Error(`Instance "${id}" not found`);
src/lib/instance/instance-manager.ts:264:			throw new Error(`Instance "${id}" not found`);
src/lib/instance/instance-manager.ts:285:			throw new Error(`Instance "${id}" not found`);
src/lib/instance/instance-manager.ts:289:			throw new Error("Cannot start external instance");
src/lib/instance/instance-manager.ts:392:			throw new Error(`Instance "${id}" not found`);
src/lib/daemon/daemon-lifecycle.ts:351:	return Effect.runPromise(
src/lib/daemon/daemon-lifecycle.ts:782:						const decoded = await Effect.runPromise(decodeTaggedRequest(line));
src/lib/effect/monitoring-state-service.ts:29:export const SSETrackerLive: Layer.Layer<SSETrackerTag> = Layer.succeed(
src/lib/relay/sse-stream.ts:126:			await Effect.runPromise(Fiber.interrupt(this.fiber)).catch(() => {});
src/lib/relay/relay-stack.ts:262:			Layer.succeed(AuthManagerTag, this.auth),
src/lib/relay/relay-stack.ts:263:			Layer.succeed(StaticDirTag, this.staticDir),
src/lib/relay/relay-stack.ts:264:			Layer.succeed(ProjectsProvider, { getProjects }),
src/lib/relay/relay-stack.ts:265:			Layer.succeed(RemoveProjectProvider, {
src/lib/relay/relay-stack.ts:268:						if (!this.removeProject(slug)) throw new Error("Project not found");
src/lib/relay/relay-stack.ts:271:			Layer.succeed(ProjectApiDelegateProvider, {
src/lib/relay/relay-stack.ts:275:			Layer.succeed(SetupInfoProvider, {
src/lib/relay/relay-stack.ts:279:			Layer.succeed(ThemeProvider, { loadThemes: loadThemeFiles }),
src/lib/relay/relay-stack.ts:286:				Layer.succeed(PushProvider, {
src/lib/relay/relay-stack.ts:304:				Layer.succeed(CaCertProvider, {
src/lib/relay/relay-stack.ts:311:		const effectHandler = Effect.runSync(
src/lib/relay/relay-stack.ts:456:	} = Effect.runSync(
src/lib/relay/relay-stack.ts:645:	if (config.signal?.aborted) throw new Error("Relay creation aborted");
src/lib/relay/relay-stack.ts:656:			if (config.signal?.aborted) throw new Error("Relay creation aborted");
src/lib/relay/relay-stack.ts:682:	if (config.signal?.aborted) throw new Error("Relay creation aborted");
src/lib/relay/relay-stack.ts:808:	// Layer.succeed(Tag, instance). Both are merged into a single Layer tree.
src/lib/relay/relay-stack.ts:812:		Layer.succeed(OpenCodeAPITag, api),
src/lib/relay/relay-stack.ts:813:		Layer.succeed(SessionManagerTag, sessionMgr),
src/lib/relay/relay-stack.ts:814:		Layer.succeed(WebSocketHandlerTag, wsHandler),
src/lib/relay/relay-stack.ts:815:		Layer.succeed(PermissionBridgeTag, permissionBridge),
src/lib/relay/relay-stack.ts:816:		Layer.succeed(QuestionBridgeTag, questionBridge),
src/lib/relay/relay-stack.ts:817:		Layer.succeed(SessionOverridesTag, overrides),
src/lib/relay/relay-stack.ts:818:		Layer.succeed(PtyManagerTag, ptyManager),
src/lib/relay/relay-stack.ts:819:		Layer.succeed(ConfigTag, config),
src/lib/relay/relay-stack.ts:820:		Layer.succeed(LoggerTag, log),
src/lib/relay/relay-stack.ts:821:		Layer.succeed(StatusPollerTag, statusPoller),
src/lib/relay/relay-stack.ts:822:		Layer.succeed(SessionRegistryTag, registry),
src/lib/relay/relay-stack.ts:823:		Layer.succeed(PollerManagerTag, pollerManager),
src/lib/relay/relay-stack.ts:824:		Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
src/lib/relay/relay-stack.ts:825:		Layer.succeed(ForkMetaTag, forkMeta),
src/lib/relay/relay-stack.ts:826:		Layer.succeed(OrchestrationEngineTag, orchestration.engine),
src/lib/relay/relay-stack.ts:835:			Layer.succeed(ReadQueryTag, readQuery),
src/lib/relay/relay-stack.ts:841:			Layer.succeed(ClaudeEventPersistTag, claudeEventPersist),
src/lib/relay/relay-stack.ts:847:			Layer.succeed(ProviderStateServiceTag, providerStateService),
src/lib/relay/relay-stack.ts:853:			Layer.succeed(InstanceMgmtTag, instanceMgmt),
src/lib/relay/relay-stack.ts:859:			Layer.succeed(ProjectMgmtTag, projectMgmt),
src/lib/relay/relay-stack.ts:865:			Layer.succeed(ScanDepsTag, scanDeps),
src/lib/relay/relay-stack.ts:940:		Effect.runPromise(program).catch((err) => {
src/lib/relay/relay-stack.ts:1005:	if (config.signal?.aborted) throw new Error("Relay creation aborted");
src/lib/relay/relay-stack.ts:1171:		throw new Error("HTTP server not available after start()");
src/lib/relay/relay-stack.ts:1211:			throw new Error(
src/lib/relay/relay-stack.ts:1227:			throw new Error(`Relay for ${directory} is still being created`);
src/lib/instance/opencode-api.ts:132:			throw new OpenCodeConnectionError({
src/lib/instance/opencode-api.ts:147:			throw new OpenCodeApiError({
src/lib/relay/session-lifecycle-wiring.ts:234:		const existingMessages = yield* Effect.promise(() =>
src/lib/daemon/version-check.ts:173:		throw new Error(
src/lib/daemon/version-check.ts:181:		throw new Error(
src/lib/provider/claude/effect-prompt-queue.ts:47:		const queue = Effect.runSync(Queue.unbounded<SDKUserMessage>());
src/lib/provider/claude/effect-prompt-queue.ts:53:		Effect.runSync(Queue.offer(this.queue, message));
src/lib/provider/claude/effect-prompt-queue.ts:60:		const exit = Effect.runSyncExit(Queue.takeAll(this.queue));
src/lib/provider/claude/effect-prompt-queue.ts:64:		Effect.runSync(Queue.shutdown(this.queue));
src/lib/provider/claude/effect-prompt-queue.ts:81:		const exit = await Effect.runPromiseExit(Queue.take(this.queue));
src/lib/provider/claude/effect-prompt-queue.ts:99:			throw new Error(
src/lib/provider/provider-registry.ts:29:			throw new Error(`No adapter registered for provider: ${providerId}`);
src/lib/provider/orchestration-engine.ts:99:		this.processedCommands = Effect.runSync(Ref.make(new Set<string>()));
src/lib/provider/orchestration-engine.ts:115:			const isDuplicate = Effect.runSync(
src/lib/provider/orchestration-engine.ts:122:				throw new Error(`Duplicate command: ${command.commandId}`);
src/lib/provider/orchestration-engine.ts:149:				throw new Error(
src/lib/provider/orchestration-engine.ts:159:			Effect.runSync(
src/lib/provider/orchestration-engine.ts:320:		Effect.runSync(Ref.set(this.processedCommands, new Set<string>()));
src/lib/provider/orchestration-engine.ts:328:			throw new Error(`No provider bound to session: ${sessionId}`);
src/lib/server/push.ts:116:			throw new Error(
src/lib/server/push.ts:153:			throw new Error(
src/lib/server/push.ts:285:			throw new Error("VAPID keys not initialized");
src/lib/utils.ts:25:	throw new Error(`Unexpected value: ${String(value)}`);
src/lib/daemon/daemon-spawn.ts:93:		throw new Error(
src/lib/daemon/daemon-spawn.ts:144:		throw new Error("Failed to spawn daemon process");
src/lib/daemon/daemon-spawn.ts:177:		throw new Error(
src/lib/frontend/app-entry.ts:6:if (!target) throw new Error("Missing #app mount point");
src/lib/persistence/event-store.ts:68:			throw new PersistenceError({
src/lib/persistence/event-store.ts:153:			throw new PersistenceError({
src/lib/persistence/event-store.ts:170:			throw new PersistenceError({
src/lib/persistence/event-store.ts:186:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:116:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:145:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:175:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:198:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:222:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:306:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:327:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:348:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:367:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:389:			throw new PersistenceError({
src/lib/persistence/read-query-service.ts:445:			throw new PersistenceError({
src/lib/frontend/components/input/input-utils.ts:67:		throw new Error(
src/lib/frontend/components/input/input-utils.ts:76:	if (!ctx) throw new Error("Canvas 2D context unavailable");
src/lib/frontend/components/input/input-utils.ts:102:	throw new Error("Image is too large and could not be resized below 5 MB");
src/lib/frontend/stores/chat.svelte.ts:118:			throw new Error(
src/lib/frontend/stores/chat.svelte.ts:146:	throw new Error("EMPTY_MESSAGES.toolRegistry is read-only");
src/lib/frontend/stores/chat.svelte.ts:171:					throw new Error(
src/lib/frontend/stores/chat.svelte.ts:204:	if (id === "") throw new Error("getOrCreateSessionActivity: empty sessionId");
src/lib/frontend/stores/chat.svelte.ts:214:	if (id === "") throw new Error("getOrCreateSessionMessages: empty sessionId");
src/lib/frontend/stores/ws-dispatch.ts:195:			throw new Error(`routePerSession: missing sessionId on ${event.type}`);
src/lib/frontend/utils/notifications.ts:15:		throw new Error("Service workers are not supported in this browser.");
src/lib/frontend/utils/notifications.ts:52:	if (!resp.ok) throw new Error("Failed to fetch VAPID key from server");
src/lib/frontend/stories/mocks.ts:145:		"The issue is in the token refresh logic. Here's the fix:\n\n```typescript\nconst refreshToken = async () => {\n  const response = await fetch('/api/refresh', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ token: getStoredToken() }),\n  });\n  if (!response.ok) throw new Error('Refresh failed');\n  return response.json();\n};\n```\n\nThis should fix the expiry issue.",
src/lib/frontend/stories/mocks.ts:146:	html: "<p>The issue is in the token refresh logic. Here's the fix:</p>\n<pre><code class=\"language-typescript\">const refreshToken = async () =&gt; {\n  const response = await fetch('/api/refresh', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ token: getStoredToken() }),\n  });\n  if (!response.ok) throw new Error('Refresh failed');\n  return response.json();\n};\n</code></pre>\n<p>This should fix the expiry issue.</p>",
src/lib/persistence/projectors/projector.ts:26:		throw new PersistenceError({
src/lib/effect/static-file-handler.ts:37:): Layer.Layer<StaticDirTag> => Layer.succeed(StaticDirTag, staticDir);
src/lib/effect/relay-factory-layer.ts:149:							try: () => PersistenceLayer.open(dbPath),
src/lib/persistence/effect/event-store-effect.ts:85:		throw new EventStoreError({
src/lib/persistence/effect/event-store-effect.ts:96:		throw new EventStoreError({
src/lib/persistence/effect/event-store-effect.ts:104:		throw new EventStoreError({
src/lib/effect/daemon-layers.ts:91:	Effect.promise(close);
src/lib/effect/daemon-layers.ts:196:			yield* Effect.addFinalizer(() => Effect.promise(() => instance.drain()));
src/lib/effect/daemon-layers.ts:215:	).pipe(Layer.provide(Layer.succeed(PersistencePathTag, configPath)));
src/lib/effect/daemon-layers.ts:491:			: Layer.succeed(KeepAwakeTag, {
src/lib/effect/daemon-layers.ts:499:		: Layer.succeed(VersionCheckerTag, {
src/lib/effect/daemon-layers.ts:505:		: Layer.succeed(StorageMonitorTag, {
src/lib/effect/daemon-layers.ts:511:		: Layer.succeed(PortScannerTag, {
src/lib/persistence/effect/projection-runner-effect.ts:374:		throw new ProjectionRunnerError({
src/lib/persistence/projection-runner.ts:216:			throw new PersistenceError({
src/lib/persistence/projection-runner.ts:269:			throw new PersistenceError({
src/lib/persistence/projection-runner.ts:710:			throw new PersistenceError({
src/lib/persistence/projection-runner.ts:727:			throw new PersistenceError({
src/lib/persistence/projection-runner.ts:743:			throw new PersistenceError({
src/lib/effect/auth-middleware.ts:17:): Layer.Layer<AuthManagerTag> => Layer.succeed(AuthManagerTag, auth);
src/lib/effect/auth-middleware.ts:35:				const config = Effect.runSync(Ref.get(configRef));
src/lib/effect/daemon-main.ts:222://        --daemon path in cli-core.ts uses `await startDaemonProcess(...)`
src/lib/effect/daemon-main.ts:229:// NOTE: This coexists alongside the legacy startDaemonProcess. The
src/lib/effect/daemon-main.ts:231:// happens when all imperative code in startDaemonProcess is eliminated.
src/lib/effect/daemon-main.ts:246:// ─── Imperative bridge: startDaemonProcess ───────────────────────────────
src/lib/effect/daemon-main.ts:376:export async function startDaemonProcess(
src/lib/effect/daemon-main.ts:746:			const persistence = PersistenceLayer.open(dbPath);
src/lib/effect/daemon-main.ts:789:						if (!scanner) throw new Error("Scanner no longer available");
src/lib/effect/daemon-main.ts:885:		if (!entry) throw new Error(`Project "${slug}" not found`);
src/lib/effect/daemon-main.ts:1077:				throw new Error(
src/lib/effect/daemon-main.ts:1117:				throw new Error(
src/lib/effect/daemon-main.ts:1307:		Layer.succeed(AuthManagerTag, auth),
src/lib/effect/daemon-main.ts:1308:		Layer.succeed(StaticDirTag, staticDir),
src/lib/effect/daemon-main.ts:1309:		Layer.succeed(ProjectsProvider, { getProjects: getRouterProjects }),
src/lib/effect/daemon-main.ts:1310:		Layer.succeed(RemoveProjectProvider, {
src/lib/effect/daemon-main.ts:1314:		Layer.succeed(SetupInfoProvider, {
src/lib/effect/daemon-main.ts:1318:		Layer.succeed(HealthProvider, { getHealthResponse: () => getStatus() }),
src/lib/effect/daemon-main.ts:1319:		Layer.succeed(ThemeProvider, { loadThemes: loadThemeFiles }),
src/lib/effect/daemon-main.ts:1326:			Layer.succeed(PushProvider, {
src/lib/effect/daemon-main.ts:1345:	const effectHandler = Effect.runSync(
src/lib/persistence/events.ts:636:		throw new PersistenceError({
src/lib/effect/project-registry-service.ts:480:		{ concurrency: "unbounded" },
src/lib/effect/tls-cert-layer.ts:7:// vi.mock — inject controlled results via Layer.succeed(EnsureCertsTag, ...).
src/lib/effect/tls-cert-layer.ts:51:export const EnsureCertsLive = Layer.succeed(EnsureCertsTag, {
src/lib/effect/relay-layer.ts:6:// Layer.succeed(Tag, instance) in relay-stack.ts during the transition.
src/lib/effect/relay-layer.ts:36: * get them from Layer.succeed() in relay-stack.ts. Those bridge layers are
src/lib/persistence/command-receipts.ts:59:			throw new PersistenceError({
src/lib/effect/session-manager-service.ts:173:export const SessionManagerServiceLive = Layer.succeed(
```

Pattern counts from the same baseline:

| Pattern | Baseline hits |
|---|---:|
| `startDaemonProcess` | 8 |
| `Layer.succeed(` | 52 |
| `PersistenceLayer.open` | 2 |
| `Effect.promise` | 3 |
| `concurrency: "unbounded"` | 3 |
| `Effect.runPromise` / `Effect.runSync` | 22 |
| `throw new .*Error` | 86 |

## Narrow Baseline

```text
$ pnpm check
Exit: 0
Output:
> conduit-code@0.1.3 check /Users/dstern/.config/codex/worktrees/bb7e/conduit
> tsgo --noEmit && tsgo --noEmit --project src/lib/frontend/tsconfig.json
```

```text
$ pnpm lint
Exit: 0
Output:
> conduit-code@0.1.3 lint /Users/dstern/.config/codex/worktrees/bb7e/conduit
> biome check .

Checked 940 files in 229ms. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 1
Summary:
Test Files  1 failed | 344 passed (345)
Tests  2 failed | 5046 passed | 2 skipped | 12 todo (5062)
Duration  21.09s
```

Exact failing tests:

```text
FAIL  |unit| test/unit/instance/instance-manager.test.ts > InstanceManager > health checker with real OpenCode server > default health checker fails when OpenCode requires auth
TypeError: fetch failed
test/unit/instance/instance-manager.test.ts:1955:22
const noAuthRes = await fetch("http://localhost:4096/health");

Caused by: AggregateError
Error: connect ECONNREFUSED ::1:4096
Error: connect ECONNREFUSED 127.0.0.1:4096
```

```text
FAIL  |unit| test/unit/instance/instance-manager.test.ts > InstanceManager > health checker with real OpenCode server > injected auth health checker succeeds against real OpenCode
TypeError: fetch failed
test/unit/instance/instance-manager.test.ts:1988:22
const noAuthRes = await fetch("http://localhost:4096/health");

Caused by: AggregateError
Error: connect ECONNREFUSED ::1:4096
Error: connect ECONNREFUSED 127.0.0.1:4096
```

Baseline status: not green. No baseline repair was mixed into Phase 0.

## Behavior Smoke Checklist

Provider-backed behavior smoke is blocked because the expected local OpenCode endpoint is not reachable:

```text
$ curl -sS -u "opencode:$OPENCODE_SERVER_PASSWORD" http://localhost:4096/health
curl: (7) Failed to connect to localhost port 4096 after 0 ms: Couldn't connect to server
```

Daemon-only smoke was run with an isolated temp config directory and ephemeral port, so it did not touch the
user's normal daemon config or the default `2633` port.

Daemon CLI invocation used. The `--daemon` command is long-running; it ran in terminal/session A while the
status, health, and stop probes ran from terminal/session B.

```bash
tmp_dir=$(mktemp -d /tmp/conduit-smoke.XXXXXX)
CONDUIT_CONFIG_DIR="$tmp_dir" CONDUIT_PORT=0 CONDUIT_HOST=127.0.0.1 CONDUIT_TLS=0 CONDUIT_OC_URL=http://localhost:4096 pnpm exec tsx src/bin/cli.ts --daemon
CONDUIT_CONFIG_DIR="$tmp_dir" pnpm exec tsx src/bin/cli.ts --status
curl -sS "http://127.0.0.1:65272/health"
CONDUIT_CONFIG_DIR="$tmp_dir" pnpm exec tsx src/bin/cli.ts --stop
curl -sS "http://127.0.0.1:65272/health"
```

- [x] Cold daemon start, IPC status/shutdown round-trip, clean shutdown with no orphan processes.
  - Baseline observation: Pass for daemon-only path. Internal `--daemon` started with PID `42670`, `/health`
    returned `{"ok":true,...,"port":65272,"tlsEnabled":false}`, `--status` returned uptime/port/projects,
    `--stop` printed `Daemon stopped.`, the daemon process exited, and post-stop `/health` refused connection.
- [ ] Single-project chat round-trip with one provider, OpenCode or Claude.
  - Baseline observation: Not run; provider-backed smoke cannot be trusted while `localhost:4096` refuses connections.
- [ ] Daemon restart preserves an in-flight session; event store rehydrates correctly.
  - Baseline observation: Not run; requires a provider-backed in-flight session, blocked by unavailable OpenCode.
- [ ] Project relay disconnect and reconnect from a browser client.
  - Baseline observation: Not run; requires provider-backed browser session, blocked by unavailable OpenCode.
- [ ] Multi-instance: two projects active concurrently, no cross-talk.
  - Baseline observation: Not run; requires at least one reachable provider/instance, blocked by unavailable OpenCode.

Before each later phase opens a PR, rerun this checklist and record the exact daemon CLI invocation, provider,
project paths, and pass/fail observations.

## Task 1.3: Remove Unsafe Dynamic Unbounded Concurrency

Plan issue found:

- The plan suggested `daemonConfig.maxConcurrentInstances` for status correction fanout. The live
  `DaemonRuntimeConfig` has no such field, so this task uses a named module constant instead of adding a
  config field that nothing currently owns.

Changes:

- `src/lib/effect/session-status-poller.ts`: replaced unbounded status correction fanout with
  `STATUS_CORRECTION_CONCURRENCY = 8`.
- `src/lib/effect/project-registry-service.ts`: replaced unbounded `removeAll` relay invalidation fanout with
  `PROJECT_REMOVE_ALL_CONCURRENCY = 4` and `discard: true`.
- `src/lib/handlers/session.ts`: replaced the fixed four-item metadata fanout with
  `SESSION_METADATA_FANOUT = 4` and `discard: true`.
- Added regression tests that submit more work than each dynamic cap and assert all work completes while
  max observed concurrency stays within the cap.

TDD red check:

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts test/unit/relay/project-registry-effect.test.ts
Exit: 1
Expected failures:
test/unit/session/session-status-poller-effect.test.ts:
  expected 12 to be less than or equal to 8
test/unit/relay/project-registry-effect.test.ts:
  expected 7 to be less than or equal to 4
```

Verification:

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts test/unit/relay/project-registry-effect.test.ts test/unit/handlers/effect-handlers.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  107 passed (107)
```

```text
$ rg -n "concurrency: \"unbounded\"" src || true
Exit: 0
Output: <none>
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 946 files in 195ms. No fixes applied.
```

Review notes:

- Spec review: passed with no issues.
- Code quality review: initial minor found that the concurrency tests could fail by Vitest timeout if the
  implementation became too serial. Fixed by waiting only for the first work item, yielding the scheduler,
  and asserting the cap directly before releasing blocked work. Re-review passed with no issues.

## Phase 2: Composition Root, Config Persistence Slice

Plan issue found:

- The plan's CLI runtime gate snippet assumes `makeDaemonLive(options)` can be launched directly from
  `cli-core.ts` with daemon CLI options. Live code does not match that shape: `makeDaemonLive` currently needs
  `DaemonLiveOptions` built from lifecycle context, IPC context, router dependencies, and an initial runtime
  config snapshot.
- The current `WebSocketRoutingLive` is still a scoped placeholder, so exposing
  `--daemon-runtime=effect` now would create a user-visible daemon mode that is not behavior-equivalent to
  the legacy path. That would violate the plan's own "same observable behavior" contract.
- Safe Phase 2 work therefore starts with making the existing Effect layer graph own real config persistence
  without switching the process entrypoint yet.

Changes:

- `src/lib/effect/instance-manager-service.ts`: Effect instance state now preserves unmanaged external URLs
  outside `OpenCodeInstance`, matching the legacy `InstanceManager` model that keeps transport shape clean
  while still persisting custom remote URLs. Duplicate instance IDs now fail with `InstanceAlreadyExists`
  instead of overwriting state and risking stale external URLs.
- `src/lib/effect/config-persistence-layer.ts`: config persistence now writes full daemon.json snapshots via
  `ConfigSnapshotTag`. The pure Effect snapshot source builds from `DaemonConfigRef`, `ProjectRegistryTag`,
  and `InstanceManagerStateTag`; write and snapshot failures use typed errors. `ConfigPersistenceLive` exposes
  `requestSave` and `flush`, coalesces requests with a debounce queue, restores the dirty bit after writer or
  snapshot failures, and flushes any pending save when its scope closes.
- `src/lib/effect/daemon-layers.ts`: `makeDaemonLive` now provides the production config writer, a snapshot
  source, `ConfigPersistenceLive`, and `DaemonWiringLive`. The transitional `ConfigChanged` bus bridge lives in
  `DaemonWiringLive`, matching the plan rule that cross-service subscriptions belong in daemon wiring rather
  than inside unrelated services.
- `src/lib/effect/project-registry-service.ts` and `src/lib/effect/instance-manager-service.ts`: when
  `makeDaemonLive` is built with `configPath`, Effect project and instance state is seeded from the disk-loaded
  `DaemonStateTag` before the pure Effect snapshot writer can run. This prevents the future pure Effect
  entrypoint from overwriting saved projects/instances with empty transitional refs.
- `src/lib/effect/daemon-main.ts`: the current legacy hybrid daemon passes its live `buildConfig()` into
  `makeDaemonLive` as the config snapshot source, so any `ConfigChanged` event writes from the actual live
  legacy registry and instance manager instead of empty transitional Effect refs.
- `src/lib/effect/project-registry-service.ts` and `src/lib/effect/instance-manager-service.ts`: project and
  instance mutations that affect daemon.json request config persistence directly, instead of relying on the
  lossy daemon event bus as the durable signal.
- Tests assert unmanaged URL round-tripping, duplicate ID rejection, full daemon config snapshot construction,
  explicit save coalescing, finalizer flush, background retry after transient writer failure, retry-after-
  snapshot-failure, legacy `ConfigChanged` bridge wiring, disk-loaded project/instance preservation, and
  `makeDaemonLive` writing `daemon.json` from real Effect project/instance mutations.

Review correction:

- Spec review found a P1 in the first implementation: launching `ConfigPersistenceLive` while snapshotting from
  empty Effect project/instance refs could overwrite real daemon config in the legacy hybrid runtime. Fixed by
  introducing `ConfigSnapshotTag`; pure Effect mode keeps the Effect-state snapshot, while `startDaemonProcess`
  passes the live legacy `buildConfig()` snapshot until those state owners are fully migrated.
- Code quality review found another P1/P2 class of issues in the first implementation: config persistence was
  driven only by the lossy `DaemonEventBusLive`/debounce path, had no finalizer flush, tests used only synthetic
  `ConfigChanged`, duplicate instance IDs could leave stale URLs, and `ConfigSnapshotTag` leaked hidden service
  requirements. Fixed by adding `ConfigPersistenceTag`, direct mutation-triggered save requests, finalizer
  flush, duplicate rejection, and environment-capturing snapshot services.
- Code quality re-review found two more durability issues: the pure Effect default snapshot could still drop
  disk-loaded projects/instances if used before full registry rehydration, and failed background writes did not
  self-schedule a retry. Fixed by seeding registries from `DaemonStateTag` when `configPath` is provided and by
  scheduling a debounced retry after background flush failure.
- A plan issue was also corrected during implementation: the written plan's runtime-flag step is premature
  against live source because `WebSocketRoutingLive` is still a placeholder and `makeDaemonLive` does not accept
  raw CLI daemon options. No `--daemon-runtime=effect` flag was added in this slice.

TDD red check:

```text
$ pnpm vitest run test/unit/effect/instance-manager-service.test.ts
Exit: 1
Expected failures:
  expected 'http://localhost:4096' to be 'https://opencode.example.test'
  yield* getPersistedInstanceConfigs is not iterable
```

```text
$ pnpm vitest run test/unit/effect/config-persistence-layer.test.ts
Exit: 1
Expected failure:
  yield* buildDaemonConfigSnapshot is not iterable
```

Verification:

```text
$ pnpm vitest run test/unit/effect/instance-manager-service.test.ts test/unit/effect/config-persistence-layer.test.ts test/unit/effect/layer-wiring.test.ts test/unit/relay/project-registry-effect.test.ts test/unit/effect/scoped-fiber-layers.test.ts test/unit/instance/instance-manager-effect.test.ts test/unit/instance/instance-manager-health.test.ts test/unit/daemon/project-registry-service.test.ts
Exit: 0
Test Files  8 passed (8)
Tests  129 passed (129)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 942 files in 190ms. No fixes applied.
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  345 passed (345)
Tests  5068 passed | 2 skipped | 12 todo (5082)
```

## Phase 3: WS Upgrade Routing Slice

Plan issues found:

- `WebSocketRoutingLive` could not attach behavior as written because `HttpServerRefTag` was never populated
  by the lifecycle server. The HTTP lifecycle layer now writes `ctx.upgradeServer ?? ctx.httpServer` into the
  shared ref after startup and clears it on shutdown.
- The existing `relayFactory` in `daemon-main.ts` is still a temporary dummy for the Effect relay cache, so
  routing WS upgrades through `RelayCacheTag` would have looked Effect-native while dropping the real project
  relay behavior. The slice instead introduces a typed `WebSocketRelayRouterTag` and requires `makeDaemonLive`
  callers to provide it explicitly. The legacy daemon provides the router from its live `ProjectRegistry`
  until Phase 4 migrates relay ownership.
- `makeDaemonLive` intentionally has no hidden fallback WS router. Tests provide explicit failing test routers;
  production `startDaemonProcess` provides the real registry-backed router.

Changes:

- `src/lib/effect/ws-routing-layer.ts`: replaced the placeholder layer with a scoped `upgrade` listener. The
  Node callback immediately hands off to a program run on the captured Effect runtime, validates `/p/<slug>/ws`,
  applies cookie/PIN auth, checks `DaemonConfigRef.shuttingDown`, waits for the real project relay, and writes
  `503 Service Unavailable` for relay readiness failures. The layer now fails fast if composed before the HTTP
  server ref is populated; it does not install a silent no-op listener.
- `src/lib/effect/daemon-layers.ts`: `makeHttpServerLive` now populates `HttpServerRefTag`, and
  `DaemonLiveOptions` now requires a typed `wsRelayRouter`.
- `src/lib/effect/daemon-main.ts`: removed the imperative WS upgrade listener. The legacy hybrid daemon now
  passes a typed registry-backed router into `makeDaemonLive`; `stop()` marks `DaemonConfigRef.shuttingDown`
  before draining.
- Tests cover successful relay delegation, invalid path rejection, auth rejection before relay startup, relay
  failure `503`, scoped listener cleanup, shutdown rejection, server-ref population, and composed layer wiring.
- Review correction: shutdown was initially checked after `ensureRelayStarted`/`waitForRelay`, which could
  lazy-start or wait on a relay during daemon shutdown. The handler now checks `DaemonConfigRef.shuttingDown`
  before relay startup, and the shutdown test asserts the router methods are not called.

TDD red check:

```text
$ pnpm vitest run test/unit/effect/ws-routing-layer.test.ts
Exit: 1
Expected failures:
  expected ensureRelayStarted to have been called with "test-project"
  expected socket.destroy to have been called for invalid/auth/shutdown paths
  expected socket.write to have been called with "HTTP/1.1 503 Service Unavailable\r\n\r\n"
  expected upgrade listener count to be before + 1
```

Verification:

```text
$ pnpm vitest run test/unit/effect/ws-routing-layer.test.ts test/unit/effect/scoped-fiber-layers.test.ts test/unit/effect/layer-wiring.test.ts test/unit/effect/http-server-live.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  54 passed (54)
```

```text
$ pnpm vitest run --config vitest.integration.config.ts test/integration/daemon/daemon-server.test.ts
Exit: 1
Relevant WS tests passed. The file failed only because the local OpenCode health test tried
http://localhost:4096/health and got ECONNREFUSED.
```

```text
$ pnpm vitest run --config vitest.integration.config.ts test/integration/daemon/daemon-server.test.ts -t "Daemon WS upgrade"
Exit: 0
Test Files  1 passed (1)
Tests  4 passed | 3 skipped (7)
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:integration
Exit: 0
Test Files  24 passed (24)
Tests  127 passed | 1 skipped (128)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 943 files in 208ms. No fixes applied.
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  346 passed (346)
Tests  5074 passed | 2 skipped | 12 todo (5088)
```

## Phase 3: HTTP Route Slice Audit

Plan issue found:

- The Phase 3 transition list assumes there is still a production `RequestRouter` serving `/health`, `/info`,
  `/setup`, auth, static, and `/p/<slug>` routes. Live source no longer has `src/lib/server/http-router.ts` or a
  `RequestRouter` production path; `daemon-main.ts` and `relay-stack.ts` already build handlers from
  `effectRouterWithCors`. The stale text was in comments, not active routing.

Changes:

- `src/lib/server/effect-http-router.ts`: updated the module header to reflect that this is now the production
  HTTP route graph for daemon and relay server modes.

Verification:

```text
$ pnpm vitest run test/unit/server/effect-http-router.test.ts test/unit/server/effect-http-router-production.test.ts test/unit/server/http-server-layer.test.ts
Exit: 0
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  346 passed (346)
Tests  5084 passed | 2 skipped | 12 todo (5098)
```

## Phase 4: Relay Cache Async Stop Slice

Plan issue found:

- `RelayCache` already used `ScopedRef`, but its finalizer wrapped `relay.stop()` in `Effect.sync`. Because
  production `ProjectRelay.stop()` is async, invalidating a relay or closing the cache scope could return before
  relay drains, runtime disposal, PTY cleanup, and WebSocket shutdown completed. That looked scope-owned while
  still leaking asynchronous cleanup outside the scope.

Changes:

- `src/lib/effect/relay-cache.ts`: widened the relay finalizer contract to `void | Promise<void>`, added typed
  `RelayStopError`, and now awaits `relay.stop()` via `Effect.tryPromise` inside the scoped finalizer. Finalizer
  failures are logged and do not make scope close fail.
- `test/unit/relay/relay-cache.test.ts`: added regression coverage proving both `cache.invalidate(slug)` and
  cache scope closure wait for async relay stop promises before returning. Review follow-up tightened test
  cleanup so failed assertions cannot strand mock stop promises, and added coverage that rejected stops are
  logged and swallowed by cache invalidation.

TDD red check:

```text
$ pnpm vitest run test/unit/relay/relay-cache.test.ts
Exit: 1
Expected failures:
  expected false to be true in "invalidate awaits an async relay stop before returning"
  expected false to be true in "scope close awaits async relay stop finalizers"
```

Verification:

```text
$ pnpm vitest run test/unit/relay/relay-cache.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  8 passed (8)
```

```text
$ pnpm vitest run test/unit/relay/relay-cache.test.ts test/unit/daemon/project-registry-service.test.ts test/unit/relay/project-registry-effect.test.ts test/unit/daemon/daemon-layers.test.ts test/unit/daemon/full-layer-composition.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  61 passed (61)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
First run exit: 1
Observed one unrelated/order-sensitive failure:
  test/unit/server/http-server-layer.test.ts > HTTP Server Layer > health endpoint responds via real HTTP server
  expected 302 to be 200

$ pnpm vitest run test/unit/server/http-server-layer.test.ts -t "health endpoint responds via real HTTP server"
Exit: 0

$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  346 passed (346)
Tests  5077 passed | 2 skipped | 12 todo (5091)
```

## Phase 4: SSE Disconnect Cleanup Slice

Plan issue found:

- `SSEStream.disconnect()` aborted the SDK stream and interrupted its Effect fiber, but the `Effect.async`
  boundary did not provide an interrupt finalizer. `Fiber.interrupt` could complete before the async generator's
  `finally` cleanup finished, so relay shutdown could move on before the SSE source had actually released its
  in-flight resources.
- Code-quality review found the longer teardown window also opened a reconnect race: a new `connect()` could
  start while the old `disconnect()` was awaiting cleanup, then the old disconnect could clear the new fiber
  handle or let stale generator completion mutate connection state.
- Follow-up self-review found the lifecycle sentinel must be set before abort dispatch, because `AbortController`
  listeners run synchronously and can re-enter `connect()` during disconnect.
- Code-quality re-review found `disconnect()`, `connect()`, `disconnect()` could leave a queued reconnect running
  after the later disconnect completed. The lifecycle now records caller intent with a serialized queue and
  generation counter, so the last connect/disconnect intent wins.

Changes:

- `src/lib/relay/sse-stream.ts`: the SDK stream consume effect now returns an interrupt finalizer that aborts
  the active SSE `AbortController` and awaits the in-flight consume promise before interruption completes.
- `src/lib/relay/sse-stream.ts`: `connect()` now waits for any in-flight disconnect before launching a new fiber,
  and connect/disconnect calls are serialized through a lifecycle queue with a generation counter.
- `test/unit/relay/sse-stream.test.ts`: added regression coverage proving `disconnect()` does not settle until
  the async generator cleanup finishes after abort, and proving reconnect waits behind pending disconnect cleanup.
  The tests also cover abort-listener reentrancy and a later disconnect canceling a queued reconnect.

TDD red check:

```text
$ pnpm vitest run test/unit/relay/sse-stream.test.ts -t "disconnect waits"
Exit: 1
Expected failure:
  expected true to be false in "disconnect waits for async generator cleanup after abort"
```

Verification:

```text
$ pnpm vitest run test/unit/relay/sse-stream.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  16 passed (16)
```

```text
$ pnpm vitest run test/unit/relay/sse-stream.test.ts \
  test/unit/relay/sse-stream-effect.test.ts \
  test/unit/relay/sse-wiring.test.ts \
  test/unit/relay/race-sse-rehydration.test.ts \
  test/unit/relay/status-poller-broadcast.test.ts \
  test/unit/relay/permission-rehydration-wiring.test.ts \
  test/unit/relay/per-tab-routing-e2e.test.ts
Exit: 0
Test Files  7 passed (7)
Tests  90 passed (90)
```

```text
$ pnpm check
Exit: 0

$ pnpm lint
Exit: 0

$ git diff --check
Exit: 0
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  346 passed (346)
Tests  5081 passed | 2 skipped | 12 todo (5095)
```

## Phase 4: Session Event Bridge Scoped Stream Slice

Plan issue found:

- `src/lib/relay/session-event-bridge.ts` still used `Effect.runSync(PubSub.publish(...))` inside EventEmitter
  callbacks. The call was operationally safe with `PubSub.sliding`, but it violated the Phase 4 rule against
  app-internal `Effect.runPromise` / `Effect.runSync` bridge escapes.
- Converting the bridge to a forked stream exposed an ordering requirement: the layer must not finish building
  before the EventEmitter listeners are registered, or synchronous session events emitted immediately after
  construction can be lost.

Changes:

- `src/lib/relay/session-event-bridge.ts`: replaced callback-local `Effect.runSync` publishing with a scoped
  `Stream.asyncPush` callback bridge and a scoped stream consumer that publishes to `DaemonEventBus`.
- `src/lib/relay/session-event-bridge.ts`: layer construction now awaits listener registration before returning,
  preserving the old synchronous-listener readiness contract.
- `test/unit/effect/session-event-bridge.test.ts`: added a static bridge-exit gate for `Effect.runSync`, scoped
  listener cleanup coverage, and synchronous burst-order coverage.

TDD red check:

```text
$ pnpm vitest run test/unit/effect/session-event-bridge.test.ts
Exit: 1
Expected failure:
  expected session-event-bridge.ts not to contain 'Effect.runSync'
```

Verification:

```text
$ pnpm vitest run test/unit/effect/session-event-bridge.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  6 passed (6)
```

```text
$ pnpm vitest run test/unit/effect/session-event-bridge.test.ts \
  test/unit/effect/session-lifecycle-wiring.test.ts
Exit: 0
Test Files  2 passed (2)
Tests  13 passed (13)
```

```text
$ rg -n "Effect\\.run(Promise|Sync)" src/lib/relay/session-event-bridge.ts
Exit: 1
No output.
```

```text
$ pnpm check
Exit: 0

$ pnpm lint
Exit: 0
```

## Phase 4: WebSocket Message Dispatch Ownership Slice

Plan issue found:

- `src/lib/relay/relay-stack.ts` still owned WebSocket message dispatch imperatively: it synchronously ran the
  rate-limit check, special-cased log-level messages, created per-client semaphores through a global server
  module, wrapped `dispatchMessageEffect(...)` in `Effect.tryPromise`, and launched that wrapper with app-internal
  `Effect.runPromise(...)`.
- The old `test/unit/effect/client-message-serialization.test.ts` and
  `test/unit/server/client-message-queue.test.ts` mostly proved raw semaphore/global-map behavior rather than
  the relay dispatch boundary. They were not strong enough to prevent the bridge from remaining in production.

Changes:

- `src/lib/effect/client-message-serialization.ts`: added a scoped `ClientMessageSerializationTag` backed by a
  per-layer `SynchronizedRef<HashMap<string, Semaphore>>`.
- `src/lib/relay/ws-message-dispatch-effect.ts`: added the Effect-owned WebSocket dispatch boundary for rate
  limiting, `set_log_level`, per-client serialization, default `dispatchMessageEffect(...)`, and
  `HANDLER_ERROR` rendering.
- `src/lib/relay/relay-stack.ts`: reduced the WebSocket callback to `relayManagedRuntime.runFork(...)` and moved
  client disconnect cleanup into the Effect serialization service.
- Deleted `src/lib/server/client-semaphore.ts` and the duplicate server queue test.

TDD red check:

```text
$ pnpm vitest run test/unit/effect/client-message-serialization.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 1
Expected failures:
  Cannot find module '../../../src/lib/effect/client-message-serialization.js'
```

```text
$ pnpm vitest run test/unit/relay/ws-message-dispatch-effect.test.ts -t "pure dispatch interruption"
Exit: 1
Expected failure:
  expected 'Success' to be 'Failure'
```

Verification:

```text
$ pnpm vitest run test/unit/effect/client-message-serialization.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts \
  test/unit/handlers/dispatch-effect.test.ts \
  test/unit/relay
Exit: 0
Test Files  40 passed (40)
Tests  528 passed (528)
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  346 passed (346)
Tests  5081 passed | 2 skipped | 12 todo (5095)
```

```text
$ pnpm check
Exit: 0

$ pnpm lint
Exit: 0

$ git diff --check
Exit: 0

$ rg "client-semaphore|getClientSemaphore|client-message-queue" -n src test
Exit: 1
No output.
```

## Phase 4: Status Poller Runtime Ownership Slice

Plan issue found:

- `src/lib/relay/relay-stack.ts` still created a second `ManagedRuntime` for the status poller, even though
  `RelayStateLive` already owns `PollerStateTag` and `PollerPubSubTag`. That split meant Effect consumers inside
  the relay runtime could observe different poller state from `statusPoller.getCurrentStatuses()`.
- The direct fix could not simply pass `relayManagedRuntime` at construction time because `wireMonitoring()` calls
  `statusPoller.on()` and `statusPoller.start()` before the full relay runtime exists.
- Code review also found a shutdown race: a late status-poller publish could evaluate monitoring after SSE had
  disconnected and restart message pollers after `pollerManager.drain()`.

Changes:

- `src/lib/effect/session-status-poller.ts`: added a deferred status-poller runtime adapter. `on()` and `start()`
  can be registered before attach, but actual subscription and polling work waits for the relay runtime.
- `src/lib/relay/relay-stack.ts`: removed the separate poller runtime, validates `PollerStateTag` /
  `PollerPubSubTag` on the main relay runtime, attaches the deferred runtime, wires pollers, then connects SSE.
- `src/lib/relay/monitoring-wiring.ts`: added `stopMonitoring()` and guards both status callbacks and async
  message-poller seed completion so relay shutdown cannot start pollers after draining begins.
- `test/unit/session/session-status-poller-service.test.ts`: covers deferred registration/start and drain-before-attach.
- `test/unit/relay/status-poller-broadcast.test.ts`: verifies `relay.effectRuntime` sees the same
  `PollerStateTag` state used by `relay.isAnySessionProcessing()`.
- `test/unit/relay/monitoring-wiring.test.ts`: covers the shutdown gate and the async seed-completion race.

TDD red checks:

```text
$ pnpm vitest run test/unit/session/session-status-poller-service.test.ts \
  test/unit/relay/status-poller-broadcast.test.ts
Exit: 1
Expected failures:
  makeDeferredStatusPollerRuntime is not a function
  expected relay runtime status undefined to be busy
```

```text
$ pnpm vitest run test/unit/relay/monitoring-wiring.test.ts
Exit: 1
Expected failure:
  harness.result.stopMonitoring is not a function
```

Review:

- Spec review: approved, with no concrete issues.
- Lifecycle/code review: found the shutdown race above and requested non-silent subscription failures / tag
  validation. The patch now stops monitoring during shutdown, reports non-interruption subscription failures, and
  validates poller tags before SSE can connect.

Verification:

```text
$ pnpm vitest run test/unit/relay/monitoring-wiring.test.ts \
  test/unit/session/session-status-poller-service.test.ts \
  test/unit/relay/status-poller-broadcast.test.ts \
  test/unit/session/session-status-poller-effect.test.ts \
  test/unit/effect/relay-stack-layers.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  21 passed (21)
```

```text
$ pnpm check
Exit: 0

$ pnpm lint
Exit: 0
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  348 passed (348)
Tests  5086 passed | 2 skipped | 12 todo (5100)
```

```text
$ pnpm vitest run --config vitest.integration.config.ts \
  test/integration/relay/sse-aware-poller-gating.test.ts \
  test/integration/flows/relay-lifecycle.integration.ts \
  test/integration/flows/sse-to-ws-pipeline.integration.ts \
  test/integration/flows/message-lifecycle.integration.ts
Exit: 0
Test Files  4 passed (4)
Tests  29 passed (29)
```

```text
$ pnpm test:integration
Exit: 1
Blocked by external local dependency:
  test/integration/daemon/daemon-server.test.ts > health checker authenticates with real OpenCode server
  TypeError: fetch failed
  connect ECONNREFUSED ::1:4096 / 127.0.0.1:4096
```

## Phase 1.2: Effect Persistence Typed Validation Slice

Plan issue found:

- Phase 1.2 was partly stale in this worktree. The shared Effect row decoder already existed in
  `src/lib/persistence/effect/stored-event-row.ts` and already lifted both `data` and `metadata` JSON parsing
  plus `StoredEventSchema` validation into typed Effect failures.
- The real remaining Effect-store defect was `EventStoreEffect.append(...)` calling the throwing
  `validateEventPayload(event)` helper before writing. That throw escaped the typed error channel as a fiber
  defect.
- No new `StoredEventSchema` was added; the implementation reuses the existing canonical event schema.

Changes:

- `src/lib/persistence/effect/event-store-effect.ts`: replaced the throwing append validation path with
  `Schema.decodeUnknown(CanonicalEventSchema)` mapped to `EventStoreError` with operation
  `validateCanonicalEvent`.
- `test/unit/persistence/projectors-effect.test.ts`: added append invalid-payload coverage, invalid
  `metadata` JSON coverage, and projection-runner replay invalid-shape coverage.
- Review fixes:
  - Validation now returns typed success/failure only and persists the original event data/metadata so Effect
    Schema decoding cannot silently strip extra provider fields.
  - `decodeStoredEventRow(...)` now validates with `StoredEventSchema` but returns the parsed original event
    object, so callers receive the same provider-specific extra fields that were stored.
  - `appendBatch` snapshots and restores `versionCache` on any failed exit, including typed errors and defects,
    so a rolled-back batch cannot advance the next stream version in memory.
  - `ProjectionRunnerEffect.recover()` now uses `Effect.ensuring(...)` instead of JS `finally`, so `replaying`
    is reset after typed Effect failures.

TDD red check:

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts
Exit: 1
Expected failure:
  append invalid payload escaped as (FiberFailure) PersistenceError:
  Event session.created missing required fields: title
```

Verification:

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  37 passed (37)
```

## Phase 4: Fork Metadata Bridge Removal Slice

Plan issue found:

- `ForkMetaTag` was not a real independent dependency. `relay-stack.ts` built it by delegating directly to
  `SessionManager`, and `SessionManager` is the owner that persists fork metadata to disk. A derived bridge
  layer would only move the redundancy; the long-term fix is deleting the tag and using `SessionManagerTag`
  directly.
- The Phase 4 plan text that says `src/lib/effect/relay-layer.ts` should be deleted is stale. Live source still
  uses it as the real `RelayStateLive` composition module.

Changes:

- `src/lib/handlers/session.ts`: `handleForkSession` now persists fork metadata through
  `SessionManagerTag.setForkEntry(...)`.
- `src/lib/effect/services.ts`, `src/lib/handlers/types.ts`, `src/lib/relay/relay-stack.ts`, and
  `test/helpers/mock-factories.ts`: removed `ForkMetaShape`, `ForkMetaTag`, `HandlerDeps.forkMeta`, the relay
  `forkMeta` adapter, and test-layer provisioning for the deleted bridge.
- `test/unit/handlers/effect-handlers.test.ts`: added direct Effect handler coverage for explicit-message
  forks, whole-session fork fallback metadata, the no-active-session no-op path, and the outgoing
  `session_forked`, `session_switched`, and `status` envelopes.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts --testNamePattern handleForkSession
Exit: 1
Expected failure:
  Service not found: ForkMeta
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts \
  test/unit/effect/services.test.ts \
  test/unit/effect/relay-stack-layers.test.ts \
  test/unit/mock-factories.test.ts \
  test/unit/persistence/projectors-effect.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  131 passed (131)
```

```text
$ rg -n "Layer\.succeed\(ForkMetaTag|ForkMetaTag|ForkMetaShape|forkMeta:" \
  src/lib test/helpers test/unit --glob '!test/e2e/fixtures/**'
Exit: 0
Output:
src/lib/session/session-manager.ts:87:	private forkMeta: Map<string, ForkEntry>;
test/unit/session/session-manager-effect.test.ts:94:				forkMeta: HashMap.make([
src/lib/effect/session-manager-state.ts:22: * - forkMeta: per-session fork-point metadata
src/lib/effect/session-manager-state.ts:29:	forkMeta: HashMap.HashMap<string, ForkEntry>;
src/lib/effect/session-manager-state.ts:40:	forkMeta: HashMap.empty(),
```

The remaining `forkMeta` hits are the actual `SessionManager` storage/state, not the deleted relay bridge.

```text
$ rg -n "Effect\.promise\(" src
Exit: 1
No output.

$ rg -n "concurrency: \"unbounded\"" src
Exit: 1
No output.
```

```text
$ pnpm check
Exit: 0

$ pnpm lint
Exit: 0
Checked 946 files in 207ms. No fixes applied.
```

```text
$ env -u OPENCODE_SERVER_PASSWORD pnpm test:unit
Exit: 0
Test Files  348 passed (348)
Tests  5095 passed | 2 skipped | 12 todo (5109)
```

```text
$ pnpm test:e2e -- test/e2e/specs/fork-session.spec.ts
Exit: 0
Build: passed
Playwright: 5 passed
```

## Phase 5.0: Persistence Schema Migration Foundation Slice

Plan issues found:

- The plan's "add a migration runner" step was partly stale: a runner already existed, but it tracked only
  `_migrations(id, name, applied_at)`, stored migrations as TypeScript functions, and had no checksum mismatch
  protection.
- The existing Effect persistence service was not production-compatible. It created a toy
  `events(id, type, session_id, payload, created_at)` table while `EventStoreEffect` writes the real event-store
  shape: `event_id`, `session_id`, `stream_version`, `data`, `metadata`, `provider`, and `created_at`.
- The projectors Effect tests had their own hand-written schema copy, which omitted production tables and indexes.
  That let Effect persistence tests drift away from the real SQLite schema.
- The `PersistenceLayer.open(...)` guardrail remains intentionally open in this slice. Per the plan, production
  consumers must not switch until the migration story has shipped and been observed.

Changes:

- `src/lib/persistence/migrations/0001_current_event_store.sql`: added the forward-only SQL migration file and
  made it the schema authority.
- `src/lib/persistence/schema.ts`: now reads the SQL migration file instead of duplicating DDL in TypeScript.
- `src/lib/persistence/migrations.ts`: migration rows now record SHA-256 checksums, refuse missing/renamed/edited
  applied migrations, enforce contiguous migration ids, run pending migrations transactionally, and backfill
  checksums for legacy `_migrations` rows in the same transaction that validates that the current database still
  contains the schema objects created by the baseline SQL migration.
- `src/lib/effect/persistence-service.ts`: `makePersistenceServiceLive` now runs the real production migrations at
  layer startup and exposes an idempotent `migrate` method backed by the same runner.
- `test/unit/persistence/projectors-effect.test.ts`: removed the local schema string and uses the same migration
  runner as production against a file-backed SQLite database.
- `test/unit/persistence/persistence-effect.test.ts`: added startup-failure coverage for edited checksums,
  unsafe legacy checksum backfills, accidental `:memory:` Effect SQLite layers, and readonly Effect SQLite
  layers.
- `package.json`: `copy:assets` now copies `src/lib/persistence/migrations` into `dist/src/lib/persistence`, so
  compiled production code can still read the SQL file beside `schema.js`.
- `AGENTS.md`: removed the stale fixed `localhost:4096` development assumption and documented provider-SDK
  debugging for OpenCode and Claude.
- `test/unit/instance/instance-manager.test.ts`: live OpenCode auth checks now require an explicit reachable
  `OPENCODE_URL` / `OPENCODE_BASE_URL` instead of assuming `OPENCODE_SERVER_PASSWORD` implies
  `localhost:4096` is listening.

Existing SQLite schema inventory from a copied production DB
(`/Users/dstern/src/personal/conduit/.conduit/events.db`, copied with `VACUUM INTO`):

| table | columns |
|---|---|
| `_migrations` | `id:INTEGER pk`, `name:TEXT notnull`, `applied_at:INTEGER notnull` |
| `activities` | `id:TEXT pk`, `session_id:TEXT notnull`, `turn_id:TEXT`, `tone:TEXT notnull`, `kind:TEXT notnull`, `summary:TEXT notnull`, `payload:TEXT notnull default='{}'`, `sequence:INTEGER`, `created_at:INTEGER notnull` |
| `command_receipts` | `command_id:TEXT pk`, `session_id:TEXT notnull`, `status:TEXT notnull`, `result_sequence:INTEGER`, `error:TEXT`, `created_at:INTEGER notnull` |
| `events` | `sequence:INTEGER pk`, `event_id:TEXT notnull`, `session_id:TEXT notnull`, `stream_version:INTEGER notnull`, `type:TEXT notnull`, `data:TEXT notnull`, `metadata:TEXT notnull default='{}'`, `provider:TEXT notnull`, `created_at:INTEGER notnull` |
| `message_parts` | `id:TEXT pk`, `message_id:TEXT notnull`, `type:TEXT notnull`, `text:TEXT notnull default=''`, `tool_name:TEXT`, `call_id:TEXT`, `input:TEXT`, `result:TEXT`, `duration:REAL`, `status:TEXT`, `sort_order:INTEGER notnull`, `created_at:INTEGER notnull`, `updated_at:INTEGER notnull` |
| `messages` | `id:TEXT pk`, `session_id:TEXT notnull`, `turn_id:TEXT`, `role:TEXT notnull`, `text:TEXT notnull default=''`, `cost:REAL`, `tokens_in:INTEGER`, `tokens_out:INTEGER`, `tokens_cache_read:INTEGER`, `tokens_cache_write:INTEGER`, `is_streaming:INTEGER notnull default=0`, `is_inherited:INTEGER notnull default=0`, `last_applied_seq:INTEGER`, `created_at:INTEGER notnull`, `updated_at:INTEGER notnull` |
| `pending_approvals` | `id:TEXT pk`, `session_id:TEXT notnull`, `turn_id:TEXT`, `type:TEXT notnull`, `status:TEXT notnull default='pending'`, `tool_name:TEXT`, `input:TEXT`, `decision:TEXT`, `always:TEXT`, `created_at:INTEGER notnull`, `resolved_at:INTEGER` |
| `projector_cursors` | `projector_name:TEXT pk`, `last_applied_seq:INTEGER notnull`, `updated_at:INTEGER notnull` |
| `provider_state` | `session_id:TEXT notnull pk`, `key:TEXT notnull pk`, `value:TEXT notnull` |
| `session_providers` | `id:TEXT pk`, `session_id:TEXT notnull`, `provider:TEXT notnull`, `provider_sid:TEXT`, `status:TEXT notnull default='active'`, `activated_at:INTEGER notnull`, `deactivated_at:INTEGER` |
| `sessions` | `id:TEXT pk`, `provider:TEXT notnull`, `provider_sid:TEXT`, `title:TEXT notnull default='Untitled'`, `status:TEXT notnull default='idle'`, `parent_id:TEXT`, `fork_point_event:TEXT`, `last_message_at:INTEGER`, `created_at:INTEGER notnull`, `updated_at:INTEGER notnull` |
| `tool_content` | `tool_id:TEXT pk`, `session_id:TEXT notnull`, `content:TEXT notnull`, `created_at:INTEGER notnull` |
| `turns` | `id:TEXT pk`, `session_id:TEXT notnull`, `state:TEXT notnull default='pending'`, `user_message_id:TEXT`, `assistant_message_id:TEXT`, `cost:REAL`, `tokens_in:INTEGER`, `tokens_out:INTEGER`, `requested_at:INTEGER notnull`, `started_at:INTEGER`, `completed_at:INTEGER` |

Schema comparison:

- The current SQL migration matches the copied production table and index inventory.
- The only migration metadata diff is intentional: `_migrations` gains a `checksum TEXT NOT NULL DEFAULT ''`
  column. Existing row `1/create_event_store_tables` is treated as the already-applied baseline and gets the
  checksum backfilled.
- The Effect persistence service no longer has a separate schema expectation; it uses the same SQL file.
- The Effect migration runner delegates to the sync SQLite migration engine on the same database file. This keeps
  `db.exec(...)` script semantics for multi-statement migrations instead of splitting SQL manually.
- `:memory:` Effect SQLite layers now fail fast because the sync migration connection would otherwise open a
  separate in-memory database.
- Readonly Effect SQLite layers now fail fast because the migration runner must be allowed to create tables,
  record migration rows, and backfill legacy checksums.

Index inventory covered by `test/unit/persistence/schema.test.ts`:

| table | indexes |
|---|---|
| `activities` | `idx_activities_session_created`, `idx_activities_session_kind`, `idx_activities_tone`, `idx_activities_turn` |
| `command_receipts` | `idx_command_receipts_session` |
| `events` | `idx_events_session_seq`, `idx_events_session_version` unique, `idx_events_type` |
| `message_parts` | `idx_message_parts_message` |
| `messages` | `idx_messages_session_created`, `idx_messages_turn` |
| `pending_approvals` | `idx_pending_approvals_pending`, `idx_pending_approvals_session_status` |
| `session_providers` | `idx_session_providers_active`, `idx_session_providers_session` |
| `sessions` | `idx_sessions_parent`, `idx_sessions_provider`, `idx_sessions_updated` |
| `tool_content` | `idx_tool_content_session` |
| `turns` | `idx_turns_assistant_message`, `idx_turns_session_requested` |

Constraint inventory covered by the SQL baseline and schema tests:

- Primary keys, foreign keys, and the unique `events.event_id` / `(session_id, stream_version)` constraints match
  the production schema.
- CHECK constraints are preserved for `sessions.status`, `turns.state`, `messages.role`, `message_parts.type`,
  `pending_approvals.type`, and `pending_approvals.status`.

Dry-run on copied production DB:

```text
Source: /Users/dstern/src/personal/conduit/.conduit/events.db
Copy method: SQLite VACUUM INTO a temp-file copy
Applied migrations: []
Before migration rows: [{ id: 1, name: "create_event_store_tables" }]
After migration rows:
  [{ id: 1, name: "create_event_store_tables",
     checksum: "b4379c0b4631c149b4ffa201e92341150395475e3d1c386e227a77e616a24613" }]
```

Before/after row counts were unchanged:

```text
activities=619
command_receipts=0
events=1685
message_parts=261
messages=220
pending_approvals=0
projector_cursors=6
provider_state=9
session_providers=10
sessions=10
tool_content=0
turns=15
```

Rollback procedure:

- Migrations are forward-only. Rollback means stop the daemon, restore the pre-upgrade `.conduit/events.db`
  backup (and its `-wal` / `-shm` siblings if present), then restart.
- If an already-applied migration file is edited, renamed, deleted, or checksum-mismatched, startup must fail
  instead of silently continuing. The new runner enforces this before applying pending migrations.

TDD red check:

```text
$ pnpm vitest run test/unit/persistence/migrations.test.ts
Exit: 1
Expected failures:
  migration.up is not a function
  no such column: checksum
```

```text
$ pnpm vitest run test/unit/persistence/persistence-effect.test.ts
Exit: 1
Expected failures:
  startup migration creates the production event-store schema: expected [] to deeply equal [tables...]
  evictBefore deletes old events: no such table: sessions
```

```text
$ pnpm vitest run test/unit/persistence/migrations.test.ts --testNamePattern "legacy checksum"
Exit: 1
Expected failure:
  expected [Function] to throw an error
```

```text
$ git commit ...
Exit: 1
Expected/stale environment failure:
  test/unit/instance/instance-manager.test.ts > health checker with real OpenCode server
  fetch("http://localhost:4096/health") -> ECONNREFUSED
Resolution:
  require an explicit live OpenCode URL before running those live-server unit checks.
```

Verification:

```text
$ pnpm vitest run test/unit/persistence/migrations.test.ts \
  test/unit/persistence/schema.test.ts \
  test/unit/persistence/persistence-effect.test.ts \
  test/unit/persistence/projectors-effect.test.ts \
  test/unit/persistence/persistence-layer.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  74 passed (74)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 946 files in 287ms. No fixes applied.
```

```text
$ pnpm vitest run test/unit/persistence
Exit: 0
Test Files  30 passed (30)
Tests  386 passed (386)
```

```text
$ env -u OPENCODE_URL -u OPENCODE_BASE_URL pnpm test:unit
Exit: 0
Test Files  348 passed (348)
Tests  5106 passed | 2 skipped | 12 todo (5120)
```

```text
$ pnpm build:server
Exit: 0
tsgo passed
copy:assets copied src/lib/persistence/migrations into dist/src/lib/persistence/migrations
```

```text
$ env OPENCODE_SERVER_PASSWORD=dummy env -u OPENCODE_URL -u OPENCODE_BASE_URL \
  pnpm vitest run test/unit/instance/instance-manager.test.ts \
  --testNamePattern "health checker with real OpenCode server"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 80 skipped (82)
```

```text
$ pnpm test:contract
Exit: 0
Test Files  8 passed (8)
Tests  81 passed (81)
Note: this used an ephemeral OpenCode instance printed by the contract harness. `localhost:4096` was not listening
in this development environment.
```

```text
$ node --input-type=module <dry-run script against a VACUUM INTO copy>
Exit: 0
Applied migrations: []
Checksum after backfill: b4379c0b4631c149b4ffa201e92341150395475e3d1c386e227a77e616a24613
Row counts unchanged for sessions, events, messages, message_parts, activities, turns, pending_approvals,
session_providers, provider_state, tool_content, command_receipts, and projector_cursors.
```

## Phase 5.1: Effect Event Store Version Assignment Slice

Plan issues found:

- The Effect event store still had an in-memory `Map<sessionId, nextVersion>` cache after the schema migration
  foundation landed. That directly violated Phase 5's "delete the mutable version cache" rule and left a stale
  version window whenever another writer advanced the same session stream.
- Deleting the cache alone was not enough. The high-risk transaction rule says version assignment and append must
  be one transaction, but the single-event `append` path previously ran `SELECT MAX(stream_version) + 1` and
  `INSERT` as separate SQL operations under `@effect/sql`'s default deferred `BEGIN`. The fix makes version
  allocation part of the `INSERT ... SELECT COALESCE(MAX(stream_version) + 1, 0) ... RETURNING` write statement,
  and keeps single-event append and batch append inside explicit `SqlClient.withTransaction(...)` scopes.
- A reviewer correctly called out that the first same-service concurrency test did not prove the independent
  SQLite-client case. The slice now has both same-service and independent-store shared-file concurrency checks.

Changes:

- `src/lib/persistence/effect/event-store-effect.ts`: removed the mutable version cache and the
  `resetVersionCache` API from the Effect event-store service.
- `src/lib/persistence/effect/event-store-effect.ts`: wrapped the single-event append path in
  `SqlClient.withTransaction(...)`; `appendBatch` now reuses the same internal append body inside one outer
  transaction instead of nesting through the public `append` method.
- `src/lib/persistence/effect/event-store-effect.ts`: moved stream-version allocation into the `INSERT` statement
  so the version read and row write are not two separately interleavable SQL statements.
- `test/unit/persistence/projectors-effect.test.ts`: added a behavior test proving an append observes a stream
  version advanced outside the service instance.
- `test/unit/persistence/projectors-effect.test.ts`: added the Phase 5 concurrent append behavior check; ten
  concurrent appends to the same session must return unique contiguous stream versions.
- `test/unit/persistence/projectors-effect.test.ts`: added a shared-file independent-store concurrency check so
  the regression suite is not limited to one Effect SQL service instance.
- `test/unit/persistence/projectors-effect.test.ts`: renamed the old cache-rollback assertions to the behavior
  they actually protect: batch rollback for schema-invalid input and serialization defects.
- `test/unit/persistence/projectors-effect.test.ts`: removed the `resetVersionCache` test because the reset
  method was cache-management surface, not production behavior.

TDD red check:

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts -t \
  "append observes stream versions advanced outside the service instance"
Exit: 1
Expected failure:
  EventStoreError from append after the existing cache reused streamVersion=1 and hit
  idx_events_session_version.
```

Verification:

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts -t \
  "append observes stream versions advanced outside the service instance"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 36 skipped (37)
```

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts -t \
  "concurrent appends to one session receive unique contiguous stream versions"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 37 skipped (38)
```

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts -t \
  "append observes stream versions advanced outside the service instance|\
concurrent appends from independent store instances receive unique contiguous stream versions|\
concurrent appends to one session receive unique contiguous stream versions"
Exit: 0
Test Files  1 passed (1)
Tests  3 passed | 36 skipped (39)
```

```text
$ pnpm vitest run test/unit/persistence/projectors-effect.test.ts \
  test/unit/persistence/persistence-effect.test.ts \
  test/unit/persistence/migrations.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  60 passed (60)
```

## Phase 5.2: OpenCode Dual-Write Effect Persistence Slice

Plan issues found:

- The production OpenCode SSE dual-write path was still backed by `DualWriteHook -> PersistenceLayer ->
  EventStore/ProjectionRunner`, even after the Effect event-store and projection-runner services existed.
- `relay-stack.ts` could not build an Effect persistence runtime because production relay config carried only a
  legacy `PersistenceLayer`, not the SQLite file path needed for `@effect/sql-sqlite-node`.
- This slice intentionally does not remove `PersistenceLayer.open(...)`: read-side services, Claude persistence,
  and provider-state storage still depend on the legacy `SqliteClient` boundary. Removing the open call now would
  force a half-bridge instead of completing a real consumer migration.

Changes:

- `src/lib/persistence/effect/live.ts`: added one reusable per-project persistence layer that provides the
  SQLite client, migration-running `PersistenceServiceTag`, `EventStoreEffectTag`, cursor repo, and
  `ProjectionRunnerEffectTag`.
- `src/lib/persistence/effect/session-seeder-effect.ts`: added an Effect-native session seeder for write paths
  that need to guarantee the projected `sessions` row before appending events.
- `src/lib/persistence/effect/dual-write-hook-effect.ts`: added the OpenCode SSE dual-write hook backed by
  Effect event-store and projection services. It preserves the legacy hook's observable behavior: no-session and
  not-translatable events are skipped, persistence failures are converted to `DualWriteResult`, projection
  failures are non-fatal, stats are tracked, and reconnect resets translator/seeder state.
- `src/lib/persistence/dual-write-hook.ts`: introduced `DualWriteHookPort` so SSE wiring can depend on behavior
  instead of the concrete legacy hook class.
- `src/lib/relay/sse-wiring.ts`: accepts `DualWriteHookPort`.
- `src/lib/types.ts`: added `persistenceDbPath` to `ProjectRelayConfig`.
- `src/lib/effect/daemon-main.ts` and `src/lib/effect/relay-factory-layer.ts`: pass the per-project
  `.conduit/events.db` path into `createProjectRelay`.
- `src/lib/relay/relay-stack.ts`: uses `EffectDualWriteHook` when `persistenceDbPath` is available; the old
  `DualWriteHook` remains only as fallback for callers/tests that pass a legacy `PersistenceLayer` without a
  path. The Effect persistence runtime is disposed during relay shutdown and if relay startup fails while
  connecting the SSE stream.

TDD red check:

```text
$ pnpm vitest run test/unit/persistence/effect-dual-write-hook.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/persistence/effect/dual-write-hook-effect.js'
```

Verification:

```text
$ pnpm vitest run test/unit/persistence/effect-dual-write-hook.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  1 passed (1)
```

```text
$ pnpm vitest run test/unit/persistence/effect-dual-write-hook.test.ts \
  test/unit/persistence/projectors-effect.test.ts \
  test/unit/persistence/persistence-effect.test.ts \
  test/unit/persistence/migrations.test.ts \
  test/unit/relay/relay-stack-dual-write-wiring.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  64 passed (64)
Note: relay-stack-dual-write-wiring emitted existing MaxListenersExceededWarning warnings from the test harness.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 950 files. No fixes applied.
```

## Phase 5.3: Effect Read Query First Consumer Slice

Plan issues found:

- `ReadQueryTag` was still a legacy synchronous `ReadQueryService` bridge over `PersistenceLayer.db`. Moving the
  entire read surface at once would mix tool-content, status reads, session lists, fork metadata, and full
  history. The safer first consumer is `get_tool_content`, which has one query and one handler response shape.
- A handler test that only mocked `getToolContent` would be low signal. The new test seeds a real
  `@effect/sql-sqlite-node` database through the production Effect persistence layer and then drives the handler.

Changes:

- `src/lib/persistence/effect/read-query-effect.ts`: added `ReadQueryEffectTag` with an Effect-native
  `getToolContent(toolId)` method backed by `SqlClient`.
- `src/lib/persistence/effect/live.ts`: includes `ReadQueryEffectTag` in the reusable per-project persistence
  layer.
- `src/lib/handlers/tool-content.ts`: prefers `ReadQueryEffectTag` when present and falls back to the legacy
  `ReadQueryTag` while the larger read surface remains unmigrated.
- `src/lib/relay/relay-stack.ts`: merges the per-project Effect persistence layer into the relay handler runtime
  when `persistenceDbPath` is available, so production handlers can resolve `ReadQueryEffectTag`.
- `test/unit/handlers/tool-content-effect.test.ts`: added a real SQLite-backed handler test for the Effect read
  path.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts
Exit: 1
Expected failure:
  handler returned NOT_FOUND because it ignored the Effect read service and only checked legacy ReadQueryTag.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts -t "handleGetToolContent"
Exit: 0
Test Files  2 passed (2)
Tests  3 passed | 57 skipped (60)
```

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/persistence/effect-dual-write-hook.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  61 passed (61)
Note: effect-handlers emitted existing MaxListenersExceededWarning warnings from the test harness.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 952 files. No fixes applied.
```

## Phase 5.4: Effect Status Read Consumer Slice

Plan issues found:

- A subagent audit recommended `ProviderStateServiceTag` as the smallest remaining consumer, but the status-read
  TDD cycle was already red in this session. Finishing the red/green slice avoided leaving a broken test import and
  still retired a concrete `ReadQueryService` production read path.
- `PollDeps.getRawStatuses` was typed as dependency-free even though an Effect-native production reader can require
  services from the relay runtime. The type boundary needed to admit runtime-provided dependencies rather than
  forcing a cast or a separate sync bridge.

Changes:

- `src/lib/persistence/effect/read-query-effect.ts`: added `getSessionStatus(sessionId)` and
  `getAllSessionStatuses()` to the Effect-native read query service.
- `src/lib/session/session-status-effect.ts`: added Effect helpers that convert projected session statuses into the
  OpenCode-compatible `{ type }` status map used by the status poller.
- `src/lib/effect/session-status-poller.ts`: widened `PollDeps` dependency requirements so Effect-backed readers can
  be provided by the attached runtime.
- `src/lib/relay/relay-stack.ts`: status polling now prefers the Effect status reader when `persistenceDbPath` is
  available, while keeping the legacy `SessionStatusSqliteReader` fallback for the remaining bridge period.
- `test/unit/session/session-status-poller-effect.test.ts`: added a real SQLite-backed poll test that seeds projected
  statuses through the production Effect persistence layer.

TDD red check:

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts -t "poll reads projected statuses"
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/session/session-status-effect.js'
```

Verification:

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts -t "poll reads projected statuses"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 11 skipped (12)
```

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts \
  test/unit/session/session-status-sqlite.test.ts \
  test/unit/relay/status-poller-broadcast.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  22 passed (22)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 953 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  350 passed (350)
Tests  5111 passed | 2 skipped | 12 todo (5125)
Note: run emitted existing ExperimentalWarning SQLite warnings and existing MaxListenersExceededWarning warnings.
```

## Phase 5.5: Effect Provider State Consumer Slice

Plan issues found:

- The original plan groups provider work under Phase 6, but `provider_state` is a persistence-owned resume cursor
  table used by `prompt.ts`. Leaving it on `ProviderStateServiceTag` would keep Claude resume state tied to the
  legacy `PersistenceLayer.db` bridge after the read-query migration began.
- The `handleMessage` dispatch callback is still Promise-based fire-and-forget. This slice keeps that behavior and
  runs the Effect provider-state save as a non-fatal asynchronous persistence write. Fully joining provider execution
  into Effect belongs with the Phase 6 provider contract conversion.

Changes:

- `src/lib/persistence/effect/provider-state-effect.ts`: added Effect-native `ProviderStateEffectTag` with
  `getState`, transactional `saveUpdates`, and `clearState` over `@effect/sql`.
- `src/lib/persistence/effect/live.ts`: includes `ProviderStateEffectTag` in the reusable per-project Effect
  persistence layer.
- `src/lib/handlers/prompt.ts`: prefers `ProviderStateEffectTag` for provider-state reads/writes and keeps the
  legacy `ProviderStateServiceTag` fallback during the bridge period.
- `test/unit/handlers/prompt-provider-state-effect.test.ts`: added a real SQLite-backed handler test that verifies
  existing Claude resume state is passed into `send_turn` and returned updates persist for the next turn.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/persistence/effect/provider-state-effect.js'
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  1 passed (1)
```

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/persistence/provider-state-service.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  69 passed (69)
Note: effect-handlers emitted existing MaxListenersExceededWarning warnings from the test harness.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 955 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  351 passed (351)
Tests  5112 passed | 2 skipped | 12 todo (5126)
Note: run emitted existing ExperimentalWarning SQLite warnings and existing MaxListenersExceededWarning warnings.
```

## Phase 5.6: Effect Claude History Read Consumer Slice

Plan issues found:

- Claude prior-history loading in `prompt.ts` was still pinned to legacy `ReadQueryTag`, so Claude resume turns could
  use Effect provider state while still reading history through the old blocking `PersistenceLayer.db` bridge.
- The read model row types lived inside `read-query-service.ts`. Importing those from the new Effect read service
  would keep the Effect path coupled to the legacy class, so the row contracts needed a shared type module.
- `getSessionMessagesWithParts()` only ordered messages by `created_at`; the rest of the read model already uses
  `(created_at, id)` ordering. The Effect port and legacy bridge now use the same deterministic ordering.
- Broader verification exposed stale fixed-port test assumptions after the OpenCode SDK/API client setup change.
  Daemon live tests now skip cleanly when their optional live OpenCode dependency is not reachable instead of failing
  against `localhost:4096`.
- The layer-wiring config persistence test was asserting a debounced background write. It now publishes through the
  daemon bus, yields to the subscription fiber, and flushes through `ConfigPersistenceTag`, which tests the production
  service boundary without a timing race.

Changes:

- `src/lib/persistence/read-model-types.ts`: extracted shared SQLite projection row contracts.
- `src/lib/persistence/read-query-service.ts`: re-exports the shared row contracts and aligns
  `getSessionMessagesWithParts()` ordering with the deterministic message read order.
- `src/lib/persistence/effect/read-query-effect.ts`: added Effect-native `getSessionMessagesWithParts(sessionId)`.
- `src/lib/handlers/prompt.ts`: Claude history loading now prefers `ReadQueryEffectTag`, keeps the legacy
  `ReadQueryTag` fallback, and preserves the existing non-fatal "history read failed means dispatch with empty
  history" behavior.
- `test/unit/handlers/prompt-provider-state-effect.test.ts`: added a real SQLite-backed handler test proving
  `send_turn.input.history` comes from the Effect persistence layer.
- `test/e2e/helpers/daemon-fixtures.ts`, `test/e2e/specs/daemon-smart-default.spec.ts`, and
  `test/integration/daemon/daemon-server.test.ts`: removed hard failure on absent `localhost:4096` live OpenCode
  dependencies.
- `test/unit/effect/layer-wiring.test.ts`: made config persistence wiring deterministic by flushing the production
  persistence service.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 1
Expected failure:
  handleMessage dispatched Claude send_turn with history: [] even though the SQLite projection had a prior message.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  2 passed (2)
```

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/persistence/read-query-service.test.ts \
  test/unit/pipeline/history-regression.test.ts \
  test/unit/persistence/session-history-adapter.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  103 passed | 1 todo (104)
Note: effect-handlers emitted existing MaxListenersExceededWarning warnings from the test harness.
```

```text
$ pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/daemon-server.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  7 passed (7)
```

```text
$ pnpm exec playwright test --config test/e2e/playwright-daemon.config.ts \
  test/e2e/specs/daemon-smoke.spec.ts \
  test/e2e/specs/daemon-smart-default.spec.ts
Exit: 0
Tests  8 skipped
Note: no live OpenCode URL was reachable in this environment, so live daemon specs skipped as intended.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 956 files. No fixes applied.
```

```text
$ pnpm test:unit > unit-output.log 2>&1 || (echo "Unit tests failed, see unit-output.log" && tail -n 120 unit-output.log && exit 1)
Exit: 0
Test Files  351 passed (351)
Tests  5113 passed | 2 skipped | 12 todo (5127)
Note: run emitted existing ExperimentalWarning SQLite warnings and existing MaxListenersExceededWarning warnings.
```

```text
$ pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && tail -n 120 test-output.log && exit 1)
Exit: 1
Initial failure drove the daemon fixed-port and config-persistence wiring fixes above:
  - Unit tests: layer-wiring config persistence race
  - Integration tests: daemon health checker test assumed localhost:4096 when OPENCODE_SERVER_PASSWORD was set
  - E2E daemon tests: live daemon fixtures assumed localhost:4096
The targeted fixed surfaces now pass/skip cleanly as shown above. A later accidental full integration run also exposed
unrelated timeouts in `sse-to-ws-pipeline.integration.ts` and `message-lifecycle.integration.ts`; those were not part
of this slice.
```

## Phase 5.7: Effect Claude Persistence And Production Factory Cutover

Plan issues found:

- Claude user-message persistence and Claude adapter event-sink persistence were still tied to the legacy
  `ClaudeEventPersistTag` object, so a relay created with only `persistenceDbPath` could dispatch Claude turns but
  skip durable history writes.
- Status reconciliation still required synchronous projected-session reads and legacy `PersistenceLayer.eventStore`
  writes. That made `PersistenceLayer.open(...)` look removable while silently disabling corrective status events.
- `RelayFactoryLive` and `startDaemonProcess` both opened `PersistenceLayer` even though `createProjectRelay` already
  owns the Effect persistence runtime from `persistenceDbPath`.

Changes:

- `src/lib/persistence/effect/claude-event-persist-effect.ts`: added an Effect service for Claude user-message and
  adapter event persistence. It appends through `EventStoreEffectTag`, projects through `ProjectionRunnerEffectTag`,
  and ensures recovery before writes.
- `src/lib/persistence/effect/live.ts` and `src/lib/persistence/effect/index.ts`: added the Claude persistence service
  to the Effect persistence layer/barrel.
- `src/lib/handlers/prompt.ts`: Claude persistence now prefers `ClaudeEventPersistEffectTag` for user messages and
  event-sink writes, with the legacy bridge retained only as fallback.
- `src/lib/provider/relay-event-sink.ts`: persistence deps now support either the legacy sync append/project shape or
  a single Effect-backed async `persistEvent` function.
- `src/lib/effect/session-status-poller.ts`: reconciliation now reads projected sessions through an Effect and accepts
  Effect corrective writes.
- `src/lib/persistence/effect/read-query-effect.ts`: added Effect-native `listSessions()`.
- `src/lib/relay/relay-stack.ts`: status reconciliation now uses `ReadQueryEffectTag`, `EventStoreEffectTag`, and
  `ProjectionRunnerEffectTag` when `persistenceDbPath` is configured, falling back to legacy deps only for legacy
  callers.
- `src/lib/effect/relay-factory-layer.ts` and `src/lib/effect/daemon-main.ts`: production relay factories now pass
  `persistenceDbPath` only and no longer open or pass `PersistenceLayer`.
- Tests added/updated for Claude user persistence, Claude event-sink persistence, Effect reconciliation sessions, and
  relay factory persistence wiring.

TDD red checks:

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 1
Expected failure:
  Effect-only Claude handler persistence left projected messages empty.
```

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts
Exit: 1
Expected failure:
  reconcileNow did not await Effect projected-session reads, so no corrective event was injected.
```

```text
$ pnpm vitest run test/unit/effect/relay-factory-effect-persistence.test.ts
Exit: 1
Expected failure:
  RelayFactoryLive still tried to import/open the legacy PersistenceLayer before creating a relay.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  4 passed (4)
```

```text
$ pnpm vitest run test/unit/session/session-status-poller-effect.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  13 passed (13)
```

```text
$ pnpm vitest run test/unit/effect/relay-factory-effect-persistence.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  1 passed (1)
```

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/provider/relay-event-sink.test.ts \
  test/unit/provider/relay-event-sink-persistence.test.ts \
  test/unit/session/session-status-poller-effect.test.ts \
  test/unit/effect/relay-factory-effect-persistence.test.ts \
  test/unit/effect/relay-factory-layer.test.ts
Exit: 0
Test Files  6 passed (6)
Tests  44 passed (44)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 958 files. No fixes applied.
```

```text
$ pnpm test:unit > unit-output.log 2>&1 || (echo "Unit tests failed, see unit-output.log" && tail -n 160 unit-output.log && exit 1)
Exit: 0
Test Files  352 passed (352)
Tests  5117 passed | 2 skipped | 12 todo (5131)
```

```text
$ rg -n "PersistenceLayer\\.open" src test
Exit: 0
test/unit/persistence/persistence-layer.test.ts:74:            layer = PersistenceLayer.open(dbPath);
Note: no production `src` hits remain.
```

## Phase 6.1: Effect Orchestration Dispatch Entry Slice

Plan issues found:

- Converting all provider adapter methods to Effect in one commit would couple OpenCode REST behavior, Claude SDK
  lifecycle, cancellation, permission questions, and orchestration idempotency. The safer first vertical slice is the
  live orchestration entry point and provider lookup boundary.
- `ProviderRegistry.getAdapterOrThrow()` made missing providers stringly thrown errors. The Effect path now has a typed
  `ProviderNotRegistered` failure while the old throwing method remains only for compatibility.
- Orchestration idempotency used `Effect.runSync` inside `dispatch()`. The command-processing path now runs as an
  Effect program, and the Promise `dispatch()` method is just the compatibility edge.

Changes:

- `src/lib/provider/errors.ts`: added typed provider/orchestration errors:
  `ProviderNotRegistered`, `SessionProviderNotBound`, `DuplicateCommand`, and `ProviderAdapterFailure`.
- `src/lib/provider/provider-registry.ts`: added `getAdapterEffect(providerId)` for typed lookup failures.
- `src/lib/provider/orchestration-engine.ts`: added overloaded `dispatchEffect(...)`, moved command idempotency and
  adapter dispatch into Effect, wraps current Promise adapters with `Effect.tryPromise`, and keeps existing
  `dispatch(...)` as a Promise boundary.
- `test/unit/provider/orchestration-engine-effect.test.ts`: added the first behavior test for typed lookup failure and
  retryable command IDs.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts
Exit: 1
Expected failure:
  engine.dispatchEffect is not a function
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/provider-registry.test.ts \
  test/unit/provider/orchestration-engine.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  44 passed (44)
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  368 passed (368)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```

## Phase 8.1: Frontend Transport Protocol Boundary

Plan issues found:

- The existing frontend boundary treated unknown future message types and malformed known protocol messages the same
  way: both passed through. That preserved forward compatibility, but it also let bad known daemon payloads enter
  application dispatch without any debug signal.
- Reconnect already closed the old socket, but it did not explicitly interrupt the old Effect stream before the new
  stream was started. Because runtime lookup is async, a stale stream fiber could still register itself after a newer
  `connect()` call unless registration is generation-guarded.
- The plan's `pnpm test:e2e -- --grep "websocket"` command is not valid with the current `pnpm` script shape: the
  extra `--` reaches Playwright as a file matcher and causes `No tests found`. Running Playwright directly with
  `--grep "websocket"` selects the intended connection overlay test.
- Send queue drain behavior did not need a transport rewrite. Existing store coverage already pins the current
  latest-wins chat queue semantics and remained green after the reconnect changes.

Changes:

- `src/lib/shared-types.ts`: added `RELAY_MESSAGE_TYPES` and `KNOWN_RELAY_MESSAGE_TYPES`, with a compile-time
  exactness check against `RelayMessage["type"]` so the known-message list cannot drift from the existing relay union.
- `src/lib/frontend/effect-boundary.ts`: added `ProtocolDecodeError`; unknown future message types still pass through,
  while malformed known message types reject at the schema boundary.
- `src/lib/frontend/transport/runtime.ts`: changed WebSocket streams to surface `WsProtocolError` callbacks for invalid
  JSON and invalid known messages, fail socket errors with typed `TransportSocketError`, and clear/interrupt active
  stream fibers explicitly.
- `src/lib/frontend/stores/ws.svelte.ts`: added connection generations around reconnect/disconnect, interrupts the old
  stream before replacing a socket, ignores stale handlers, and records protocol decode failures in the existing debug
  event log without dispatching them.
- `test/unit/frontend/effect-boundary.test.ts`, `test/unit/frontend/runtime-validation.test.ts`, and
  `test/unit/frontend/ws-reconnect-stream.test.ts`: added behavior coverage for malformed known-message rejection,
  invalid JSON reporting, typed socket errors, reconnect stream interruption, and debug-surfaced protocol failures.

TDD red checks:

```text
$ pnpm vitest run test/unit/frontend/effect-boundary.test.ts test/unit/frontend/runtime-validation.test.ts
Exit: 1
Expected failures:
  malformed known protocol messages resolved instead of rejecting
  invalid JSON was silently dropped without a protocol error
  malformed known messages were emitted to downstream dispatch
```

Verification:

```text
$ pnpm check:frontend
Exit: 0
```

```text
$ pnpm vitest run test/unit/frontend test/unit/stores
Exit: 0
Test Files  82 passed (82)
Tests  1297 passed (1297)
```

```text
$ pnpm test:e2e -- --grep "websocket"
Exit: 1
Plan command issue:
  Playwright received the extra "--" as a file matcher and reported "No tests found" after the frontend build.
```

```text
$ pnpm exec playwright test --config test/e2e/playwright-replay.config.ts --grep "websocket"
Exit: 0
1 passed: Connection Overlay › overlay hides after WebSocket connects
```

```text
$ pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/debug-panel.spec.ts --project=desktop
Exit: 0
11 passed
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 992 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  376 passed (376)
Tests  5211 passed | 2 skipped | 12 todo (5225)
```

## Phase 9.0: Final Grep Gate Audit Reopened Earlier Phases

Outcome:

- Phase 9 cannot be marked complete. The live required greps still show production bridge blockers, so the earlier
  owning phases must be reopened instead of expanding Phase 9's exception table.
- No app code was changed in this audit slice. Documentation was updated only where the live architecture/testing
  guidance was stale.

Required grep gate results:

```text
$ rg -n "startDaemonProcess" src
Exit: 0
Hits: production CLI still imports/calls startDaemonProcess and daemon-main still exports the hybrid function.
```

```text
$ rg -n "PersistenceLayer\\.open" src
Exit: 1
No hits.
```

```text
$ rg -n "Effect\\.promise" src
Exit: 1
No hits.
```

```text
$ rg -n "concurrency: \"unbounded\"" src
Exit: 1
No hits.
```

```text
$ rg -n "Effect\\.run(Promise|Sync)" src/lib
Exit: 0
Hits remain in prompt persistence, relay-stack construction/callbacks, sse-stream cleanup, sdk-factory, daemon
lifecycle/main, auth-middleware, provider registry/orchestration, and Claude prompt queue.
```

```text
$ rg -n "Effect\\.run(Promise|Sync)" src/bin
Exit: 1
No hits.
```

```text
$ rg -n "Layer\\.succeed\\([^\\n]+Tag, [a-zA-Z0-9_]+\\)" src/lib/relay src/lib/effect
Exit: 0
Hits remain for prebuilt relay/daemon bridge objects in relay-stack and daemon-main; pure config/no-op layers need a
narrower classifier than the current grep.
```

Plan issues found:

- `startDaemonProcess` is still the production daemon entrypoint for both `--daemon` and `foreground`. The existing
  `startDaemonEffect` cannot replace it yet because `makeDaemonLive(...)` still requires externally assembled
  `DaemonLiveOptions` such as `ctx`, `ipcContext`, `configSnapshot`, and `wsRelayRouter`.
- `src/lib/relay/relay-stack.ts` is still the real imperative relay factory. It constructs relay resources and then
  bridge-injects prebuilt objects into the Effect runtime with `Layer.succeed(Tag, instance)`.
- `src/lib/effect/relay-layer.ts` should not be deleted as Phase 9 text implies. It now contains real
  self-constructing relay state composition and should grow into the relay owner when Phase 4 is reopened.
- The plan's WebSocket callback exception names `src/lib/effect/ws-transport-layer.ts`, but the live callback handoff
  is in `src/lib/effect/ws-routing-layer.ts`.
- The `Layer.succeed(...)` grep is too broad for pure configuration values and no-op object services, but it correctly
  catches prebuilt relay/daemon objects that still violate the bridge-deletion rule.
- `src/lib/effect/auth-middleware.ts` still hides `Effect.runSync(Ref.get(...))` behind a synchronous `AuthManager`
  bridge. `src/lib/effect/static-file-handler.ts` also has an unwrapped `decodeURIComponent(...)` path that can defect
  on malformed URI input.
- Provider-side Promise wrappers remain around Effect methods (`ProviderRegistry.shutdownAll`,
  `OrchestrationEngine.dispatch/shutdown`) and `RelayEventSink.persistEvent` is still Promise-shaped, forcing
  `Effect.runPromise(...)` in `handlePrompt`.
- The Phase 8/9 E2E command form using `pnpm test:e2e -- --grep ...` is invalid with the current package script
  argument forwarding. `pnpm test:e2e --grep ...` or direct `pnpm exec playwright ... --grep ...` is the correct form.

Reopened implementation slices:

- Reopen Phase 2 for the daemon composition root. The long-term fix is an Effect-owned process entrypoint and a
  foreground/test starter that provide a real `DaemonHandleTag`, then delete `startDaemonProcess` rather than
  documenting it as an exception.
- Reopen Phase 3 for routing/auth/static residue: replace the injected legacy `wsRelayRouter`, make auth methods
  Effect-native instead of sync class methods, and normalize malformed static URI decoding through typed route errors.
- Reopen Phase 4 for relay composition ownership. `RelayStateLive` should grow into a scoped project-relay Layer that
  constructs and finalizes OpenCode API, session services, WS handler, pollers, PTY, SSE, orchestration, and persistence
  instead of `createProjectRelay()` constructing them imperatively.
- Reopen Phase 6 for provider boundary cleanup: make event sink persistence Effect-native, remove Promise wrappers over
  Effect provider/orchestration methods, fold Claude prompt queue ownership into the adapter lifecycle, and decide the
  exact SDK fetch bridge policy.

Documentation changes:

- `docs/agent-guide/architecture.md`: updated the runtime shape from the stale `daemon.ts`/OpenCode-only wording to the
  current extracted daemon modules, provider adapters, and OpenCode/Claude SDK reality.
- `docs/agent-guide/testing.md`: fixed E2E argument examples and documented that live OpenCode tests use dynamic
  instance URLs, not an assumed `localhost:4096`.

## Phase 3.41: Static Route Decode Error Boundary

Plan issues found:

- The Phase 9 audit found an unwrapped `decodeURIComponent(...)` in the Effect static file handler. Malformed URI
  encoding threw a `URIError` inside the Effect route program instead of returning a typed route response.
- This belongs with reopened Phase 3 routing/static ownership, not Phase 9. It is small enough to fix independently
  before the larger auth/router bridge work.

Changes:

- `src/lib/effect/static-file-handler.ts`: added `InvalidStaticPathEncoding` as a typed decode boundary and maps it to
  a normal `400 Bad Request` response.
- `test/unit/server/static-file-handler.test.ts`: added behavior coverage for malformed URI encoding.

TDD red check:

```text
$ pnpm vitest run test/unit/server/static-file-handler.test.ts --testNamePattern "malformed URI"
Exit: 1
Expected failure:
  URIError: URI malformed
```

Verification:

```text
$ pnpm vitest run test/unit/server/static-file-handler.test.ts --testNamePattern "malformed URI"
Exit: 0
Tests  1 passed | 8 skipped (9)
```

```text
$ pnpm vitest run test/unit/server/static-file-handler.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  9 passed (9)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 992 files in 366ms. No fixes applied.
```

## Phase 3.42: Effect-Native Auth Service Boundary

Plan issues found:

- The Phase 9 audit was correct that `AuthManagerFromConfigLive` hid an `Effect.runSync(Ref.get(...))` bridge behind
  synchronous `AuthManager` methods. That made auth look reactive while still reading Effect state through a sync
  escape hatch.
- While pinning the behavior, the Effect IPC `set_pin` handler was found to hash PINs with raw SHA-256, while
  `AuthManager`, CLI setup, and the legacy daemon IPC handler use the canonical `hashPin(...)` prefix. A PIN set
  through the Effect IPC handler would not authenticate against `AuthManager`.

Changes:

- `src/lib/effect/auth-middleware.ts`: changed `AuthManagerTag` to provide an Effect-native auth service. HTTP auth
  handlers now yield service methods instead of calling synchronous methods over Effect state.
- `src/lib/effect/ws-routing-layer.ts`: made upgrade authentication yield the Effect auth service before relay startup.
- `src/lib/effect/ipc-handlers.ts`: uses the canonical `hashPin(...)` implementation for `set_pin`.
- `src/lib/auth.ts`: lets `setPinHash(null)` clear the internal hash so the Effect service can mirror
  `DaemonConfigRef.pinHash` without a reactive getter.
- Updated layer wiring/tests to provide `makeAuthManagerLive(...)` instead of injecting a raw `AuthManager` as an
  Effect service.

TDD red check:

```text
$ pnpm vitest run test/unit/daemon/ipc-handlers.test.ts --testNamePattern "updates pinHash"
Exit: 1
Expected failure:
  expected raw SHA-256("1234") to be hashPin("1234")
```

Verification:

```text
$ pnpm vitest run test/unit/daemon/ipc-handlers.test.ts --testNamePattern "updates pinHash"
Exit: 0
Tests  1 passed | 21 skipped (22)
```

```text
$ pnpm vitest run test/unit/effect/auth-manager-layer.test.ts test/unit/server/auth-middleware.test.ts test/unit/effect/ws-routing-layer.test.ts test/unit/effect/layer-wiring.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  45 passed (45)
```

```text
$ pnpm vitest run test/unit/server/effect-http-router.test.ts test/unit/server/effect-http-router-production.test.ts test/unit/server/http-server-layer.test.ts test/unit/effect/scoped-fiber-layers.test.ts test/unit/daemon/ipc-handlers.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  77 passed (77)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 992 files in 221ms. No fixes applied.
```

## Phase 6.41: Handler Orchestration Dispatch Boundary

Plan issues found:

- The Phase 9 grep bucket mixed two different provider-boundary shapes. Handler calls to
  `OrchestrationEngine.dispatch(...)` were unnecessary Promise facades over an existing Effect API and should be
  removed now.
- The remaining `handlers/prompt.ts` EventSink persistence bridge sits at the Promise-shaped Claude SDK/EventSink
  boundary. Removing that without hiding it elsewhere requires a separate EventSink design slice, not a mechanical
  swap in the prompt handler.

Changes:

- `src/lib/handlers/context-window.ts`, `model.ts`, `settings.ts`, `reload.ts`, and `prompt.ts` now call
  `dispatchEffect(...)` directly.
- `handleMessage(...)` forks the `send_turn` Effect directly instead of creating a Promise via
  `OrchestrationEngine.dispatch(...)` and wrapping it back into Effect.
- `test/unit/provider/orchestration-dispatch-boundary.test.ts` guards handler code from reintroducing the Promise
  facade.
- Handler tests now provide test doubles with `dispatchEffect(...)` so tests model the production service contract.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-dispatch-boundary.test.ts
Exit: 1
Expected failure:
  offenders included context-window.ts, model.ts, prompt.ts, reload.ts, and settings.ts
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-dispatch-boundary.test.ts test/unit/handlers/effect-handlers.test.ts test/unit/handlers/model-wire-snapshots.test.ts test/unit/handlers/settings-wire-snapshots.test.ts test/unit/handlers/context-window-overrides-effect.test.ts test/unit/handlers/get-commands-active-provider.test.ts test/unit/handlers/model-overrides-effect.test.ts test/unit/handlers/prompt-provider-state-effect.test.ts test/unit/provider/orchestration-engine-effect.test.ts test/unit/provider/orchestration-engine.test.ts
Exit: 0
Test Files  10 passed (10)
Tests  139 passed (139)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 994 files in 344ms. No fixes applied.
```

## Phase 7.39: Processing Timeout State Contract And Bridge Deletion

Plan issues found:

- Processing timeouts cut across prompt dispatch, permission/question replies, session status synthesis, reconnect
  bootstrap, SSE event handling, status-poller idle handling, and relay shutdown. Migrating only handlers would leave
  the relay pipeline reading stale timeout state.
- The first Effect implementation used `forkScoped` from request-handler effects. That failed under
  `ManagedRuntime.runPromise(...)` because the request effect does not provide an ambient `Scope`; the timeout fibers
  need to be owned by the long-lived override-state Layer instead.
- After the timeout consumers moved to `OverridesStateTag`, keeping `SessionOverridesTag` provisioned in
  `relay-stack.ts` became a false bridge. The plan's bridge-deletion rule applies here, so the imperative
  `SessionOverrides` class, tag, daemon layer, relay construction, and class tests were removed in this slice.
- The remaining relay callback calls to timeout state are still external callback boundaries. They run through the
  relay `ManagedRuntime`, while the timeout fibers themselves are scoped and drained by `makeOverridesStateLive()`.

Changes:

- `src/lib/effect/session-overrides-state.ts`: owns processing timeout fibers with a scoped `FiberMap`; start/reset use
  per-session tokens so stale fibers cannot clear or fire newer turns, and timeout completion clears the active marker
  before invoking the callback.
- `src/lib/handlers/prompt.ts`: starts, clears, and resets processing timeouts through Effect state for OpenCode and
  Claude turns, including cancel and dispatch-failure cleanup.
- `src/lib/handlers/permissions.ts`: permission/question answer and reject paths restart processing timeouts through
  Effect state.
- `src/lib/handlers/session.ts`, `src/lib/session/session-switch.ts`, and `src/lib/bridges/client-init.ts`: session
  status synthesis and reconnect bootstrap now read active processing timeouts from Effect state, including async reads
  at the client-init boundary.
- `src/lib/relay/event-pipeline.ts`, `src/lib/relay/sse-wiring.ts`, `src/lib/relay/monitoring-wiring.ts`, and
  `src/lib/relay/relay-stack.ts`: relay event/status wiring now depends on a narrow `ProcessingTimeoutsPort` backed by
  the relay `ManagedRuntime`, not the old override object.
- Deleted `src/lib/session/session-overrides.ts` and `test/unit/session/session-overrides.test.ts`; removed
  `SessionOverridesTag`, `makeSessionOverridesLive()`, and all production/test Layer provisioning for the deleted tag.

TDD red checks:

```text
$ pnpm vitest run test/unit/session/session-overrides-effect.test.ts --testNamePattern "managed overrides layer scope"
Exit: 1
Expected failure:
  Service not found: effect/Scope
```

```text
$ pnpm vitest run test/unit/handlers/prompt-processing-timeout-effect.test.ts
Exit: 1
Expected failure:
  Service not found: SessionOverrides
```

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts --testNamePattern "reports processing"
Exit: 1
Expected failure:
  expected "idle", received "processing" only after Effect timeout state became the source of truth.
```

```text
$ pnpm vitest run test/unit/handlers/permissions-processing-timeout-effect.test.ts
Exit: 1
Expected failure:
  Service not found: SessionOverrides
```

Verification:

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 991 files. No fixes applied.
```

```text
$ pnpm vitest run test/unit/handlers/prompt-processing-timeout-effect.test.ts \
  test/unit/handlers/permissions-processing-timeout-effect.test.ts \
  test/unit/session/session-overrides-effect.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/relay/event-pipeline.test.ts \
  test/unit/relay/sse-wiring.test.ts \
  test/unit/relay/monitoring-wiring.test.ts \
  test/unit/relay/effect-executor.test.ts \
  test/unit/session/session-switch.test.ts \
  test/unit/session/synthesized-status-sessionid.test.ts \
  test/unit/session/patchMissingDone-claude-sdk.test.ts \
  test/unit/bridges/client-init.test.ts \
  test/unit/mock-factories.test.ts \
  test/unit/effect/services.test.ts \
  test/unit/effect/daemon-layers.test.ts \
  test/unit/daemon/ipc-handlers.test.ts \
  test/unit/daemon/ipc-dispatch.test.ts \
  test/unit/daemon/ipc-rpc-group.test.ts
Exit: 0
Test Files  20 passed (20)
Tests  418 passed (418)
```

```text
$ pnpm test:integration -- test/integration/effect-layers.test.ts
Exit: 0
Note: the integration config ignored the file filter and ran the full integration suite.
Test Files  24 passed (24)
Tests  127 passed | 1 skipped (128)
```

```text
$ pnpm test:unit
Exit: 0
Test Files  375 passed (375)
Tests  5206 passed | 2 skipped | 12 todo (5220)
```

```text
$ pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
Exit: 0
All steps passed, including check, lint, unit, integration, contract, build, E2E replay, multi-instance, subagent,
Storybook build, and Storybook visual tests.
```

## Phase 7.38: Model And Variant Override State Contract

Plan issues found:

- `model.ts` still read and wrote model, variant, default model, default variant, and context-window display state
  through the legacy `SessionOverridesTag`.
- Moving only `switch_variant` or only `switch_model` would split model and variant ownership across two stores, so
  this slice migrates the model handlers together while leaving processing-timeout behavior for later.
- The first green model-handler conversion exposed a real follow-on split: prompt dispatch, reconnect bootstrap, and
  relay startup defaults could still read stale legacy override state after the model/context handlers wrote Effect
  state.
- Review found a production-path gap after the first IPC conversion: the live daemon IPC server routes through
  `buildIPCHandlers(...)`, where `set_agent` and `set_model` still returned success without touching any relay override
  state. The separate Effect IPC handler tests were not enough to prove live daemon behavior.

Changes:

- `src/lib/handlers/model.ts`: replaced direct `SessionOverridesTag` use with Effect override-state helpers for
  `get_models`, `switch_model`, `set_default_model`, and `switch_variant`.
- `src/lib/effect/session-overrides-state.ts`: added `getDefaultVariant()` so handlers do not inspect the state `Ref`
  directly, and added default-agent state so project-level IPC `set_agent` has a real prompt-time fallback instead of
  writing an unused slug key.
- `src/lib/handlers/prompt.ts`: reads model, user-selected model flag, variant, context window, and fallback agent from
  Effect override state before building both legacy OpenCode prompts and orchestration `send_turn` inputs.
- `src/lib/bridges/client-init.ts`: added a narrow async `ClientInitOverrideState` port and routed reconnect bootstrap
  model/variant/context/default-model reads through it instead of the legacy override object.
- `src/lib/relay/relay-stack.ts`: seeds persisted/default project model and persisted variant into
  `OverridesStateTag` after the relay runtime is created, and backs the client-init override port with that runtime.
- `src/lib/effect/ipc-handlers.ts`: migrated IPC `set_agent` and `set_model` commands to the same Effect override
  state, preserving the existing slug-as-override-key protocol.
- `src/lib/effect/ipc-dispatch.ts`, `test/unit/daemon/ipc-dispatch.test.ts`,
  `test/unit/daemon/ipc-rpc-group.test.ts`, and `test/integration/effect-layers.test.ts`: updated the IPC handler
  dependency contract and test/proof layers so daemon IPC composition provides `OverridesStateTag`.
- `src/lib/daemon/daemon-ipc.ts` and `src/lib/effect/daemon-main.ts`: routed live daemon IPC `set_agent` /
  `set_model` through explicit project override ports. The daemon implementation now finds the ready project relay,
  stores project-level agent state in the relay Effect runtime, and applies model changes through the same
  `set_default_model` handler used by browser clients.
- `src/lib/handlers/session.ts`: fork cleanup now clears Effect-owned per-session override state as well as the legacy
  cleanup path. The legacy path is still needed for processing-timeout/session-switch timer checks until that slice is
  migrated.
- `test/unit/handlers/model-overrides-effect.test.ts`: added behavior coverage proving `switch_model` stores the
  selected session model and restored persisted variant without providing legacy `SessionOverridesTag`, plus a
  cross-handler regression proving the next prompt dispatch uses the selected model and restored variant.
- `test/unit/bridges/client-init.test.ts`: updated reconnect/default-model tests to seed/assert the Effect override
  port rather than stale legacy override mutations.
- `test/unit/relay/relay-stack-default-overrides.test.ts`: added relay-level coverage that persisted defaults are
  visible through the relay runtime's Effect override state.
- Updated model, prompt, provider-state, and snapshot tests to provide real Effect state instead of mock
  `SessionOverrides` model/variant/context reads.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/model-overrides-effect.test.ts
Exit: 1
Expected failure:
  Service not found: SessionOverrides
```

```text
$ pnpm vitest run test/unit/handlers/model-overrides-effect.test.ts -t "uses the selected model"
Exit: 1
Expected failure:
  engine dispatch omitted input.model and input.variant after switch_model wrote Effect state
```

```text
$ pnpm vitest run test/unit/bridges/client-init.test.ts -t "bootstraps model"
Exit: 1
Expected failure:
  reconnect bootstrap sent empty legacy variant/context state and no Effect-backed model_info
```

```text
$ pnpm vitest run test/unit/daemon/ipc-handlers.test.ts -t "handleSetAgent|handleSetModel"
Exit: 1
Expected failure:
  IPC commands wrote only legacy SessionOverrides, leaving Effect override state empty
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "clears Effect override state"
Exit: 1
Expected failure:
  fork cleanup left model/agent/variant/context entries in Effect override state
```

```text
$ pnpm vitest run test/unit/daemon/daemon-ipc.test.ts -t "project overrides"
Exit: 1
Expected failure:
  production buildIPCHandlers returned ok:true without calling setProjectAgent/setProjectModel
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/model-overrides-effect.test.ts \
  test/unit/handlers/model-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/session/session-overrides-effect.test.ts \
  test/unit/handlers/context-window-overrides-effect.test.ts \
  test/unit/handlers/model-wire-snapshots.test.ts \
  test/unit/bridges/client-init.test.ts \
  test/unit/relay/relay-stack-default-overrides.test.ts \
  test/unit/handlers/agent-prompt-state-effect.test.ts \
  test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/daemon/ipc-handlers.test.ts \
  test/unit/daemon/ipc-dispatch.test.ts \
  test/unit/daemon/ipc-rpc-group.test.ts \
  test/unit/daemon/daemon-ipc.test.ts \
  test/unit/daemon/daemon-lifecycle-ipc.test.ts \
  test/unit/effect/layer-wiring.test.ts
Exit: 0
Test Files  16 passed (16)
Tests  271 passed (271)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 991 files. No fixes applied.
```

```text
$ git diff --check
Exit: 0
```

```text
$ pnpm test:unit > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
Exit: 0
Test Files  374 passed (374)
Tests  5250 passed | 2 skipped | 12 todo (5264)
```

```text
$ pnpm exec vitest run --config vitest.integration.config.ts test/integration/effect-layers.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  5 passed (5)
```

## Phase 7.37: Context Window Override State Contract

Plan issues found:

- `handleSwitchContextWindow` still read and mutated the legacy `SessionOverridesTag` class even though the relay
  already provides Effect-native `OverridesStateTag` and agent selection had moved to it.
- This kept model/context UI state split across two owners. The small safe slice is context-window state only; model,
  prompt, session, permission, and processing-timeout paths still need separate migrations because they share more
  behavior.

Changes:

- `src/lib/handlers/context-window.ts`: replaced `SessionOverridesTag` with Effect override-state helpers for
  session/default model reads and context-window reads/writes.
- `test/unit/handlers/context-window-overrides-effect.test.ts`: added behavior coverage proving supported context
  windows persist through `OverridesStateTag` without providing the legacy `SessionOverridesTag`, for both active-session
  and default/no-session paths.
- `test/unit/handlers/effect-handlers.test.ts`: converted context-window handler tests to assert real Effect state
  changes instead of legacy mock method calls.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/context-window-overrides-effect.test.ts
Exit: 1
Expected failure:
  Service not found: SessionOverrides
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/context-window-overrides-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  -t "handleSwitchContextWindow|Effect override state|default context window"
Exit: 0
Test Files  2 passed (2)
Tests  4 passed | 73 skipped (77)
```

```text
$ pnpm vitest run test/unit/handlers/context-window-overrides-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/model-service-effect.test.ts \
  test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/session/session-overrides-effect.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  117 passed (117)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 989 files. No fixes applied.
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  372 passed (372)
Tests  5237 passed | 2 skipped | 12 todo (5251)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.36: Tool Content ReadQuery Bridge Removal

Plan issues found:

- Phase 7.33 moved tool-content reads behind `ToolContentServiceTag`, but the service still silently fell back to
  legacy `ReadQueryTag` when `ReadQueryEffectTag` was absent.
- That violated the plan's bridge-deletion rule: once the browser handler consumed the new domain service, the service
  itself still kept the old synchronous read bridge alive.
- Production relay wiring already has `persistenceDbPath` for the Effect persistence layer. When no Effect persistence
  is configured, the long-term behavior is explicit "content unavailable", not a hidden legacy database read.

Changes:

- `src/lib/effect/tool-content-service.ts`: made `ToolContentServiceLive` require `ReadQueryEffectTag` and read only
  through the Effect read model; added `ToolContentServiceNoop` for relays/tests without Effect persistence.
- `src/lib/relay/relay-stack.ts`: wires one persistence-backed tool-content layer when `persistenceDbPath` exists, or
  the no-op service otherwise. This keeps the persistence layer as the single owner of Effect read services.
- `test/helpers/mock-factories.ts` and handler tests now use `ToolContentServiceNoop` unless they explicitly provide
  an Effect read query/persistence layer.
- Added a guard for the risky mixed environment: when both `ReadQueryEffectTag` and legacy `ReadQueryTag` are provided,
  tool content is served from the Effect read query and the legacy reader is not called.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts -t "legacy read query"
Exit: 1
Expected failure:
  Cannot read properties of undefined (reading '_op_layer')
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts \
  test/unit/mock-factories.test.ts \
  test/unit/handlers/session-service-effect.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  99 passed (99)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 988 files. No fixes applied.
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  371 passed (371)
Tests  5235 passed | 2 skipped | 12 todo (5249)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.35: Prompt Prior History Effect Read Contract

Plan issues found:

- `prompt.ts` already preferred `ReadQueryEffectTag` for Claude prior-history loading, but still resolved
  `ReadQueryTag` and carried a legacy synchronous fallback in the handler-local `loadPriorHistoryForTurn(...)` helper.
- That fallback was no longer needed for production Effect persistence and kept a direct handler dependency on the
  legacy read service. When Effect SQLite is unavailable, the correct non-SQLite fallback is already
  `SessionManagerService.loadPreRenderedHistory(...)`.
- This is intentionally narrower than the tool-content fallback cleanup: `ToolContentServiceLive` still owns a
  temporary legacy fallback, but no browser handler imports `ReadQueryTag` after this slice.

Changes:

- `src/lib/handlers/prompt.ts`: removed `ReadQueryTag`, `ReadQueryService`, and the synchronous
  `readQuery.getSessionMessagesWithParts(...)` branch from Claude prior-history loading.
- `test/unit/handlers/effect-handlers.test.ts`: updated the prior-SQLite-history test to provide
  `ReadQueryEffectTag`; strengthened the non-SQLite fallback test by providing a throwing legacy `ReadQueryTag` and
  asserting it is not used.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "Effect SQLite is unavailable"
Exit: 1
Expected failure:
  expected SessionManagerService.loadPreRenderedHistory to be called with "session-1"; Number of calls: 0
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/handlers/agent-prompt-state-effect.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  86 passed (86)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 988 files. No fixes applied.
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  371 passed (371)
Tests  5233 passed | 2 skipped | 12 todo (5247)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.34: View Session Effect History Read Contract

Plan issues found:

- Phase 7.20 recorded history-pagination ownership, but live `src/lib/handlers/session.ts` still preferred the legacy
  synchronous `ReadQueryTag` path for `view_session` history. That was source/progress drift.
- The correct boundary is not a new generic session-read bridge: projected history rows already belong to the Effect
  read model via `ReadQueryEffectTag.getSessionMessagesWithParts(...)`, while REST history fallback stays with
  `SessionManagerService`.
- `resolveSessionHistoryFromSqlite(...)` still serves legacy/test callers, so this slice extracts the row-to-wire
  conversion as a pure helper and uses it from both the legacy helper and the Effect handler path.

Changes:

- `src/lib/handlers/session.ts`: `view_session` history resolution now prefers `ReadQueryEffectTag` and no longer
  imports or reads `ReadQueryTag`.
- `src/lib/session/session-switch.ts`: extracted `resolveSessionHistoryFromRows(...)` so Effect rows and legacy
  `ReadQueryService` rows share the same `session_switched` history projection.
- `test/unit/handlers/session-service-effect.test.ts`: added a behavior test proving `handleViewSession` uses
  `ReadQueryEffectTag.getSessionMessagesWithParts(...)` and does not fall back to REST history when Effect SQLite is
  available.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts -t "SQLite history"
Exit: 1
Expected failure:
  expected getSessionMessagesWithParts to be called with "session-1"; Number of calls: 0
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts \
  test/unit/session/session-switch-sqlite.test.ts \
  test/unit/provider/relay-event-sink-persistence.test.ts
Exit: 0
Test Files  6 passed (6)
Tests  102 passed (102)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 988 files. No fixes applied.
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  371 passed (371)
Tests  5233 passed | 2 skipped | 12 todo (5247)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.33: Tool Content Read Service Contract

Plan issues found:

- `handleGetToolContent` was already using the Effect read model when available, but the handler itself still owned
  the fallback choice between `ReadQueryEffectTag` and legacy `ReadQueryTag`. That left persistence-read ownership in
  a browser-message handler instead of behind a domain read service.
- The legacy `ReadQueryTag` fallback cannot be deleted in this slice because `prompt.ts` and `session.ts` still use it.
  This slice moves the fallback out of the handler and keeps the transition explicit in one service.
- A read-only subagent audit found source/progress drift in the next adjacent read surface: the progress doc says
  history pagination is service-owned, but `src/lib/handlers/session.ts` still reads `ReadQueryTag` directly for
  `view_session` history resolution. That should be the next read-service cleanup before claiming handler read
  ownership is complete.

Changes:

- Added `src/lib/effect/tool-content-service.ts` with `ToolContentServiceTag`, `ToolContentServiceLive`, and a typed
  `ToolContentServiceError`.
- Converted `src/lib/handlers/tool-content.ts` to depend only on `ToolContentServiceTag` and `WebSocketHandlerTag`.
- Wired `ToolContentServiceLive` into production relay runtime composition and the shared handler test layer.
- Updated tool-content tests to prove the handler can run from the service boundary without `ReadQueryTag`, while
  retaining coverage for the real Effect SQLite read path and the legacy fallback path.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/effect/tool-content-service.js'
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/tool-content-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  90 passed (90)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 988 files. No fixes applied.
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  371 passed (371)
Tests  5232 passed | 2 skipped | 12 todo (5246)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.32: Agent Handler Selection Service Contract

Plan issues found:

- A handler-only `get_agents` / `switch_agent` conversion would have created a real state split: `switch_agent`
  would move to Effect-owned override state while prompt dispatch and reconnect replay could still read the old
  imperative `SessionOverrides` object.
- The adjacent `context-window` handler looks similarly small, but moving it now would split model/context state
  because model selection and default-model persistence still write through the legacy override object. That slice
  should move with the remaining model/context override migration, not with agent selection.

Changes:

- Added `src/lib/effect/agent-service.ts` with `AgentServiceTag`, `AgentServiceLive`, OpenCode agent filtering,
  Claude SDK agent discovery through `OrchestrationEngine.dispatchEffect`, stale active-agent cleanup, and
  `switchAgent` backed by Effect-native override state.
- Added `clearAgent`, `getDefaultModel`, and `getDefaultContextWindow` helpers to
  `src/lib/effect/session-overrides-state.ts` so services do not reach into the raw `Ref`.
- Converted `src/lib/handlers/agent.ts` to depend on `AgentServiceTag` plus `WebSocketHandlerTag` only, and removed
  the legacy `makeAgentListMessage` helper.
- Routed prompt dispatch through `AgentServiceTag.getActiveAgent(...)` so a `switch_agent` selection is used by the
  next OpenCode or Claude turn.
- Routed client-connect agent-list replay through the same service callback so reconnect bootstrap reads the same
  Effect-owned active-agent state.
- Wired `AgentServiceLive` into relay runtime composition and the shared handler test layer.

TDD red checks:

```text
$ pnpm vitest run test/unit/session/session-overrides-effect.test.ts test/unit/effect/agent-service.test.ts
Exit: 1
Expected failures:
  Cannot find module '../../../src/lib/effect/agent-service.js'
  clearAgent/default getter helpers were not implemented
```

```text
$ pnpm vitest run test/unit/handlers/agent-prompt-state-effect.test.ts
Exit: 1
Expected failure:
  client.session.prompt called with { text: "implement this" } instead of { text, agent: "plan" }
```

Verification:

```text
$ pnpm vitest run test/unit/effect/agent-service.test.ts \
  test/unit/session/session-overrides-effect.test.ts \
  test/unit/handlers/agent-prompt-state-effect.test.ts \
  test/unit/handlers/get-agents-active-provider.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/bridges/client-init.test.ts \
  test/unit/handlers/dispatch-effect.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  9 passed (9)
Tests  187 passed (187)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 987 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  371 passed (371)
Tests  5231 passed | 2 skipped | 12 todo (5245)
```

## Phase 7.31: Scan Handler Domain Service Contract

Plan issues found:

- The remaining `scan_now` browser handler was still wired through `ScanDepsTag`, a Promise-shaped bridge mounted in
  `relay-stack.ts`.
- `PortScannerTag` is not the correct replacement for this handler boundary because it only exposes known ports; it
  cannot trigger an immediate scan or produce the `discovered` / `lost` / `active` response expected by the browser.
- While auditing the wire behavior, a pre-existing frontend gap surfaced: the server sends scan failures as
  `system_error` with `INSTANCE_ERROR`, but the scan in-flight unit test only covered a per-session `error` message.
  That meant the Settings UI could stay stuck on "Scanning..." after a scan failure.

Changes:

- Added `src/lib/effect/scan-service.ts` with `ScanServiceTag`, `ScanServiceLive`, `ScanServiceError`, and
  `ScanServiceNotAvailable`.
- Converted `handleScanNow` to consume `ScanServiceTag` instead of `ScanDepsTag`, preserving the existing
  `scan_result` success envelope and `INSTANCE_ERROR` system-error envelope.
- Wired `ScanServiceLive` into relay runtime composition and the shared handler test layer from `ConfigTag`.
- Deleted the legacy `ScanDepsTag` and `ScanDeps` handler dependency type.
- Updated frontend dispatch so `system_error` with `INSTANCE_ERROR` clears `scanInFlight`, matching the actual server
  failure envelope.
- Added service tests, handler-boundary tests, and a real `system_error` frontend scan-inflight regression test.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/scan-service.test.ts test/unit/handlers/scan-service-effect.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/effect/scan-service.js'
```

```text
$ pnpm vitest run test/unit/frontend/scan-inflight.test.ts
Exit: 1
Expected failure:
  expected true to be false
```

Verification:

```text
$ pnpm vitest run test/unit/effect/scan-service.test.ts \
  test/unit/handlers/scan-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/effect/services.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  113 passed (113)
```

```text
$ pnpm vitest run test/unit/frontend/scan-inflight.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  4 passed (4)
```

```text
$ rg -n "ScanDeps|scanDeps" src test --glob '!dist/**'
Exit: 1
No legacy scan dependency bridge references remain in app or test source.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 984 files. No fixes applied.
```

```text
$ pnpm vitest run test/unit/handlers test/unit/effect/scan-service.test.ts test/unit/effect/services.test.ts \
  test/unit/mock-factories.test.ts test/unit/frontend/scan-inflight.test.ts
Exit: 0
Test Files  26 passed (26)
Tests  233 passed (233)
```

```text
$ pnpm test:unit
Exit: 0
Test Files  369 passed (369)
Tests  5224 passed | 2 skipped | 12 todo (5238)
```

## Phase 7.30: Project Management Handler Domain Service Contract

Plan issues found:

- Phase 7 grouped instance and project management together, but project management spans settings handlers,
  `set_project_instance`, config-backed daemon callbacks, and OpenCode fallback reads. Treating this as part of the
  instance lifecycle service would have mixed browser wire rendering with daemon registry behavior.
- The correct boundary is domain-shaped, not handler-shaped: `ProjectManagementService` owns project listing,
  fallback mapping, mutations, unsupported capability errors, and typed operation failures. Browser handlers keep
  payload validation and stable WebSocket envelopes.
- `set_project_instance` is dispatched from the instance handler module but semantically mutates project bindings. Its
  existing browser-visible error code is still `INSTANCE_ERROR`; changing that during the service migration would be a
  compatibility change.
- `ProjectMgmtTag` remains for daemon/IPC legacy code, but browser handlers no longer consume it. Scan migration remains
  open until there is a real Effect `scanNow` service; `ScanDepsTag` is not part of this project-management slice.

Changes:

- Added `src/lib/effect/project-management-service.ts` with `ProjectManagementServiceTag`,
  `ProjectManagementServiceLive`, `ProjectManagementServiceError`, and `ProjectManagementNotSupported`.
- Converted `get_projects`, `add_project`, `remove_project`, and `rename_project` handlers to consume
  `ProjectManagementServiceTag` instead of direct `ConfigTag` / `OpenCodeSettingsServiceTag` project callbacks.
- Converted `set_project_instance` to consume `ProjectManagementServiceTag` instead of `ProjectMgmtTag`, while
  preserving its existing `INSTANCE_ERROR` envelope and `{ type: "project_list", projects }` broadcast shape.
- Wired `ProjectManagementServiceLive` into the relay runtime and shared handler test layer from
  `ConfigTag + OpenCodeSettingsServiceLive`.
- Added service tests for config-backed listing, OpenCode fallback mapping, unsupported mutations, callback failure
  wrapping, rename refresh, and project-instance binding.
- Added handler-boundary tests for `get_projects`, `add_project`, `rename_project`, `remove_project` failure rendering,
  and `set_project_instance` success/unavailable/failure behavior without the legacy `ProjectMgmtTag`.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/project-management-service.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/effect/project-management-service.js'
```

```text
$ pnpm vitest run test/unit/handlers/project-management-service-effect.test.ts
Exit: 1
Expected failures before handler conversion:
  Service not found: Config
  setProjectInstance service spy had 0 calls
```

Verification:

```text
$ pnpm vitest run test/unit/effect/project-management-service.test.ts \
  test/unit/handlers/project-management-service-effect.test.ts \
  test/unit/handlers/settings-service-effect.test.ts \
  test/unit/handlers/settings-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  6 passed (6)
Tests  105 passed (105)
```

```text
$ pnpm vitest run test/unit/handlers test/unit/effect/project-management-service.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  23 passed (23)
Tests  205 passed (205)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 981 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  367 passed (367)
Tests  5218 passed | 2 skipped | 12 todo (5232)
```

## Phase 7.29: Instance Handler Domain Service Contract

Plan issues found:

- Phase 7 groups instance and project management together, but the current handlers have three distinct remaining
  boundaries: instance lifecycle, project binding, and port scanning. Combining them would mix daemon-owned instance
  lifecycle with project-registry mutation and scanner behavior in one review.
- A first service draft was rejected during review because it was handler-shaped: it accepted `clientId`, depended on
  `WebSocketHandlerTag`, and rendered browser errors itself. That would only hide `InstanceMgmtTag` behind a new name.
  The corrected boundary is domain-shaped: it returns updated instance lists or typed operation errors, while the
  handler keeps payload validation and WebSocket envelope rendering.
- The service still adapts the existing daemon `InstanceMgmtTag` bridge because the current Effect-native
  `instance-manager-service.ts` does not yet preserve the old class' process spawning, kill, restart, and health-check
  behavior. Replacing that class-backed daemon owner is a later daemon-owned state/process slice, not a handler
  contract slice.
- `ProjectMgmtTag` and `ScanDepsTag` remain open. Project management is split across settings handlers, project
  binding, and OpenCode fallback reads; scanner migration needs a real `scanNow` Effect service instead of just the
  current `PortScannerTag.getKnownPorts()`.

Changes:

- Added `src/lib/effect/instance-management-service.ts` with `InstanceManagementServiceTag`,
  `InstanceManagementServiceLive`, and typed `InstanceManagementServiceError`.
- Converted instance add/remove/start/stop/update/rename handlers to consume only `InstanceManagementServiceTag` plus
  `WebSocketHandlerTag`; direct `InstanceMgmtTag` access moved out of `src/lib/handlers/instance.ts`.
- Kept browser-visible behavior in the handler: unavailable-service messages, validation errors, typed error rendering,
  and `instance_list` broadcasts after successful mutations.
- Wired `InstanceManagementServiceLive` into relay runtime composition when daemon instance management is available.
- Added live-service tests for ID derivation/uniqueness, unmanaged URL defaults, typed start failures, and rename
  trimming; added handler-boundary tests proving the handler can run without the legacy `InstanceMgmtTag`.

TDD red check:

```text
$ pnpm vitest run test/unit/effect/instance-management-service.test.ts \
  test/unit/handlers/instance-service-effect.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/effect/instance-management-service.js'
```

Verification:

```text
$ pnpm vitest run test/unit/effect/instance-management-service.test.ts \
  test/unit/handlers/instance-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  89 passed (89)
```

```text
$ pnpm vitest run test/unit/handlers test/unit/effect/instance-management-service.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  22 passed (22)
Tests  194 passed (194)
```

```text
$ rg -n "InstanceMgmtTag|instanceMgmt|addInstance|removeInstance|startInstance|stopInstance|updateInstance|persistConfig" \
  src/lib/handlers/instance.ts
Exit: 1
No direct instance-management bridge access remains in the browser instance lifecycle handlers.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 978 files. No fixes applied.
```

## Phase 7.28: Client Init Terminal Replay Service Contract

Plan issues found:

- Phase 7.27 moved terminal handlers to `OpenCodeTerminalService`, but `client-init` still read `PtyManager`
  directly for reconnect replay. Leaving that in place would keep two PTY owners: handlers would use the Effect
  terminal boundary, while new-client bootstrap would keep coupling to relay-local PTY internals.
- Moving replay to `PtyManagerStateTag` would repeat the false-migration problem from the handler slice. The replay
  behavior needs the production `PtyManager` scrollback and exit state until the full PTY owner is migrated, so the
  correct boundary is the terminal service, not a parallel state Ref.
- The bridge test should prove `client-init` depends only on a terminal replay port. The wire behavior belongs in the
  terminal service tests, where it can exercise the real in-memory `PtyManager` rather than duplicating low-level
  fixture setup in the bootstrap handler.

Changes:

- Added `OpenCodeTerminalService.replay(clientId)` to send tracked PTY sessions, scrollback, and exited state to a
  single reconnecting client.
- Replaced `ClientInitDeps.ptyManager` with a narrow `terminal.replay(clientId)` port.
- Wired the relay bootstrap dependency through `OpenCodeTerminalServiceTag` in the relay `ManagedRuntime`.
- Updated mock factories and handler service mocks for the expanded terminal service interface.
- Moved replay wire behavior coverage from `client-init` tests into `test/unit/effect/terminal-service.test.ts`, while
  keeping a `client-init` boundary test that proves bootstrap calls the terminal replay port.

TDD red check:

```text
$ pnpm vitest run test/unit/effect/terminal-service.test.ts --testNamePattern "replays|replay"
Exit: 1
Expected failure:
  service.replay is not a function
```

Verification:

```text
$ pnpm vitest run test/unit/effect/terminal-service.test.ts --testNamePattern "replays|replay"
Exit: 0
Tests  2 passed | 5 skipped (7)
```

```text
$ pnpm vitest run test/unit/mock-factories.test.ts \
  test/unit/effect/terminal-service.test.ts \
  test/unit/bridges/client-init.test.ts \
  test/unit/handlers/terminal-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  143 passed (143)
```

```text
$ rg -n "ptyManager|PtyManager|PtyInfo" src/lib/bridges/client-init.ts test/unit/bridges/client-init.test.ts
Exit: 1
No remaining direct PTY manager reads in client-init or its tests.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 975 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  363 passed (363)
Tests  5196 passed | 2 skipped | 12 todo (5210)
```

```text
$ pnpm exec vitest run --config vitest.integration.config.ts test/integration/flows/terminal.integration.ts
Exit: 0
Test Files  1 passed (1)
Tests  9 passed (9)
```

## Phase 7.27: Terminal Handler Service Contract

Plan issues found:

- Phase 7 lists PTY methods after permission/question, but a direct handler swap to `PtyManagerStateTag` would be a
  false migration. `src/lib/effect/pty-manager-service.ts` is only a state Ref and does not own upstream WebSocket
  lifecycle, provider PTY create/list/delete/resize calls, scrollback, explicit-close suppression of `pty_exited`, or
  reconnect behavior.
- The safe boundary is a terminal service that owns the current production PTY trio together: OpenCode PTY API,
  relay-local `PtyManager`, and `connectPtyUpstream`. Otherwise handlers would still coordinate transport wiring and
  the migration would only rename bridge tags.
- `pty_created` must still broadcast before upstream connection begins. On connect failure, the service must preserve
  the optimistic-tab cleanup sequence: `pty_created`, then `pty_deleted`, then `PTY_CONNECT_FAILED`.
- Client-init PTY replay still uses the imperative `PtyManager` and should move in a later slice with the same service
  owner. Moving only handler state replay now would split PTY source-of-truth.

Changes:

- Added `src/lib/effect/terminal-service.ts` with `OpenCodeTerminalServiceTag` and `OpenCodeTerminalServiceLive`.
- The live service owns create/connect, list/reconnect, input, resize, and close/delete behavior while preserving the
  existing browser envelopes and non-fatal resize/reconnect warning semantics.
- Converted `src/lib/handlers/terminal.ts` to consume only `OpenCodeTerminalServiceTag`; it no longer imports
  `OpenCodeAPITag`, `PtyManagerTag`, `ConnectPtyUpstreamTag`, `ConfigTag`, `RelayError`, or PTY DTO shaping.
- Wired `OpenCodeTerminalServiceLive` into relay `ManagedRuntime` composition and shared handler test Layer wiring.
- Added live-service tests using a real in-memory `PtyManager` plus fake provider/upstream ports, and handler boundary
  tests proving terminal handlers run without the legacy OpenCode/PtyManager tags.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/terminal-service-effect.test.ts
Exit: 1
Expected failures:
  Service not found: PtyManager
  Service not found: OpenCodeAPI
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/terminal-service-effect.test.ts \
  test/unit/effect/terminal-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  83 passed (83)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 975 files. No fixes applied.
```

```text
$ pnpm exec vitest run --config vitest.integration.config.ts test/integration/flows/terminal.integration.ts
Exit: 0
Test Files  1 passed (1)
Tests  9 passed (9)
```

```text
$ rg -n "OpenCodeAPITag|PtyManagerTag|ConnectPtyUpstreamTag|ConfigTag|RelayError|formatErrorDetail|PtyInfo|PtyStatus" \
  src/lib/handlers/terminal.ts
Exit: 1
No remaining terminal-handler imports for legacy OpenCode API, PTY manager, upstream connector, or terminal DTO shaping.
```

## Phase 7.26: Pending Interaction Waiter Ownership And Bridge Removal

Plan issues found:

- Treating `PermissionBridgeTag` / `QuestionBridgeTag` as thin Effect wrappers would preserve the real split-brain
  bug: replay metadata would live in one owner while Claude SDK waiters lived in `RelayEventSink` local maps.
- Browser permission/question handlers must not both resolve the service waiter and dispatch a Claude engine
  resolution command. That double-resolution path can race and log false "unknown request" failures.
- Browser permission/question responses must use the pending service's owner session, not the answering client's
  currently visible session. Otherwise a global permission or replayed question answered while viewing another session
  replies to OpenCode, routes provider detection, updates pending counts, and broadcasts resolution against the wrong
  session.
- Permission timeout handling cannot only delete replay metadata. Once waiters are service-owned, timeout eviction must
  also fail the active waiter or the SDK request can hang after the UI sees a timeout.
- Keeping optional bridge fallback branches in `client-init` or `relay-event-sink` would leave a production
  compatibility path that bypasses the new Effect owner. Those branches were removed rather than documented as
  temporary debt.
- Full-suite replay exposed a separate mid-migration split-brain: `handleForkSession` writes fork metadata through
  `SessionManagerService`, but some SSE/status refresh broadcasts still flow through the legacy `SessionManager`.
  While both managers coexist, service-owned fork metadata must be mirrored into the legacy bridge or later
  `session_list` refreshes can erase fork rendering metadata in the browser.
- The legacy `SessionManager` SQLite read-query path also dropped its own `forkMeta` overlay before adapting rows.
  That made fork metadata preservation depend on whether a session list used the provider API or SQLite projection.

Changes:

- Expanded `PendingInteractionService` so it owns pending permission replay, pending question replay, active
  permission/question waiters, browser resolution, SDK-side resolution, session cancellation, recovery, and timeout
  eviction.
- Migrated Claude `RelayEventSink` interaction requests to the pending interaction service port. The sink no longer
  keeps local pending maps and no longer accepts generic permission/question bridge dependencies.
- Migrated `handleMessage` to build Claude event sinks from `PendingInteractionServiceTag`; `PermissionBridgeTag` and
  `QuestionBridgeTag` were removed from handler dependencies and the relay Layer graph.
- Migrated Claude browser permission/question response paths to resolve through the pending interaction service instead
  of redispatching into the orchestration engine.
- Returned the service-owned permission/question session from browser resolution and used it for REST replies, provider
  routing, pending-question counts, processing timeout restarts, and browser resolution broadcasts.
- Migrated `handleClientConnected(...)` and session metadata question replay to `PendingInteractionServiceTag`, with
  OpenCode API recovery still deduped against service-owned state.
- Mirrored `SessionManagerServiceLive.setForkEntry(...)` into the legacy `SessionManagerTag` while that compatibility
  bridge remains, so legacy SSE/status broadcasts cannot overwrite fork metadata with stale session rows.
- Fixed the legacy `SessionManager` SQLite list path to pass its in-memory fork metadata into
  `sessionRowsToSessionInfoList(...)`, matching the provider API list path.
- Deleted the unused generic `PermissionBridge`, the dormant `RelayTimers` wrapper, and the stale `QuestionBridge`
  state class. `question-bridge.ts` now only contains the still-used OpenCode question field mapper.
- Confirmed the AGENTS guidance reflects the current OpenCode SDK/API client and Claude Agent SDK setup rather than a
  fixed `localhost:4096` OpenCode debug instance.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/pending-interaction-service.test.ts -t "fails active permission waiters"
Exit: 1
Expected failure:
  waiter remained unresolved after takeTimedOutPermissions removed the replay entry.
```

```text
$ pnpm check
Exit: 2
Expected failure:
  tests/helpers still provided PermissionBridgeTag and QuestionBridgeTag after the source tags were removed.
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts --testNamePattern "legacy session manager bridge"
Exit: 1
Expected failure:
  service.setForkEntry() did not call the legacy SessionManagerTag bridge.
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts --testNamePattern "pending permission session"
Exit: 1
Expected failure:
  permission_response for a service-owned permission used the responding client's visible session instead of the
  permission's owner session.
```

```text
$ pnpm vitest run test/unit/effect/pending-interaction-service.test.ts test/unit/handlers/effect-handlers.test.ts --testNamePattern "owner session|visible session|pending question session|maps browser permission decisions"
Exit: 1
Expected failure:
  service-owned question resolution returned no owner session, and browser answer/reject handlers fell through to the
  OpenCode REST path when the client was viewing another session.
```

Verification:

```text
$ pnpm vitest run test/unit/effect/pending-interaction-service.test.ts -t "fails active permission waiters|takes timed-out"
Exit: 0
Tests 2 passed | 6 skipped
```

```text
$ pnpm vitest run test/unit/bridges/question-bridge.test.ts \
  test/unit/provider/relay-event-sink.test.ts \
  test/unit/pipeline/event-translation-snapshots.test.ts \
  test/unit/bridges/client-init.test.ts \
  test/unit/effect/pending-interaction-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/prompt-provider-state-effect.test.ts \
  test/unit/effect/services.test.ts \
  test/unit/mock-factories.test.ts
Exit: 0
Test Files  10 passed (10)
Tests  204 passed (204)
Note: run emitted existing Node SQLite experimental warnings.
```

```text
$ pnpm vitest run test/unit/session/conduit-owned-fields.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  7 passed (7)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts --testNamePattern "legacy session manager bridge"
Exit: 0
Tests  1 passed | 19 skipped
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts --testNamePattern "pending permission session"
Exit: 0
Tests  1 passed | 72 skipped
```

```text
$ pnpm vitest run test/unit/effect/pending-interaction-service.test.ts test/unit/handlers/effect-handlers.test.ts --testNamePattern "owner session|visible session|pending question session|maps browser permission decisions"
Exit: 0
Tests  4 passed | 80 skipped
```

```text
$ pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/fork-session.spec.ts --project=desktop
Exit: 0
Tests  5 passed
```

```text
$ pnpm exec vitest run --config vitest.contract.config.ts test/contract/tool-sse-transitions.contract.ts --reporter=verbose
Exit: 0
Test Files  1 passed (1)
Tests  13 passed (13)
Note: this reran the live OpenCode contract failure seen during `pnpm test:all`; the narrow rerun passed in 146.88s.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 972 files. No fixes applied.
```

```text
$ pnpm test:unit > unit-output.log 2>&1 || (echo "Unit tests failed, see unit-output.log" && exit 1)
Exit: 0
Test Files  361 passed (361)
Tests  5188 passed | 2 skipped | 12 todo (5202)
Note: run emitted existing Node SQLite experimental warnings and an existing MaxListenersExceededWarning in component tests.
```

```text
$ pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
Exit: 0
All steps passed, including unit, integration, contract, E2E, multi-instance, subagent, visual, Storybook build, and
Storybook visual tests.
```

```text
$ rg -n "PermissionBridgeTag|QuestionBridgeTag|permission-bridge|relay-timers|class QuestionBridge|permissionBridge\\??:|questionBridge\\??:" \
  src test --glob '!test/e2e/fixtures/subagent-snapshot.json' --glob '!src/lib/provider/claude/*' \
  --glob '!test/unit/provider/claude/*'
Exit: 1
No remaining generic permission/question bridge tags, generic permission bridge module, dormant relay timers, or
generic question bridge state outside the Claude SDK adapter boundary.
```

## Phase 7.11: Session List Handler Service Contract

Plan issues found:

- `handleListSessions` looked like a narrow handler conversion, but the existing Effect
  `SessionManagerService.listSessions` returned raw provider sessions instead of the frontend
  `SessionInfo[]` shape produced by the legacy `SessionManager`. Converting the handler directly
  would have dropped title fallback, message-activity ordering, fork metadata, parent IDs,
  pending-question counts, and processing flags.
- The existing Effect service rebuilt `cachedParentMap` on roots-only fetches. Legacy
  `SessionManager.listSessions({ roots: true })` deliberately does not do that because roots-only
  responses omit children and would wipe subagent parent mappings.
- `SessionManagerServiceLive` could not remain a `Layer.succeed` of free functions once handlers
  consumed it directly. The service layer now captures OpenCode, session-manager state, logger, and
  optional status-poller dependencies so handler effects do not leak service implementation
  requirements.

Changes:

- Extracted the provider-session to frontend-session projection into
  `src/lib/session/session-info-list.ts` and reused it from both the legacy class and the Effect
  service.
- Extended `SessionManagerService` with Effect-native `sendDualSessionLists`, preserving roots-first
  delivery, background all-sessions delivery, background failure logging, parent-map preservation,
  status fallback, and `SessionInfo[]` shaping.
- Converted `handleListSessions` to use `SessionManagerServiceTag` instead of the legacy
  `SessionManagerTag`.
- Updated relay Layer composition so the session-manager state ref and service are built together,
  then provided from the relay bridge Layer graph.
- Added handler/service tests and kept the list-session wire snapshot stable.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/session-manager-service-effect.test.ts
Exit: 1
Expected failure:
  Service not found: SessionManager
```

Verification:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/session-manager-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  8 passed (8)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 975 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  363 passed (363)
Tests  5164 passed | 2 skipped | 12 todo (5178)
```

## Phase 7.12: View Session Metadata List Service Contract

Plan issue found:

- `sendSessionMetadata` still used `Effect.tryPromise(() => sessionMgr.sendDualSessionLists(...))`.
  That left the view-session metadata path on the legacy `SessionManagerTag` even after the direct
  `list_sessions` handler moved to `SessionManagerServiceTag`.

Changes:

- Converted the session-list send inside `sendSessionMetadata` to call
  `SessionManagerServiceTag.sendDualSessionLists` directly.
- Tightened the handler regression test so the legacy session manager list sender throws if called,
  while the Effect service sender succeeds.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts
Exit: 1
Expected failure:
  legacySendDualSessionLists was called once by view-session metadata.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  64 passed (64)
```

```text
$ pnpm check
Exit: 0
```

## Phase 7.13: New Session List Broadcast Service Contract

Plan issue found:

- `handleNewSession` cannot be blindly moved to `SessionManagerService.createSession` yet because
  the legacy manager still owns lifecycle-specific behavior around `createSession(title,
  { silent: true })`, immediate tab switching, request-id echoing, skipped history replay, and
  skipped poller seeding. The safe Effect boundary for this slice is the post-create
  `sendDualSessionLists` broadcast only.

Changes:

- Converted `handleNewSession`'s post-create session-list broadcast to call
  `SessionManagerServiceTag.sendDualSessionLists`.
- Added handler regressions proving new-session creation still switches the requesting client,
  broadcasts the service-produced list envelope, does not call the legacy list sender, and logs
  list-broadcast failures without failing the created session flow.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts
Exit: 1
Expected failure:
  handleNewSession never called SessionManagerServiceTag.sendDualSessionLists.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  61 passed (61)
```

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  66 passed (66)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 975 files. No fixes applied.
```

## Phase 7.14: Delete Session List Broadcast Service Contract

Plan issues found:

- `handleDeleteSession` still used `Effect.tryPromise(() => sessionMgr.sendDualSessionLists(...))`
  for the final session-list broadcast, keeping one lifecycle path on the legacy list sender.
- The delete handler can switch viewers and send metadata after deletion, so its typed dependency
  surface includes OpenCode model/API and permission/question bridge services even when a narrow
  test has no viewers. The test layer now provides that full possible boundary rather than hiding
  the handler's environment.
- Unlike `new_session`, the existing delete-session list broadcast was not fail-open. This slice
  preserves that behavior instead of introducing new warning-only semantics.

Changes:

- Converted `handleDeleteSession`'s final session-list broadcast to call
  `SessionManagerServiceTag.sendDualSessionLists`.
- Added a handler regression proving delete still uses `deleteSession(..., { silent: true })`,
  emits `session_deleted`, broadcasts the service-produced list envelope, and does not call the
  legacy list sender.
- Generalized the session lifecycle handler test Layer so new-session/delete tests provide the
  services required by the full lifecycle and metadata paths.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts
Exit: 1
Expected failure:
  handleDeleteSession still called the legacy sendDualSessionLists Promise path.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  67 passed (67)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 975 files. No fixes applied.
```

## Phase 7.15: Delete Session Multi-Viewer Coverage

Plan issue found:

- The first delete-session service-boundary regression covered the zero-viewer path only. The
  handler also has a multi-viewer path that switches every viewer to the next session and replays
  metadata before sending the final broadcast list. That path exercises the full typed dependency
  surface and is the higher-risk delete behavior.

Changes:

- Added a multi-viewer `handleDeleteSession` regression that proves both viewers are switched to
  the remaining session, both receive metadata replay, `session_deleted` is broadcast, the final
  session list comes from `SessionManagerServiceTag`, and the legacy list sender is not called.
- No production code changed; the Phase 7.14 implementation already satisfied this behavior.

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleDeleteSession"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 61 skipped (63)
```

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  68 passed (68)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 975 files. No fixes applied.
```

## Phase 7.16: Fork Session List Broadcast Service Contract

Plan issues found:

- A mechanical `handleForkSession` broadcast swap would have split fork metadata ownership. The
  handler wrote fork metadata through the legacy `SessionManager`, while the Effect service list
  path reads from `SessionManagerStateTag`; the final list broadcast would have lost `parentID`,
  `forkMessageId`, and `forkPointTimestamp`.
- `SessionManagerServiceLive` started with empty fork metadata, so persisted fork metadata in
  `fork-metadata.json` was invisible after a daemon restart.
- The Effect service list path used provider API reads even when a SQLite read query service was
  available. That was a source-of-truth regression from the legacy manager, which prefers the
  read model when present.
- SQLite session rows persist `parent_id` and `fork_point_event`, but not `forkPointTimestamp`.
  This slice preserves timestamp metadata through service state and the existing JSON file. A
  canonical persisted fork event/projector migration remains the durable long-term follow-up.

Changes:

- Added `SessionManagerService.setForkEntry`, backed by `SessionManagerStateTag` and the existing
  fork metadata JSON persistence.
- Converted `handleForkSession` to write fork metadata and send the final session-list broadcast
  through `SessionManagerServiceTag`.
- Taught `SessionManagerServiceLive` to load persisted fork metadata at layer construction.
- Taught service `listSessions` to prefer `ReadQueryEffectTag`, fall back to `ReadQueryTag`, and
  only then call the provider API.
- Extended the SQLite session-list adapter so service-owned fork metadata overlays rows that do
  not carry full fork details.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts -t "fork metadata|handleForkSession"
Exit: 1
Expected failures:
  SessionManagerService.setForkEntry was missing.
  handleForkSession still called legacy sendDualSessionLists.
```

Verification:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts \
  test/unit/persistence/session-list-adapter.test.ts \
  test/unit/persistence/read-query-service.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  102 passed (102)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ pnpm test:unit > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
Exit: 0
Test Files  363 passed (363)
Tests  5173 passed | 2 skipped | 12 todo (5187)
```

## Phase 7.17: Session Lifecycle List Read Service Contract

Plan issues found:

- After the session-list broadcast migration, `handleDeleteSession` and `handleForkSession` still
  read session lists through the legacy `SessionManager`. That left the lifecycle handlers split
  between the Effect service for broadcast state and the legacy manager for control-flow reads.
- `handleDeleteSession` read the full session list even when no clients were viewing the deleted
  session. The list is only needed to choose a fallback session for viewers, so the zero-viewer
  path should not hit either session-list source.

Changes:

- Converted the delete-session viewer fallback read to `SessionManagerServiceTag.listSessions`.
- Skipped the delete-session fallback read entirely when there are no viewers to switch.
- Converted the fork-session parent-title lookup to `SessionManagerServiceTag.listSessions`.
- Tightened handler tests so legacy `sessionMgr.listSessions` throws if either lifecycle path
  uses it.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleDeleteSession|handleForkSession"
Exit: 1
Expected failure:
  legacy listSessions should not be used
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleDeleteSession|handleForkSession"
Exit: 0
Test Files  1 passed (1)
Tests  5 passed | 58 skipped (63)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  68 passed (68)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ pnpm test:unit > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
Exit: 0
Test Files  363 passed (363)
Tests  5173 passed | 2 skipped | 12 todo (5187)
```

## Phase 7.18: Search Sessions Service Contract

Plan issue found:

- `handleSearchSessions` still delegated to legacy `SessionManager.searchSessions`, even though
  session list reads now belong to `SessionManagerServiceTag`. That kept search on the provider
  API path and bypassed the Effect service's SQLite read preference, fork metadata overlay, and
  pending-question projection.

Changes:

- Converted `handleSearchSessions` to read sessions through `SessionManagerServiceTag.listSessions`
  and apply the existing case-insensitive title/id filter in the handler.
- Preserved the existing `roots` behavior by passing `{ roots: true }` to the service before
  filtering when the search payload requests roots.
- Tightened handler tests so legacy `sessionMgr.searchSessions` throws if search regresses to the
  legacy path.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleSearchSessions"
Exit: 1
Expected failure:
  legacy searchSessions should not be used
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleSearchSessions"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 62 skipped (64)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  69 passed (69)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

## Phase 7.19: Rename Session Service Contract

Plan issue found:

- `handleRenameSession` could not be converted by only swapping the provider mutation. Legacy
  `SessionManager.renameSession` also refreshed the session list via its internal broadcast path,
  so the handler must explicitly broadcast through `SessionManagerServiceTag` after the service
  mutation.
- This is a browser `rename_session` slice, not global rename retirement. Claude auto-title in
  `src/lib/handlers/prompt.ts` still calls legacy `sessionMgr.renameSession` and should be
  handled with the prompt/session-send ownership work.

Changes:

- Added `SessionManagerService.renameSession`, backed by `OpenCodeAPITag.session.update`.
- Converted `handleRenameSession` to call `SessionManagerServiceTag.renameSession` and then
  `sendDualSessionLists` with `wsHandler.broadcast`.
- Tightened handler tests so legacy `sessionMgr.renameSession` throws if rename regresses to the
  legacy path, mutation happens before list refresh, and the refreshed session-list broadcast
  remains observable.
- Added a `rename_session` wire snapshot for the roots-first/background-all broadcast envelope.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "renames"
Exit: 1
Expected failure:
  renameSession was not exported by SessionManagerService.
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleRenameSession"
Exit: 1
Expected failure:
  legacy renameSession should not be used
```

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts -t "rename_session"
Exit: 1
Expected failure:
  rename_session_success snapshot did not exist yet.
```

Verification:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "renames"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 9 skipped (10)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleRenameSession"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 62 skipped (64)
```

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts -t "rename_session"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 2 skipped (3)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  80 passed (80)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

## Phase 7.20: History Pagination Service Ownership

Plan issues found:

- `load_more_history` could not move to `SessionManagerServiceTag` by itself. The initial
  `view_session` REST history load owns the cursor that later `load_more_history` consumes, and
  fork/rewind invalidate that same cursor. Moving only the explicit load-more handler would split
  pagination state between the legacy `SessionManager` and the Effect service.
- `src/lib/session/session-switch.ts` still exposes the legacy async switch helper for older
  bridge surfaces, so this slice only retires the browser Effect handler path. Prompt send-turn
  prior-history loading still uses the legacy `sessionMgr.loadPreRenderedHistory` boundary and
  belongs with the prompt/session-send migration.
- The SQLite view-session path can return a paged `rest-history` source without calling REST, so
  the Effect switch path now seeds the service cursor from the oldest returned history message when
  `hasMore` is true. This fixes the same ownership gap for SQLite-backed first pages.

Changes:

- Added service-owned `loadPreRenderedHistory`, `loadHistory`, `seedPaginationCursor`, and
  `clearPaginationCursor` around `OpenCodeAPITag.session.messagesPage` and
  `SessionManagerStateTag.paginationCursors`.
- Preserved legacy history semantics: offset loads without a cursor return an empty final page,
  the oldest returned message becomes the next cursor, stale 400 cursors fall back to a full cursor
  scan, and assistant text parts are pre-rendered before history leaves the service.
- Converted the Effect `handleViewSession` session-switch path to resolve REST history through
  `SessionManagerServiceTag`, seed the service cursor, and keep the existing `session_switched`,
  status, notification, and poller behavior.
- Converted `handleLoadMoreHistory`, `handleForkSession`, and `handleRewind` cursor operations to
  `SessionManagerServiceTag`.
- Added handler and wire-snapshot canaries so legacy history/cursor methods throw if the browser
  Effect path regresses to them.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "history|pagination|cursor"
Exit: 1
Expected failure:
  loadPreRenderedHistory, loadHistory, seedPaginationCursor, and clearPaginationCursor were not
  implemented on SessionManagerService.
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleLoadMoreHistory"
Exit: 1
Expected failure:
  legacy loadPreRenderedHistory should not be used
```

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts -t "REST history"
Exit: 1
Expected failure:
  SessionManagerService.loadPreRenderedHistory was not called by view_session.
```

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts -t "load_more_history"
Exit: 1
Expected failure:
  load_more_history_success snapshot did not exist yet.
```

Verification:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "history|pagination|cursor"
Exit: 0
Test Files  1 passed (1)
Tests  4 passed | 10 skipped (14)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleLoadMoreHistory|handleRewind"
Exit: 0
Test Files  1 passed (1)
Tests  3 passed | 62 skipped (65)
```

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts -t "REST history"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 3 skipped (4)
```

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts -t "load_more_history"
Exit: 0
Test Files  1 passed (1)
Tests  1 passed | 3 skipped (4)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts \
  test/unit/session/session-switch.test.ts \
  test/unit/relay/markdown-renderer.test.ts
Exit: 0
Test Files  6 passed (6)
Tests  139 passed (139)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.21: Session Create/Delete Lifecycle Service Contract

Plan issues found:

- `new_session` and `delete_session` could not safely switch to the existing
  `SessionManagerService.createSession/deleteSession` methods alone. The legacy
  `SessionManager.createSession/deleteSession({ silent: true })` suppressed automatic list
  broadcasts but still emitted `session_lifecycle`, which `SessionEventBridgeLive` forwarded to
  `DaemonEventBus` for `SessionLifecycleWiringLive`.
- Lifecycle publication therefore belongs in `SessionManagerServiceLive`, after successful provider
  mutation and state cleanup. The handlers must keep owning WebSocket switch, delete, and
  session-list envelopes so the service does not grow hidden broadcast side effects.
- Adding `DaemonEventBusTag` to `SessionManagerServiceLive` also required Relay layer composition to
  provide the same bus instance to the service and downstream lifecycle wiring. A private bus inside
  the service would pass unit tests while dropping production lifecycle events.

Changes:

- Converted `handleNewSession` and `handleDeleteSession` to call
  `SessionManagerServiceTag.createSession/deleteSession`; `src/lib/handlers/session.ts` no longer
  imports `SessionManagerTag`.
- `SessionManagerServiceLive.createSession` now publishes one `SessionCreated` event after the
  provider create succeeds, and `deleteSession` publishes one `SessionDeleted` event after provider
  delete and service state cleanup succeed.
- `RelayStateLive` now builds `SessionManagerServiceLive` with `makeSessionManagerStateLive()` and
  `DaemonEventBusLive` in one dependency layer, so lifecycle subscribers observe the same bus.
- Handler tests now make legacy `createSession/deleteSession` throw if the browser lifecycle path
  regresses to the old manager, while preserving request-id echo, viewer switching, metadata replay,
  explicit `session_deleted`, and session-list broadcasts.
- Added `new_session` and `delete_session` wire snapshots for the session switch/status/delete/list
  envelopes affected by this ownership move.

TDD red checks:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "creates and switches before broadcasting lists through SessionManagerService"
Exit: 1
Expected failure:
  legacy createSession should not be used
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "deletes and broadcasts lists through SessionManagerService"
Exit: 1
Expected failure:
  legacy deleteSession should not be used
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "live service publishes"
Exit: 1
Expected failures:
  expected null to match object { _tag: 'SessionCreated', sessionId: 'created-session' }
  expected null to match object { _tag: 'SessionDeleted', sessionId: 'deleted-session' }
```

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts -t "new_session|delete_session"
Exit: 1
Expected failure:
  new_session_success and delete_session_success snapshots did not exist yet.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleNewSession|handleDeleteSession"
Exit: 0
Test Files  1 passed (1)
Tests  4 passed | 61 skipped (65)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "live service publishes"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 14 skipped (16)
```

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts -t "new_session|delete_session"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 4 skipped (6)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts \
  test/unit/effect/session-lifecycle-wiring.test.ts \
  test/unit/effect/session-event-bridge.test.ts
Exit: 0
Test Files  5 passed (5)
Tests  100 passed (100)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ pnpm test:unit
Exit: 0
Test Files  363 passed (363)
Tests  5187 passed | 2 skipped | 12 todo (5201)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.22: Prompt Send-Turn Session Service Contract

Plan issues found:

- `src/lib/handlers/prompt.ts` could not be converted by only swapping the two pre-dispatch
  calls. `recordMessageActivity` and prior-history fallback run inside `Effect.gen`, but Claude
  auto-rename ran in a raw `Promise.then(...)` continuation after fire-and-forget dispatch.
- Calling `SessionManagerService` from that raw promise callback would either add new
  `Effect.runPromise` scatter or fake an async adapter. The long-term fix is to launch one
  fire-and-forget Effect continuation with `Effect.forkDaemon`, preserving immediate dispatch
  behavior while keeping service methods as Effects.
- Legacy `SessionManager.renameSession` included an implicit session-list broadcast. The service
  rename path does not, so prompt auto-rename now explicitly calls `sendDualSessionLists` after a
  successful service rename to preserve the visible session-list refresh.

Changes:

- Removed `SessionManagerTag` from `src/lib/handlers/prompt.ts`.
- `handleMessage` now records message activity through
  `SessionManagerServiceTag.recordMessageActivity`.
- Claude prior-history fallback now uses `SessionManagerServiceTag.loadPreRenderedHistory`; Effect
  and sync SQLite readers still take precedence.
- Replaced the raw dispatch `.then/.catch` continuation with an Effect program launched by
  `Effect.forkDaemon`. Dispatch is still started immediately; result handling, provider-state
  update persistence, auto-rename, and dispatch failure recovery now run in Effect.
- Claude first-turn auto-rename now uses `SessionManagerServiceTag.listSessions`,
  `renameSession`, and explicit `sendDualSessionLists` broadcast. Custom titles still prevent
  auto-rename.
- Updated persistence-backed prompt tests to stop providing `SessionManagerTag`.

TDD red checks:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "sends message via legacy path when no engine"
Exit: 1
Expected failure:
  legacy recordMessageActivity should not be used
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "loads prior Claude history through SessionManagerService"
Exit: 1
Expected failure:
  SessionManagerService.loadPreRenderedHistory was not called by the Claude fallback path.
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "auto-renames first Claude turn|does not auto-rename Claude sessions with custom titles"
Exit: 1
Expected failure:
  SessionManagerService.listSessions was not called by the auto-rename continuation.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleMessage"
Exit: 0
Test Files  1 passed (1)
Tests  9 passed | 60 skipped (69)
```

```text
$ pnpm vitest run test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  4 passed (4)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/prompt-provider-state-effect.test.ts
Exit: 0
Test Files  2 passed (2)
Tests  73 passed (73)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ pnpm test:unit
Exit: 0
Test Files  363 passed (363)
Tests  5191 passed | 2 skipped | 12 todo (5205)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.23: Permissions Pending-Question Service Contract

Plan issues found:

- `src/lib/handlers/permissions.ts` only used `SessionManagerTag` for pending-question
  decrements, but replacing that with a handler-local helper would leave the ownership split.
  Session lists already project `pendingQuestionCounts` from `SessionManagerState`, so question
  resolution must mutate the same state owner.
- The long-term boundary is a service-owned pending-question API on `SessionManagerService`.
  This slice adds increment, decrement, and bulk-set operations together rather than adding only
  the one decrement method needed by permissions.
- A subagent audit caught the incomplete version of this slice: SSE `question.asked` and reconnect
  rehydration still incremented/set pending counts through the legacy manager while permissions
  decremented through the service. That would make `pendingQuestionCount` wrong after real question
  flow, so this slice also moves the SSE producer side to the same service-backed state.
- `handleQuestionReject` can return before resolving any session state when `toolId` is empty, so
  the service dependency is now requested after that guard.

Changes:

- Added `incrementPendingQuestionCount`, `decrementPendingQuestionCount`, and
  `setPendingQuestionCounts` free functions to `src/lib/effect/session-manager-service.ts`.
- Added those operations to `SessionManagerService` and `SessionManagerServiceLive`, backed by
  `SessionManagerStateTag`.
- Migrated `handleAskUserResponse` and `handleQuestionReject` in
  `src/lib/handlers/permissions.ts` from `SessionManagerTag.decrementPendingQuestionCount(...)` to
  `SessionManagerServiceTag.decrementPendingQuestionCount(...)`.
- Added a `pendingQuestionCounts` port to `SSEWiringDeps` and routed `question.asked` increments
  plus reconnect `listPendingQuestions` count replacement through that port instead of
  `sessionMgr`.
- Wired the production `pendingQuestionCounts` port in `src/lib/relay/relay-stack.ts` to
  `SessionManagerServiceTag` using the relay `ManagedRuntime`, keeping the imperative SSE edge
  thin while sharing `SessionManagerState`.
- Updated shared test mocks for the new service methods.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "pending question"
Exit: 1
Expected failure:
  pending-question service methods were missing and yielded non-Effect values.
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleQuestionReject|handleAskUserResponse"
Exit: 1
Expected failure:
  Service not found: SessionManager
```

```text
$ pnpm vitest run test/unit/relay/sse-wiring.test.ts -t "question.asked|pending question counts"
Exit: 1
Expected failure:
  pendingQuestionCounts.increment and pendingQuestionCounts.set were not called because SSE wiring
  still updated the legacy session manager.
```

Verification:

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts -t "pending question"
Exit: 0
Test Files  1 passed (1)
Tests  3 passed | 16 skipped (19)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "handleQuestionReject|handleAskUserResponse"
Exit: 0
Test Files  1 passed (1)
Tests  3 passed | 67 skipped (70)
```

```text
$ pnpm vitest run test/unit/relay/sse-wiring.test.ts -t "question.asked|pending question counts"
Exit: 0
Test Files  1 passed (1)
Tests  3 passed | 55 skipped (58)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/sse-wiring.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  147 passed (147)
```

```text
$ pnpm vitest run test/unit/effect/session-manager-service.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  19 passed (19)
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  70 passed (70)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  363 passed (363)
Tests  5196 passed | 2 skipped | 12 todo (5210)
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.24: Default Model Persistence Service Contract

Plan issues found:

- The original Phase 7.3 model-service slice explicitly left `handleSetDefaultModel`'s config write outside the
  service boundary. That meant the handler still required `OpenCodeAPITag` even though its provider-list read already
  used `OpenCodeModelServiceTag`.
- Moving only the provider-list read was not enough to claim the OpenCode model handler path was service-owned:
  default-model persistence is part of the same model contract and should live behind the same Effect-native service.
- A first pass only wrapped `client.config.update(...)` and left `fixupConfigFile(...)` in the handler. A reviewer
  correctly flagged that as a thin bridge, so this slice moves the OpenCode config update and the config-file fixup
  behind `OpenCodeModelService`.
- `fixupConfigFile(...)` lived under `src/lib/handlers/` even though permissions and model config writes both use it.
  This slice moves the helper to the OpenCode instance boundary.

Changes:

- `src/lib/effect/services.ts`: added `OpenCodeModelService.persistDefaultModel(providerID, modelID)` and wired the
  live service to format `provider/model`, call `client.config.update(...)`, and run the config-file fixup.
- `src/lib/instance/opencode-config-fixup.ts`: moved the OpenCode config write workaround out of handler code.
- `src/lib/handlers/model.ts`: `handleSetDefaultModel` now resolves `OpenCodeModelServiceTag` and calls
  `persistDefaultModel(...)` instead of resolving `OpenCodeAPITag`.
- `src/lib/handlers/permissions.ts`: updated the config fixup import to use the OpenCode instance helper.
- `src/lib/relay/relay-stack.ts` and `test/helpers/mock-factories.ts`: provide `ConfigTag` and `LoggerTag` to
  `OpenCodeModelServiceLive` because the live model service now owns project config persistence.
- `test/unit/handlers/model-service-effect.test.ts`: updated the default-model behavior test so it provides only the
  model service, proving the handler no longer needs the Promise-shaped OpenCode API tag; added live-service coverage
  for the OpenCode config update plus config-file relocation behavior.
- `test/unit/handlers/session-service-effect.test.ts`: updated typed model-service test doubles for the expanded
  service contract.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts -t "sets the OpenCode default model"
Exit: 1
Expected failure:
  Service not found: OpenCodeAPI
```

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts -t "persists OpenCode default model"
Exit: 1
Expected failure:
  yield* (intermediate value) is not iterable
  (`OpenCodeModelServiceLive` did not expose the domain persistence method yet.)
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts -t "sets the OpenCode default model|persists OpenCode default model"
Exit: 0
Test Files  1 passed (1)
Tests  2 passed | 3 skipped (5)
```

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts \
  test/unit/handlers/model-wire-snapshots.test.ts \
  test/unit/handlers/session-service-effect.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  15 passed (15)
```

```text
$ pnpm check
Exit: 0
```

## Phase 7.25: Pending Permission Interaction Service

Plan issues found:

- The Phase 7 plan says to convert permission/question bridge methods, but treating
  `PermissionBridgeTag` as a thin Effect wrapper would preserve the real state split. Pending permissions are read by
  SSE wiring, browser response handlers, session metadata replay, and timeout wiring, so this slice moves those
  permission paths to one Effect-owned state service.
- Moving only `handlePermissionResponse` would be incomplete: `permission.asked` would still store in the legacy
  bridge, or the handler would resolve a different state owner than the SSE producer. This slice migrates the selected
  producer/read/timeout paths together.
- The Claude/EventSink deferred permission path still has its own state and remains a separate follow-up. This slice
  intentionally does not migrate `QuestionBridgeTag` or Claude deferred waiters because those need a broader
  `relay-event-sink` migration.

Changes:

- Added `src/lib/effect/pending-interaction-service.ts` with `PendingInteractionServiceTag`, backed by `Ref` state and
  `Clock` timestamps.
- Added service methods for recording pending permissions, listing them by session, resolving browser decisions,
  marking OpenCode replies, recovering pending permissions from REST, and taking timed-out permissions.
- Migrated `handlePermissionResponse` from `PermissionBridgeTag.onPermissionResponse(...)` to
  `PendingInteractionServiceTag.resolvePermissionFromBrowser(...)`.
- Migrated `sendSessionMetadata` permission replay from `PermissionBridgeTag.getPending()` to
  `PendingInteractionServiceTag.listPendingPermissions(...)`, keeping API replay/dedup behavior.
- Migrated `sse-wiring.ts` permission asked/replied and reconnect recovery to a `pendingPermissions` composition port
  backed by `PendingInteractionServiceTag` in `relay-stack.ts`.
- Migrated `PermissionTimeoutLive` from `PermissionBridgeTag.checkTimeouts()` to
  `PendingInteractionServiceTag.takeTimedOutPermissions()`.
- Updated shared SSE test mocks for the new pending-permissions port.

TDD red checks:

```text
$ pnpm vitest run test/unit/effect/pending-interaction-service.test.ts
Exit: 1
Expected failure:
  Cannot find module '../../../src/lib/effect/pending-interaction-service.js'
```

```text
$ pnpm vitest run test/unit/handlers/effect-handlers.test.ts -t "PendingInteractionService without PermissionBridgeTag"
Exit: 1
Expected failure:
  Service not found: PermissionBridge
```

```text
$ pnpm check
Exit: 2
Expected failure:
  Session metadata and helper layers still needed the new PendingInteractionServiceTag after the state owner moved.
```

Verification:

```text
$ pnpm vitest run test/unit/effect/pending-interaction-service.test.ts \
  test/unit/relay/sse-wiring.test.ts \
  test/unit/relay/race-sse-rehydration.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/session-service-effect.test.ts \
  test/unit/mock-factories.test.ts \
  test/unit/relay/permission-rehydration-wiring.test.ts
Exit: 0
Test Files  7 passed (7)
Tests  149 passed (149)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 977 files. No fixes applied.
```

```text
$ git diff --check
Exit: 0
```

## Phase 7.3: Model Handler Service Contract

Plan issues found:

- `handleGetModels` is a bounded OpenCode read workflow, not a reason to add a broad generic OpenCode read service.
  This slice keeps the service contract to provider-list and active-session reads only.
- `handleReloadProviderSession` composes `handleGetModels`, so reload tests and relay wiring inherit the model-service
  requirement even though reload itself still uses `OpenCodeAPITag` for command refreshes.
- `src/lib/bridges/client-init.ts` still mirrors model-list and active-session model reads through `OpenCodeAPITag`.
  It is not in Phase 7's handler file list, but it is the next model-read duplication to remove before claiming the
  model-read boundary is fully Effect-owned.
- The existing `handleSwitchModel`, `handleSetDefaultModel`, and `handleSwitchVariant` provider-list reads remain outside
  this slice. They need their own behavioral snapshot or service-contract slice before conversion.

Changes:

- `src/lib/effect/services.ts`: added `OpenCodeModelServiceTag` and `OpenCodeModelServiceLive` backed by
  `OpenCodeAPITag`, with Effect methods for `provider.list()` and `session.get(...)`.
- `src/lib/handlers/model.ts`: `handleGetModels` now reads providers and active-session details through the model
  service instead of wrapping OpenCode API promises locally.
- `src/lib/relay/relay-stack.ts` and `test/helpers/mock-factories.ts`: production and shared test layers now provide
  `OpenCodeModelServiceLive` from the OpenCode API layer.
- `test/unit/handlers/model-service-effect.test.ts`: added a behavior test proving `handleGetModels` can run with the
  model service and without the Promise `OpenCodeAPITag`.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts
Exit: 1
Expected failure:
  Service not found: OpenCodeAPI
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts \
  test/unit/handlers/model-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  69 passed (69)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 966 files. No fixes applied.
```

```text
$ pnpm test:unit
Exit: 0
Test Files  357 passed (357)
Tests  5138 passed | 2 skipped | 12 todo (5152)
```

## Phase 7.4: Settings Handler Wire Snapshots

Plan issues found:

- `get_commands` has two materially different success envelopes: OpenCode command reads and Claude active-provider
  discovery. Both need snapshots before moving OpenCode app reads behind an Effect service.
- `get_projects` has two read paths: daemon config when projects are already registered, and OpenCode app fallback.
  Only the fallback path should require the OpenCode app-read service.

Changes:

- `test/unit/handlers/settings-wire-snapshots.test.ts`: added wire-envelope tests for OpenCode commands, Claude
  commands, config-backed projects, OpenCode fallback projects, and dispatch-level error envelopes.
- `test/snapshots/handlers/settings.json`: pinned the current command/project WebSocket envelopes before conversion.

Verification:

```text
$ pnpm vitest run test/unit/handlers/settings-wire-snapshots.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  6 passed (6)
```

## Phase 7.5: Settings Handler Service Contract

Plan issues found:

- `handleGetCommands` should not require OpenCode app reads for Claude-bound sessions. The settings service lookup stays
  in the OpenCode fallback branch so Claude discovery can run without `OpenCodeSettingsServiceTag`.
- `handleGetProjects` should not require OpenCode app reads when daemon config already owns the project list. The service
  lookup stays in the fallback branch only.
- `handleReloadProviderSession` composes both `handleGetModels` and `handleGetCommands`, so tests that call it need both
  model and settings service layers.

Changes:

- `src/lib/effect/services.ts`: added `OpenCodeSettingsServiceTag` and `OpenCodeSettingsServiceLive` for
  `app.commands()` and `app.projects()`.
- `src/lib/handlers/settings.ts`: moved OpenCode command and project fallback reads through `OpenCodeSettingsServiceTag`.
- `src/lib/relay/relay-stack.ts` and `test/helpers/mock-factories.ts`: production and shared test layers now provide the
  settings service from the OpenCode API layer.
- `test/unit/handlers/settings-service-effect.test.ts`: added behavior tests proving OpenCode command and project reads
  can run without the Promise `OpenCodeAPITag`.
- `test/unit/effect/services.test.ts`: registered the new service tag in the tag uniqueness tests.

TDD red checks:

```text
$ pnpm vitest run test/unit/handlers/settings-service-effect.test.ts
Exit: 1
Expected failure:
  Service not found: OpenCodeAPI
```

```text
$ pnpm vitest run test/unit/handlers/settings-service-effect.test.ts
Exit: 1
Expected failure after command path was green:
  Service not found: OpenCodeAPI
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/settings-service-effect.test.ts \
  test/unit/handlers/settings-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/handlers/get-commands-active-provider.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts \
  test/unit/effect/services.test.ts
Exit: 0
Test Files  6 passed (6)
Tests  104 passed (104)
```

```text
$ pnpm vitest run test/unit/handlers
Exit: 0
Test Files  15 passed (15)
Tests  141 passed (141)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 969 files. No fixes applied.
```

```text
$ pnpm test:unit > test-output.log 2>&1
Exit: 0
Test Files  359 passed (359)
Tests  5147 passed | 2 skipped | 12 todo (5161)
```

## Phase 7.6: Model Variant Wire Snapshots

Plan issues found:

- The remaining model-handler OpenCode reads are provider-list lookups used to populate `variant_info` in
  `switch_model`, `set_default_model`, and `switch_variant`.
- `switch_model` currently defects if `OrchestrationEngineTag` is missing because the handler wraps a required service
  lookup in `Effect.either`. The snapshot provides the engine layer to preserve current behavior while documenting this
  dependency for later cleanup.

Changes:

- `test/unit/handlers/model-wire-snapshots.test.ts`: added OpenCode-provider snapshots for `switch_model`,
  `switch_variant`, and `set_default_model`.
- `test/snapshots/handlers/models.json`: pinned the current `model_info`, `default_model_info`, and `variant_info`
  envelopes before moving the provider-list reads.

Verification:

```text
$ pnpm vitest run test/unit/handlers/model-wire-snapshots.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  6 passed (6)
```

## Phase 7.7: Model Variant Service Contract

Plan issues found:

- `switch_model`, `switch_variant`, and the variant-list half of `set_default_model` are OpenCode provider-list reads,
  not reasons for the handlers to depend on the raw OpenCode API.
- `set_default_model` still legitimately needs `OpenCodeAPITag` for `client.config.update(...)`; this slice only moves
  the read side to `OpenCodeModelServiceTag`.
- `switch_model` treated the orchestration engine as optional at runtime but still yielded `OrchestrationEngineTag`
  through a required-service lookup. `pnpm check` caught that as a static Effect requirement in tests that did not
  provide the engine. The long-term fix is to use `Effect.serviceOption(OrchestrationEngineTag)` for session binding,
  matching the existing optional discovery branches.
- Because Effect requirements are not flow-sensitive by dynamic payload values, Claude branch tests still provide a
  model service layer but assert its provider-list method is not called.

Changes:

- `src/lib/handlers/model.ts`: routed non-Claude provider-list reads in `handleSwitchModel`,
  `handleSetDefaultModel`, and `handleSwitchVariant` through `OpenCodeModelServiceTag.listProviders()`.
- `src/lib/handlers/model.ts`: kept `OpenCodeAPITag` in `handleSetDefaultModel` for the OpenCode config write and
  removed it from `handleSwitchModel` and `handleSwitchVariant`.
- `src/lib/handlers/model.ts`: changed optional session-provider binding in `handleSwitchModel` to
  `Effect.serviceOption(OrchestrationEngineTag)`.
- `test/unit/handlers/model-service-effect.test.ts`: added behavior tests proving OpenCode variant reads use the model
  service instead of the raw API.
- `test/unit/handlers/effect-handlers.test.ts`: updated non-Claude tests to provide the model service layer and Claude
  tests to assert the OpenCode provider list is not called.

TDD red checks:

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts
Exit: 1
Expected failure:
  switch_variant required OpenCodeAPI before reaching the model service path.
```

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts
Exit: 1
Expected failure:
  switch_model required OpenCodeAPI before reaching the model service path.
```

```text
$ pnpm vitest run test/unit/handlers/model-service-effect.test.ts
Exit: 1
Expected failure:
  set_default_model still called api.provider.list instead of OpenCodeModelServiceTag.listProviders().
```

Verification:

```text
$ pnpm vitest run test/unit/handlers test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  16 passed (16)
Tests  153 passed (153)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 969 files. No fixes applied.
```

```text
$ rg -n "client\\.(provider\\.list|session\\.get)\\(|provider\\.list\\(|session\\.get\\(" \
  src/lib/handlers src/lib/bridges/client-init.ts
Exit: 0
Remaining direct model/session reads:
  src/lib/bridges/client-init.ts:174: client.session.get(activeId)
  src/lib/bridges/client-init.ts:361: client.provider.list()
  src/lib/handlers/session.ts:73: client.session.get(id)
```

## Phase 7.8: Session Metadata Wire Snapshot

Plan issues found:

- `sendSessionMetadata(...)` emits several independent messages concurrently. A full call-order snapshot would be
  noisy and could fail on unrelated session-list ordering, so this checkpoint pins the `model_info` envelope that will
  be affected by moving `client.session.get(id)`.
- The session handler still needs `OpenCodeAPITag` for pending permission and question API reads. This checkpoint is
  only for the model metadata read.

Changes:

- `test/unit/handlers/session-wire-snapshots.test.ts`: added a `view_session` snapshot test for the model metadata
  envelope.
- `test/snapshots/handlers/sessions.json`: recorded the current `model_info` message produced by session metadata.

Verification:

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  1 passed (1)
```

## Phase 7.9: Session Metadata Service Contract

Plan issues found:

- `sendSessionMetadata(...)` still needs `OpenCodeAPITag` for pending permission and question API replay, so this
  slice must not remove the raw API from the whole helper.
- The model metadata lookup is the only session-handler read that belongs to `OpenCodeModelServiceTag`; fork,
  message, and pagination APIs remain separate future service boundaries.
- Fork-session tests exercise metadata replay after switching to the forked session, so their custom helper must provide
  the model service too.

Changes:

- `src/lib/handlers/session.ts`: moved the metadata `client.session.get(id)` read to
  `OpenCodeModelServiceTag.getSession(id)`.
- `test/unit/handlers/session-service-effect.test.ts`: added behavior tests proving session model metadata comes from
  the model service, model lookup failures remain non-fatal, and sessions without `modelID` still skip `model_info`.
- `test/unit/handlers/effect-handlers.test.ts`: updated fork-session test wiring to provide `OpenCodeModelServiceLive`
  from the same mock OpenCode API.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts
Exit: 1
Expected failure:
  modelService.getSession was never called because sendSessionMetadata still used api.session.get.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/session-service-effect.test.ts \
  test/unit/handlers/session-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  69 passed (69)
```

```text
$ pnpm vitest run test/unit/handlers
Exit: 0
Test Files  17 passed (17)
Tests  151 passed (151)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 972 files. No fixes applied.
```

```text
$ rg -n "client\\.(provider\\.list|session\\.get)\\(|provider\\.list\\(|session\\.get\\(" \
  src/lib/handlers src/lib/bridges/client-init.ts
Exit: 0
Remaining direct model/session reads:
  src/lib/bridges/client-init.ts:174: client.session.get(activeId)
  src/lib/bridges/client-init.ts:361: client.provider.list()
```

## Phase 7.10: List Sessions Wire Snapshot

Plan issues found:

- Converting the full session manager tag at once would touch session switching, metadata replay, fork metadata,
  history pagination, deletion, search, rename, and prompt-path side effects in one slice. The smallest safe first
  session-manager boundary is `handleListSessions`, which only forwards `sendDualSessionLists(...)` output to the
  connecting client.
- A list snapshot should include both root and non-root envelopes because the frontend distinguishes the two lists by
  the `roots` flag.

Changes:

- `test/unit/handlers/session-wire-snapshots.test.ts`: added a `list_sessions` wire snapshot.
- `test/snapshots/handlers/sessions.json`: recorded the two current `session_list` envelopes.

Verification:

```text
$ pnpm vitest run test/unit/handlers/session-wire-snapshots.test.ts
Exit: 0
Test Files  1 passed (1)
Tests  2 passed (2)
```

## Phase 7.1: File Handler Effect Service Contract

Plan issues found:

- The first handler conversion should be a narrow service, not a renamed `OpenCodeAPITag`. A broad
  `OpenCodeReadServiceTag` would hide the old OpenCode API shape behind a new name and make tests mostly prove mock
  wiring.
- File handlers are the smallest read-only handler surface already protected by the new wire snapshots, so they are the
  right first service-contract conversion.
- Preserving the current `Effect.tryPromise` error surface matters because the new snapshot records the existing
  `system_error` message for rejected file reads. The file service uses typed `Cause.UnknownException` failures to keep
  that wire shape stable while moving the Promise bridge out of the handlers.

Changes:

- `src/lib/effect/services.ts`: added `OpenCodeFileServiceTag`, `OpenCodeFileService`, and
  `OpenCodeFileServiceLive` backed by the existing `OpenCodeAPITag` at the runtime boundary.
- `src/lib/handlers/files.ts`: replaced direct `OpenCodeAPITag` / `Effect.tryPromise(() => client.file.*)` usage with
  `OpenCodeFileServiceTag` effects for `.gitignore`, file list, file content, and tree traversal reads.
- `src/lib/relay/relay-stack.ts`: provides `OpenCodeFileServiceLive` in the production relay runtime from the existing
  OpenCode API layer.
- `test/helpers/mock-factories.ts`: provides the file service in shared handler test layers so tests can continue to
  pass an OpenCode API mock at the boundary.
- `test/unit/handlers/file-service-effect.test.ts`: proves file handlers can run from an Effect-native file service
  layer without `OpenCodeAPITag` in their context.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/file-service-effect.test.ts
Exit: 1
Expected failure:
  Service not found: OpenCodeAPI
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/file-service-effect.test.ts \
  test/unit/handlers/file-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  4 passed (4)
Tests  70 passed (70)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 963 files. No fixes applied.
```

## Phase 7.2: Model Handler Wire Snapshots

Plan issues found:

- `handleGetModels` mixes OpenCode provider reads, active-session model reads, optional Claude discovery, and variant
  projection. Converting it without a wire snapshot would make subtle frontend-observed envelope changes hard to spot.
- Provider/model reads should be split from settings/app discovery reads. A broad OpenCode read service would duplicate
  the old `OpenCodeAPITag` shape and dilute the service boundary.

Changes:

- `test/unit/handlers/model-wire-snapshots.test.ts`: added focused `get_models` wire snapshots for the OpenCode-only
  model list, active-session `model_info` path, and provider-list failure through `handleRelayWsMessage(...)`.
- `test/snapshots/handlers/models.json`: committed the current model handler wire contract before extracting a
  provider/model read service.

TDD red check:

```text
$ pnpm vitest run test/unit/handlers/model-wire-snapshots.test.ts
Exit: 1
Expected failure:
  test/snapshots/handlers/models.json did not exist yet.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/model-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  68 passed (68)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 965 files. No fixes applied.
```

## Phase 7.0: File Handler Wire Snapshots

Plan issues found:

- Phase 7 says to snapshot handler envelopes before converting handlers. Existing handler tests asserted mock calls, but
  there was no committed `test/snapshots/handlers/<handler>.json` baseline.
- Error envelopes need to be captured through `handleRelayWsMessage(...)`, not just direct handler functions, because
  the top-level wrapper renders `system_error` messages.
- The file snapshot captures two current wire quirks without changing behavior: the fixture shape currently emits
  `node_modules/` in `file_tree`, and rejected file reads currently render as
  `"An unknown error occurred in Effect.tryPromise"`. Any improvement to those envelopes should be a separate,
  intentional frontend-coordinated behavior change.

Changes:

- `test/helpers/mock-factories.ts`: added `makeRecordingWebSocketHandler(...)` and `RecordedWebSocketCall` so handler
  tests can compare normalized outbound WebSocket envelopes.
- `test/unit/handlers/file-wire-snapshots.test.ts`: added success snapshots for `get_file_list`, `get_file_content`,
  and `get_file_tree`, plus the top-level `get_file_content` error envelope through `handleRelayWsMessage(...)`.
- `test/snapshots/handlers/files.json`: committed the current file-handler wire contract before any service conversion.

TDD red checks:

```text
$ pnpm vitest run test/unit/handlers/file-wire-snapshots.test.ts
Exit: 1
Expected failure:
  makeRecordingWebSocketHandler was not implemented yet.
```

```text
$ pnpm vitest run test/unit/handlers/file-wire-snapshots.test.ts
Exit: 1
Expected failure:
  test/snapshots/handlers/files.json did not exist yet.
```

Verification:

```text
$ pnpm vitest run test/unit/handlers/file-wire-snapshots.test.ts \
  test/unit/handlers/effect-handlers.test.ts \
  test/unit/relay/ws-message-dispatch-effect.test.ts
Exit: 0
Test Files  3 passed (3)
Tests  69 passed (69)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 962 files. No fixes applied.
```

## Phase 6.9: Claude SDK AsyncIterable Boundary Decision

Plan issues found:

- The plan recommends `Stream.fromAsyncIterable(...)` as the canonical Claude SDK AsyncIterable adapter. That remains
  correct for the target architecture, but the current Claude stream consumer is still owned by an imperative
  `Promise<void>` stored on the session context.
- Rewriting only the `for await` loop now would likely add an adapter-local `Effect.runPromise(Stream.runForEach(...))`
  bridge, moving the Promise runner deeper instead of making lifecycle ownership more Effect-native.

Decision:

- Reclassify the current `for await (const message of ctx.query)` loop as an intentional Claude SDK external boundary
  for this phase.
- Defer `Stream.fromAsyncIterable(...)` until the Claude adapter internals move together: Effect-owned session state,
  pending-turn `Deferred`/queue ownership, and scoped stream fibers. That later slice should preserve existing stream
  failure, natural-end, stale-resume, and interruption tests.

## Phase 6.8: Provider Registry Effect Service Layer

Plan issues found:

- The registry already had typed `getAdapterEffect` lookup, but it was still only constructor-injected imperative state.
  That satisfied orchestration call sites but did not satisfy the plan's Layer-backed service requirement.
- A tag/live-layer export alone would be token compliance if production wiring did not provide it. The relay runtime now
  includes the same registry instance in its Effect Layer tree, so later provider/handler consumers can resolve it from
  context instead of receiving another constructor parameter.

Changes:

- `src/lib/provider/provider-registry.ts`: added `ProviderRegistryTag`, `ProviderRegistryLive(...)`, and constructor
  seeding for registered adapters.
- `src/lib/provider/orchestration-wiring.ts`: exposes the concrete provider registry as `registryLayer` alongside the
  existing engine/adapter wiring.
- `src/lib/relay/relay-stack.ts`: provides the registry layer in the relay `ManagedRuntime` bridge layer tree.
- `test/unit/provider/provider-registry.test.ts`: added Layer-backed lookup tests, typed missing-adapter failure, and
  fresh Layer acquisition behavior.
- `test/unit/provider/orchestration-wiring.test.ts`: verifies production orchestration wiring exposes the registry
  through `ProviderRegistryTag`.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/provider-registry.test.ts
Exit: 1
Expected failure:
  ProviderRegistryLive was not exported yet, so the Layer-backed service tests failed before implementation.
```

```text
$ pnpm vitest run test/unit/provider/orchestration-wiring.test.ts
Exit: 1
Expected failure:
  createOrchestrationLayer did not expose registryLayer, so resolving ProviderRegistryTag from production wiring failed.
```

Verification:

```text
$ pnpm vitest run test/unit/provider/provider-registry.test.ts test/unit/provider/orchestration-wiring.test.ts
Exit: 0
Test Files  2 passed (2)
Tests  27 passed (27)
```

```text
$ pnpm check
Exit: 0
```

## Phase 6.5: Provider Send-Turn Effect Boundary

Plan issues found:

- `sendTurn` is the highest-risk provider boundary because it owns long-lived streaming, pending turn deferreds,
  EventSink writes, AbortController bridging, Claude same-session locking, and orchestration's session binding rule.
  It needed its own slice instead of being bundled with discovery, interrupt, or end-session migration.
- Structured provider failures must stay `TurnResult.status === "error"` when the provider reports an expected turn
  error. Only thrown/rejected adapter defects become `ProviderAdapterFailure` in the Effect error channel.
- Claude's SDK output stream can end after a completed turn while the context remains in the session map. A same-agent
  follow-up must not enqueue into that dead stream, but an agent-change follow-up still needs the old context so it can
  restart with the prior conversation transcript. The implementation uses an explicit ended-stream marker rather than
  incorrectly marking naturally-ended streams as stopped sessions.
- The Phase 6 plan omits `resolvePermission`, `resolveQuestion`, and `shutdown` from the Effect-returning adapter
  contract list. Those are still Promise-shaped after this slice and need follow-up slices; shutdown needs an explicit
  decision about whether finalizer failures are surfaced or typed-and-logged.

Changes:

- `src/lib/provider/types.ts`: replaced `ProviderAdapter.sendTurn(...)` with
  `sendTurnEffect(input): Effect.Effect<TurnResult, ProviderAdapterFailure>`.
- `src/lib/provider/opencode-adapter.ts`: OpenCode turn sending now exposes an Effect method while preserving the SSE
  deferred completion path and expected `send_failed` `TurnResult` behavior.
- `src/lib/provider/claude/claude-adapter.ts`: Claude turn sending now exposes an Effect method, keeps same-session
  locking on the local Promise implementation, and tracks naturally-ended SDK streams separately from stopped sessions.
- `src/lib/provider/orchestration-engine.ts`: `dispatchEffect({ type: "send_turn" })` now calls
  `adapter.sendTurnEffect(...)` directly and preserves the rule that successful Effects bind the session, including
  structured error `TurnResult`s, while failed Effects do not bind.
- Provider unit, integration, and expensive-real E2E test call sites were updated to use `Effect.runPromise(...)` or
  `Effect.either(...)` at the test boundary.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts
Exit: 1
Expected failure:
  OrchestrationEngine still called the legacy Promise sendTurn path:
  Provider adapter sendTurn failed for provider opencode: legacy Promise sendTurn should not be called
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/orchestration-engine.test.ts \
  test/unit/provider/opencode-adapter-send-turn.test.ts \
  test/unit/provider/opencode-adapter-actions.test.ts \
  test/unit/provider/claude/claude-adapter-send-turn.test.ts \
  test/unit/provider/claude/claude-adapter-lifecycle.test.ts \
  test/unit/provider/types.test.ts \
  test/unit/provider/provider-registry.test.ts \
  test/unit/provider/claude/provider-wiring.test.ts
Exit: 0
Test Files  9 passed (9)
Tests  139 passed (139)
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  372 passed (372)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```

```text
$ pnpm exec vitest run --config vitest.integration.config.ts \
  test/integration/flows/claude-adapter.integration.ts
Exit: 0
Test Files  1 passed (1)
Tests  2 passed (2)
```

```text
$ pnpm test:unit
Exit: 0
Test Files  353 passed (353)
Tests  5122 passed | 2 skipped | 12 todo (5136)
```

```text
$ rg -n "try: \\(\\) => adapter\\.|adapter\\.(interruptTurn|discover|endSession|sendTurn)\\(" \
  src/lib/provider/orchestration-engine.ts src/lib/provider/types.ts \
  src/lib/provider/opencode-adapter.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider
Exit: 1
No remaining discovery/send-turn/interrupt/end-session Promise bridges in provider orchestration.
```

## Phase 6.6: Provider Permission And Question Resolution Effect Boundaries

Plan issues found:

- Permission and question resolution were omitted from the Phase 6 high-risk contract list even though they are adapter
  methods called from orchestration. Leaving them Promise-shaped would keep bridge code in the exact provider command
  path this phase is supposed to remove.
- These boundaries are narrower than `sendTurnEffect`: they only route user answers back to pending provider requests.
  They are safe to migrate together because neither owns session binding, streaming, or provider state persistence.
- `shutdown()` is now the remaining Promise-shaped provider lifecycle method. It should not be silently renamed without
  deciding whether shutdown failures become surfaced typed errors or finalizer-style logged errors.

Changes:

- `src/lib/provider/types.ts`: replaced `resolvePermission(...)` and `resolveQuestion(...)` with
  `resolvePermissionEffect(...)` and `resolveQuestionEffect(...)`.
- `src/lib/provider/opencode-adapter.ts`: OpenCode permission and question replies now expose Effect methods and map
  rejected SDK calls to `ProviderAdapterFailure`.
- `src/lib/provider/claude/claude-adapter.ts`: Claude permission and question resolution now expose Effect methods
  while preserving no-op behavior for unknown sessions or requests.
- `src/lib/provider/orchestration-engine.ts`: permission and question commands now call adapter Effect methods directly
  and use `tapError` only for contextual logging.
- Provider orchestration, OpenCode action, Claude lifecycle, registry, wiring, and type tests were updated to the new
  contract.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts
Exit: 1
Expected failures:
  Provider adapter resolvePermission failed for provider claude: legacy Promise resolvePermission should not be called
  Provider adapter resolveQuestion failed for provider claude: legacy Promise resolveQuestion should not be called
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/orchestration-engine.test.ts \
  test/unit/provider/opencode-adapter-actions.test.ts \
  test/unit/provider/claude/claude-adapter-lifecycle.test.ts \
  test/unit/provider/types.test.ts \
  test/unit/provider/provider-registry.test.ts \
  test/unit/provider/claude/provider-wiring.test.ts
Exit: 0
Test Files  7 passed (7)
Tests  100 passed (100)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  374 passed (374)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```

```text
$ rg -n "try: \\(\\) => adapter\\.|adapter\\.(interruptTurn|discover|endSession|sendTurn|resolvePermission|resolveQuestion)\\(" \
  src/lib/provider/orchestration-engine.ts src/lib/provider/types.ts \
  src/lib/provider/opencode-adapter.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider
Exit: 1
No remaining discovery/send-turn/interrupt/end-session/permission/question Promise bridges in provider orchestration.
```

## Phase 6.7: Provider Shutdown Effect Boundary

Plan issues found:

- `shutdown()` was the last Promise-shaped method on `ProviderAdapter`. Leaving it as-is would make the adapter
  contract mostly Effect-returning while lifecycle cleanup still used a Promise bridge.
- Shutdown has different semantics from command dispatch: current behavior is best-effort cleanup where individual
  adapter failures are logged and swallowed. This slice preserves that finalizer-style behavior instead of surfacing one
  adapter's cleanup failure and skipping the rest.
- `OrchestrationEngine.shutdown()` and `ProviderRegistry.shutdownAll()` remain Promise wrappers for existing imperative
  relay cleanup call sites, but both now delegate to `shutdownEffect()` / `shutdownAllEffect()` internally. The adapter
  contract itself has no Promise methods left.

Changes:

- `src/lib/provider/types.ts`: replaced `shutdown(): Promise<void>` with
  `shutdownEffect(): Effect.Effect<void, ProviderAdapterFailure>`.
- `src/lib/provider/opencode-adapter.ts`: OpenCode shutdown now exposes an Effect method and preserves pending-turn
  rejection/clear behavior.
- `src/lib/provider/claude/claude-adapter.ts`: Claude shutdown now exposes an Effect method, maps unexpected cleanup
  rejection to `ProviderAdapterFailure`, and preserves session disposal behavior.
- `src/lib/provider/provider-registry.ts`: added `shutdownAllEffect()` using bounded Effect concurrency and per-adapter
  typed-error logging; the existing Promise wrapper delegates to it for current imperative callers.
- `src/lib/provider/orchestration-engine.ts`: added `shutdownEffect()` and delegates the existing Promise wrapper to it.
- Provider shutdown, wiring, adapter lifecycle, and type tests were updated to the Effect boundary.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/provider-registry.test.ts
Exit: 1
Expected failure:
  ProviderRegistry.shutdownAll still called the legacy Promise shutdown path:
  legacy Promise shutdown should not be called
```

Verification:

```text
$ pnpm vitest run test/unit/provider/provider-registry.test.ts \
  test/unit/provider/orchestration-engine.test.ts \
  test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/opencode-adapter-actions.test.ts \
  test/unit/provider/claude/claude-adapter-lifecycle.test.ts \
  test/unit/provider/claude/claude-adapter-send-turn.test.ts \
  test/unit/provider/types.test.ts \
  test/unit/provider/claude/provider-wiring.test.ts \
  test/unit/provider/orchestration-wiring.test.ts
Exit: 0
Test Files  9 passed (9)
Tests  145 passed (145)
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  375 passed (375)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ rg -n "try: \\(\\) => adapter\\.|adapter\\.(interruptTurn|discover|endSession|sendTurn|resolvePermission|resolveQuestion|shutdown)\\(" \
  src/lib/provider/orchestration-engine.ts src/lib/provider/provider-registry.ts \
  src/lib/provider/types.ts src/lib/provider/opencode-adapter.ts \
  src/lib/provider/claude/claude-adapter.ts test/unit/provider
Exit: 1
No remaining Promise adapter method bridges for provider discovery, send turn, interrupt, replies, end-session, or shutdown.
```

## Phase 6.3: Provider Interrupt Effect Boundary

Plan issues found:

- `interruptTurn` is the next safe adapter boundary after discovery because it has a narrow session-control surface and
  does not require changing send-turn streaming, EventSink persistence, or Claude prompt queue ownership.
- Keeping both `interruptTurn()` and `interruptTurnEffect()` on the adapter contract would preserve the same bridge
  under a new name. This slice removes the Promise method from `ProviderAdapter` and updates local adapter tests to call
  the Effect method.
- OpenCode interruption failures should be asserted through the Effect error channel, not Promise rejection text.

Changes:

- `src/lib/provider/types.ts`: replaced `ProviderAdapter.interruptTurn()` with
  `interruptTurnEffect(sessionId): Effect.Effect<void, ProviderAdapterFailure>`.
- `src/lib/provider/opencode-adapter.ts`: OpenCode abort calls now normalize rejected SDK calls to typed
  `ProviderAdapterFailure`.
- `src/lib/provider/claude/claude-adapter.ts`: Claude interruption now exposes an Effect method while preserving the
  existing cleanup behavior for prompt queue close, SDK interrupt, pending approvals/questions, and in-flight tools.
- `src/lib/provider/orchestration-engine.ts`: `dispatchEffect({ type: "interrupt_turn" })` now calls
  `adapter.interruptTurnEffect(...)` directly.
- Provider orchestration, OpenCode action, Claude lifecycle, and type tests were updated to use the Effect interruption
  boundary.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts
Exit: 1
Expected failure:
  OrchestrationEngine still called the legacy Promise interrupt path:
  Provider adapter interruptTurn failed for provider claude: legacy Promise interrupt should not be called
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/orchestration-engine.test.ts \
  test/unit/provider/opencode-adapter-actions.test.ts \
  test/unit/provider/claude/claude-adapter-lifecycle.test.ts \
  test/unit/provider/claude/claude-adapter-send-turn.test.ts \
  test/unit/provider/types.test.ts \
  test/unit/provider/provider-registry.test.ts \
  test/unit/provider/claude/provider-wiring.test.ts
Exit: 0
Test Files  8 passed (8)
Tests  130 passed (130)
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  370 passed (370)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```

```text
$ rg -n "try: \\(\\) => adapter\\.|adapter\\.(interruptTurn|discover)\\(" \
  src/lib/provider/orchestration-engine.ts src/lib/provider/types.ts \
  src/lib/provider/opencode-adapter.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider
Exit: 0
Remaining provider orchestration Promise wrappers:
  src/lib/provider/orchestration-engine.ts:235: try: () => adapter.sendTurn(command.input)
  src/lib/provider/orchestration-engine.ts:376: try: () => adapter.endSession(command.sessionId)
```

## Phase 6.4: Provider End-Session Effect Boundary

Plan issues found:

- `endSession` is a local session-reset boundary, not a turn cancellation path. It is safe to migrate after
  `interruptTurnEffect` and before `sendTurnEffect` because it does not change streaming or EventSink writes.
- Keeping `endSession()` beside `endSessionEffect()` would retain another adapter Promise bridge. This slice removes
  the Promise method from `ProviderAdapter` and updates local adapter tests to use the Effect method.

Changes:

- `src/lib/provider/types.ts`: replaced `ProviderAdapter.endSession()` with
  `endSessionEffect(sessionId): Effect.Effect<void, ProviderAdapterFailure>`.
- `src/lib/provider/opencode-adapter.ts`: OpenCode reload/reset now exposes an Effect method and keeps the existing
  local deferred rejection behavior without calling `client.session.abort(...)`.
- `src/lib/provider/claude/claude-adapter.ts`: Claude reload/reset now exposes an Effect method and preserves terminal
  session disposal: cleanup, queued turn rejection, SDK query close, and session map removal.
- `src/lib/provider/orchestration-engine.ts`: `dispatchEffect({ type: "end_session" })` now calls
  `adapter.endSessionEffect(...)` directly and preserves `unbind` behavior.
- Provider orchestration, OpenCode end-session, Claude lifecycle, and type tests were updated to use the Effect
  end-session boundary.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts
Exit: 1
Expected failure:
  OrchestrationEngine still called the legacy Promise endSession path:
  Provider adapter endSession failed for provider claude: legacy Promise endSession should not be called
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/orchestration-engine.test.ts \
  test/unit/provider/opencode-adapter-end-session.test.ts \
  test/unit/provider/claude/claude-adapter-lifecycle.test.ts \
  test/unit/provider/types.test.ts \
  test/unit/provider/provider-registry.test.ts \
  test/unit/provider/claude/provider-wiring.test.ts
Exit: 0
Test Files  7 passed (7)
Tests  89 passed (89)
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  371 passed (371)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```

```text
$ rg -n "try: \\(\\) => adapter\\.|adapter\\.(interruptTurn|discover|endSession)\\(" \
  src/lib/provider/orchestration-engine.ts src/lib/provider/types.ts \
  src/lib/provider/opencode-adapter.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider
Exit: 0
Remaining provider orchestration Promise wrapper:
  src/lib/provider/orchestration-engine.ts:235: try: () => adapter.sendTurn(command.input)
```

## Phase 6.2: Provider Discovery Effect Boundary

Plan issues found:

- Starting Phase 6 by converting every adapter method would still mix discovery, send-turn streaming, interruption,
  permission resolution, and Claude prompt queue lifecycle in one slice. Discovery is the smallest real adapter
  boundary because it has no event sink, session binding, prompt queue, or cancellation ownership.
- A Promise rejection assertion would not prove Effect migration. The OpenCode discovery failure test now reads the
  Effect error channel directly and asserts `ProviderAdapterFailure`.
- Claude discovery intentionally falls back to built-in models when the capability probe fails, so this slice does not
  force probe failures into typed adapter failures.

Changes:

- `src/lib/provider/types.ts`: replaced `ProviderAdapter.discover()` with
  `discoverEffect(): Effect.Effect<AdapterCapabilities, ProviderAdapterFailure>`.
- `src/lib/provider/opencode-adapter.ts`: discovery now exposes an Effect method and normalizes rejected OpenCode SDK
  calls to `ProviderAdapterFailure` at the adapter edge.
- `src/lib/provider/claude/claude-adapter.ts`: discovery now exposes an Effect method while preserving Claude's
  capability-probe fallback behavior.
- `src/lib/provider/orchestration-engine.ts`: `dispatchEffect({ type: "discover" })` calls the adapter Effect method
  directly instead of wrapping an adapter Promise internally.
- Provider discovery/type/orchestration tests were updated to use `discoverEffect()`, with a behavior test proving the
  legacy Promise discovery path is not called.

TDD red check:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts
Exit: 1
Expected failure:
  OrchestrationEngine still called the legacy Promise discover path:
  Provider adapter discover failed for provider claude: legacy Promise discover should not be called
```

Verification:

```text
$ pnpm vitest run test/unit/provider/orchestration-engine-effect.test.ts \
  test/unit/provider/orchestration-engine.test.ts \
  test/unit/provider/provider-registry.test.ts \
  test/unit/provider/types.test.ts \
  test/unit/provider/opencode-adapter-discover.test.ts \
  test/unit/provider/claude/claude-adapter-discover.test.ts \
  test/unit/provider/claude/provider-wiring.test.ts
Exit: 0
Test Files  7 passed (7)
Tests  83 passed (83)
```

```text
$ pnpm vitest run test/unit/provider
Exit: 0
Test Files  32 passed (32)
Tests  369 passed (369)
Note: run emitted an existing opencode-adapter HTTP 500 log from a negative-path test and existing SQLite warnings.
```

```text
$ pnpm check
Exit: 0
```

```text
$ pnpm lint
Exit: 0
Checked 960 files. No fixes applied.
```
