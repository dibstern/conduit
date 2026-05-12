# Effect.ts Mainline Completion Progress

Phase 0 baseline captured from `/Users/dstern/.config/codex/worktrees/bb7e/conduit` on branch
`ds/effect-mainline-completion`.

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `startDaemonProcess` imported by CLI.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition.
- [ ] `PersistenceLayer.open(...)` in daemon or relay production paths.
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
