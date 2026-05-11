# Effect.ts Mainline Completion Progress

Phase 0 baseline captured from `/Users/dstern/.config/codex/worktrees/bb7e/conduit` on branch
`ds/effect-mainline-completion`.

## Guardrail Checklist

Every item below must be removed or explicitly reclassified before the migration can be called complete.

- [ ] `startDaemonProcess` imported by CLI.
- [ ] `Layer.succeed(..., alreadyConstructedInstance)` inside relay composition.
- [ ] `PersistenceLayer.open(...)` in daemon or relay production paths.
- [ ] `Effect.promise(` on rejectable operations.
- [ ] `concurrency: "unbounded"` on dynamic collections.
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

Live behavior smoke was not run in this baseline pass. Reason: the narrow baseline is already not green, and
the failures show the expected local OpenCode endpoint at `localhost:4096` is not reachable from this session.
Running provider-backed live smoke now would mix environmental diagnosis into the migration baseline.

Daemon CLI invocation used: Not run.

- [ ] Cold daemon start, IPC `ping` round-trip, clean shutdown with no orphan processes.
  - Baseline observation: Not run; blocked by the failed narrow baseline and unavailable `localhost:4096` provider endpoint.
- [ ] Single-project chat round-trip with one provider, OpenCode or Claude.
  - Baseline observation: Not run; provider-backed smoke cannot be trusted while `localhost:4096` refuses connections.
- [ ] Daemon restart preserves an in-flight session; event store rehydrates correctly.
  - Baseline observation: Not run; live daemon/session smoke deferred until the baseline environment is green.
- [ ] Project relay disconnect and reconnect from a browser client.
  - Baseline observation: Not run; live browser/daemon smoke deferred until the baseline environment is green.
- [ ] Multi-instance: two projects active concurrently, no cross-talk.
  - Baseline observation: Not run; live multi-instance smoke deferred until the baseline environment is green.

Before each later phase opens a PR, rerun this checklist and record the exact daemon CLI invocation, provider,
project paths, and pass/fail observations.
