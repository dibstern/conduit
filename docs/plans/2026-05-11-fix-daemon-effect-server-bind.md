# Fix Daemon Effect Server Bind — Single Source of Truth Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Restore HTTPS server binding to `0.0.0.0` so the daemon is Tailscale-reachable after the Phase 8 Effect migration.

**Architecture:** Finish the config-flow migration so `DaemonConfigRefTag` and `TlsCertTag` are the canonical runtime sources for bind config and TLS material. `DaemonLifecycleContext` becomes a server-handle sink only. HTTP and onboarding lifecycle functions receive explicit config objects, while status, setup-info, persistence, and restart paths read from a live config snapshot backed by `DaemonConfigRef`.

**Tech Stack:** TypeScript, Effect-TS 3.x (`Context.Tag`, `Layer`, `Ref`, `Layer.provideMerge`), Node `http`/`https`/`net`, Vitest + `@effect/vitest`, Biome.

**Audit Amendments Incorporated:** This version resolves the R2 audit findings:
- Add explicit `port` and `host` to `DaemonLiveOptions` before removing `ctx.port` / `ctx.host`.
- Keep a server-local `actualPort` in TLS protocol-detection redirects so `--port 0` never redirects to `:0`.
- Use named config layers in tests so assertion Effects can read `DaemonConfigRefTag`.
- Add a real `TlsCertLive -> makeHttpServerLive` handoff test with mocked `EnsureCertsTag`.
- Pass CA material from `TlsCertTag` into onboarding so `/ca/download` keeps working.
- Read the bound main-server address from `ctx.httpServer`, not `ctx.upgradeServer`.
- Update existing direct onboarding tests.
- Keep `SetupInfoProvider` dependency-free; it must not require `DaemonConfigRefTag` before the daemon runtime exists.
- Include `buildConfig()`, the returned `daemon.port` getter, and restart/keep-awake write paths in the config migration.
- Use real manual verification commands, dynamic Tailscale IP detection, and `/api/status` or `/health`.

**Anti-bandaid Rules:**
- Do not reintroduce `ctx.host`, `ctx.port`, or `ctx.tls`.
- Do not sync `ctx.host = config.host` or `ctx.tls = ...`; that preserves the dual source of truth.
- Do not make `routerLayer` directly require `DaemonConfigRefTag` unless the same Ref is created before router construction and shared with `makeDaemonLive`.
- Do not commit a red intermediate state. Tasks 2-5 are one connected migration slice and are committed together after `pnpm check` is green.

---

## Pre-flight: Set Up Worktree

```bash
git fetch origin
```

Use `superpowers:using-git-worktrees` to create a worktree at `.worktrees/fix-daemon-effect-server-bind` from `origin/main`.

Branch name: `ds/fix-daemon-effect-server-bind`.

```bash
cd .worktrees/fix-daemon-effect-server-bind
git rev-parse --abbrev-ref HEAD   # expected: ds/fix-daemon-effect-server-bind
pnpm install
pnpm check && pnpm lint
pnpm test:unit
```

If the baseline fails, stop and report the exact failure before editing.

---

## Task 1: Seed `DaemonConfigRef` From Explicit Daemon Options

**Goal:** `DaemonConfigRef` receives the caller's initial `port`, `host`, `tlsEnabled`, and explicit `hostExplicit` state without reading those values from `DaemonLifecycleContext`.

**Files:**
- Modify: `src/lib/effect/daemon-config-ref.ts`
- Modify: `src/lib/effect/daemon-layers.ts`
- Modify: `src/lib/effect/daemon-main.ts`
- Test: `test/unit/effect/daemon-config-ref.test.ts`
- Test: `test/unit/effect/layer-wiring.test.ts`

### Step 1.1: Add failing `makeDaemonConfigFromOptions` coverage

Append to `test/unit/effect/daemon-config-ref.test.ts`:

```typescript
it("makeDaemonConfigFromOptions carries tlsEnabled and explicit hostExplicit", () => {
  const c1 = makeDaemonConfigFromOptions({ tlsEnabled: true });
  expect(c1.tlsEnabled).toBe(true);
  expect(c1.hostExplicit).toBe(false);

  const c2 = makeDaemonConfigFromOptions({
    tlsEnabled: false,
    hostExplicit: true,
    host: "127.0.0.1",
  });
  expect(c2.tlsEnabled).toBe(false);
  expect(c2.hostExplicit).toBe(true);

  const c3 = makeDaemonConfigFromOptions({ host: "0.0.0.0" });
  expect(c3.hostExplicit).toBe(false);
});
```

Run:

```bash
pnpm vitest run test/unit/effect/daemon-config-ref.test.ts -t "tlsEnabled and explicit hostExplicit"
```

Expected: FAIL on `c3.hostExplicit`, because current code infers from `options.host !== undefined`.

### Step 1.2: Make `hostExplicit` an explicit input

Update `makeDaemonConfigFromOptions`:

```typescript
export const makeDaemonConfigFromOptions = (options: {
  port?: number;
  host?: string;
  hostExplicit?: boolean;
  pinHash?: string;
  tlsEnabled?: boolean;
  keepAwake?: boolean;
  keepAwakeCommand?: string;
  keepAwakeArgs?: string[];
  dismissedPaths?: string[];
  startTime?: number;
  persistedSessionCounts?: ReadonlyMap<string, number>;
}): DaemonRuntimeConfig => ({
  port: options.port ?? 2633,
  host: options.host ?? "127.0.0.1",
  pinHash: options.pinHash ?? null,
  tlsEnabled: options.tlsEnabled ?? false,
  keepAwake: options.keepAwake ?? false,
  keepAwakeCommand: options.keepAwakeCommand,
  keepAwakeArgs: options.keepAwakeArgs,
  shuttingDown: false,
  dismissedPaths: new Set(options.dismissedPaths ?? []),
  startTime: options.startTime ?? Date.now(),
  hostExplicit: options.hostExplicit ?? false,
  persistedSessionCounts: new Map(options.persistedSessionCounts ?? []),
});
```

Update the existing test that expected host inference by passing `hostExplicit: true` explicitly.

### Step 1.3: Extend `DaemonLiveOptions`

Add these fields to `DaemonLiveOptions` in `src/lib/effect/daemon-layers.ts`:

```typescript
/** Initial bind port. DaemonLifecycleContext no longer carries config. */
port: number;

/** Initial bind host before TlsCertLive may override it to 0.0.0.0. */
host: string;

/** Whether TLS is requested. Drives TlsCertLive cert loading and HTTPS server creation. */
tlsEnabled?: boolean;

/** True only when the caller explicitly set host. */
hostExplicit?: boolean;
```

Seed the Ref from these fields, not `options.ctx`:

```typescript
DaemonConfigRefLive(
  makeDaemonConfigFromOptions({
    port: options.port,
    host: options.host,
    hostExplicit: options.hostExplicit ?? false,
    tlsEnabled: options.tlsEnabled ?? false,
    ...(options.pinHash != null && { pinHash: options.pinHash }),
  }),
),
```

### Step 1.4: Pass values from `daemon-main.ts`

Extend the `daemonLiveOptions` literal:

```typescript
const daemonLiveOptions: DaemonLiveOptions = {
  // existing fields...
  port,
  host,
  tlsEnabled,
  hostExplicit: options.host !== undefined,
  // existing fields...
};
```

### Step 1.5: Add a composed-layer wiring test without TLS side effects

Append to `test/unit/effect/layer-wiring.test.ts`, which already owns the `makeDaemonLive` fixture:

```typescript
it.scoped("makeDaemonLive seeds DaemonConfigRef from explicit options", () => {
  const options = {
    ...makeMockOptions(),
    port: 0,
    host: "127.0.0.1",
    tlsEnabled: false,
    hostExplicit: false,
  } satisfies DaemonLiveOptions;

  return Effect.gen(function* () {
    const ref = yield* DaemonConfigRefTag;
    const config = yield* Ref.get(ref);
    expect(config.port).toBe(0);
    expect(config.host).toBe("127.0.0.1");
    expect(config.tlsEnabled).toBe(false);
    expect(config.hostExplicit).toBe(false);
  }).pipe(Effect.provide(Layer.fresh(makeDaemonLive(options))));
});
```

Do not set `tlsEnabled: true` in this full wiring test. The full layer runs production `EnsureCertsLive`, which can mutate `tlsEnabled` based on local mkcert/cert state. The true TLS path is tested in Task 3 with a mocked `EnsureCertsTag`.

Run:

```bash
pnpm vitest run test/unit/effect/daemon-config-ref.test.ts test/unit/effect/layer-wiring.test.ts test/unit/effect/tls-cert-layer.test.ts
```

Expected: PASS.

### Step 1.6: Commit

```bash
git add src/lib/effect/daemon-config-ref.ts src/lib/effect/daemon-layers.ts src/lib/effect/daemon-main.ts test/unit/effect/daemon-config-ref.test.ts test/unit/effect/layer-wiring.test.ts
git commit -m "fix(effect): seed DaemonConfigRef from explicit daemon options"
```

---

## Task 2: Refactor `startHttpServer` to Explicit Config

**Goal:** Remove HTTP bind config from `DaemonLifecycleContext`; `startHttpServer` reads a `HttpServerStartConfig` parameter and returns the actual bound port.

**Commit boundary:** Do not commit after Task 2. Tasks 2-5 are one migration slice.

**Files:**
- Modify: `src/lib/daemon/daemon-lifecycle.ts`
- Test: `test/unit/daemon/daemon-lifecycle-bind.test.ts`

### Step 2.1: Search all affected call sites and fixtures

```bash
rg -n "DaemonLifecycleContext|startHttpServer\\(|startOnboardingServer\\(|ctx\\.(host|port|tls)" src test --glob "!**/*.skip"
```

Record the list. It must include source callers and test fixtures such as `test/unit/daemon/daemon-onboarding.test.ts`.

### Step 2.2: Create a failing bind/config test

Create `test/unit/daemon/daemon-lifecycle-bind.test.ts` with three assertions:

- `startHttpServer(ctx, { port: 0, host: "127.0.0.1" })` binds to `127.0.0.1` and returns the actual port.
- `startHttpServer(ctx, { port: 0, host: "0.0.0.0" })` binds to `0.0.0.0` and returns the actual port.
- TLS mode with fixture certs starts the protocol-detection wrapper; an HTTPS request succeeds; a plain HTTP request receives a `301` whose `Location` contains the actual bound port, not `:0`.

Use fixture certs at `test/fixtures/test-cert.pem` and `test/fixtures/test-key.pem`. If they do not exist yet, generate them with the command in Task 3.1 and include them in the Task 5 commit.

Run:

```bash
pnpm vitest run test/unit/daemon/daemon-lifecycle-bind.test.ts
```

Expected: FAIL because `startHttpServer` does not yet accept a config argument.

### Step 2.3: Remove config fields from `DaemonLifecycleContext`

In `src/lib/daemon/daemon-lifecycle.ts`, remove `port`, `host`, and `tls`:

```typescript
export interface DaemonLifecycleContext {
  httpServer: HttpServer | null;
  onboardingServer: HttpServer | null;
  upgradeServer: HttpServer | null;
  ipcServer: NetServer | null;
  ipcClients: Set<Socket>;
  clientCount: number;
  socketPath: string;
  router: {
    handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  } | null;
}
```

### Step 2.4: Add `HttpServerStartConfig` and refactor `startHttpServer`

```typescript
export interface HttpServerStartConfig {
  port: number;
  host: string;
  tls?: { key: Buffer; cert: Buffer };
}

export function startHttpServer(
  ctx: DaemonLifecycleContext,
  config: HttpServerStartConfig,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let actualPort = config.port;

    const handler = (req: IncomingMessage, res: ServerResponse) => {
      ctx.router!.handleRequest(req, res).catch((err) => {
        log.error("Request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });
    };

    if (config.tls) {
      const httpsServer = createHttpsServer(
        { key: config.tls.key, cert: config.tls.cert },
        handler,
      );
      ctx.upgradeServer = httpsServer;

      const httpRedirect = createServer((req, res) => {
        const reqHost = req.headers.host ?? `localhost:${actualPort}`;
        const hostBase = reqHost.replace(/:\d+$/, "");
        res.writeHead(301, {
          Location: `https://${hostBase}:${actualPort}${req.url ?? "/"}`,
        });
        res.end();
      });

      const netServer = createNetServer((socket) => {
        socket.once("readable", () => {
          const buf: Buffer | null = socket.read(1);
          if (buf === null) return;
          socket.unshift(buf);
          if (buf[0] === 0x16) {
            httpsServer.emit("connection", socket);
          } else {
            httpRedirect.emit("connection", socket);
          }
        });
      });

      ctx.httpServer = netServer as unknown as HttpServer;
    } else {
      ctx.httpServer = createServer(handler);
      ctx.upgradeServer = null;
    }

    ctx.httpServer.on("error", reject);
    ctx.httpServer.listen(config.port, config.host, () => {
      const addr = ctx.httpServer!.address();
      actualPort = addr && typeof addr !== "string" ? addr.port : config.port;
      resolve(actualPort);
    });
  });
}
```

### Step 2.5: Run the focused test

```bash
pnpm vitest run test/unit/daemon/daemon-lifecycle-bind.test.ts
```

Expected: PASS for `startHttpServer`. `pnpm check` can still fail until Tasks 3-5 update all callers. Do not commit.

---

## Task 3: Make `makeHttpServerLive` Read Tags and Write Back the Bound Port

**Goal:** HTTP server startup reads bind config from `DaemonConfigRefTag`, TLS material from `TlsCertTag`, and writes the actual bound port back into the Ref.

**Commit boundary:** Do not commit after Task 3.

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts`
- Test: `test/unit/effect/http-server-live.test.ts`
- Test fixture: `test/fixtures/test-cert.pem`, `test/fixtures/test-key.pem`

### Step 3.1: Generate fixture certs

```bash
mkdir -p test/fixtures
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout test/fixtures/test-key.pem \
  -out test/fixtures/test-cert.pem \
  -days 3650 -subj "/CN=conduit-test"
```

### Step 3.2: Write failing Layer tests

Create `test/unit/effect/http-server-live.test.ts` with these cases:

1. `makeHttpServerLive` binds to `host` from `DaemonConfigRefTag`.
2. `makeHttpServerLive` writes the actual bound port back to the same config Ref.
3. TLS material from `TlsCertTag` executes the TLS branch and sets `ctx.upgradeServer`.
4. Real handoff: provide `DaemonConfigRefLive({ tlsEnabled: true, hostExplicit: false, host: "127.0.0.1", port: 0, ... })`, provide real `TlsCertLive`, and provide a mocked `EnsureCertsTag` that returns the fixture certs. Assert the listener binds to `0.0.0.0`.

For cases that assert on `DaemonConfigRefTag`, expose the same named config layer to the assertion Effect:

```typescript
const configLayer = DaemonConfigRefLive({ ...baseConfig, port: 0 });
const testLayer = Layer.mergeAll(configLayer, makeHttpServerLive(ctx)).pipe(
  Layer.provide(NullTlsLayer),
);
```

Do not use only `makeHttpServerLive(ctx).pipe(Layer.provide(configLayer))`; `makeHttpServerLive` is `Layer.scopedDiscard` and does not output the config tag.

### Step 3.3: Refactor `makeHttpServerLive`

Update imports:

```typescript
import type { HttpServerStartConfig } from "../daemon/daemon-lifecycle.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { TlsCertTag } from "./tls-cert-layer.js";
```

Replace the body:

```typescript
export const makeHttpServerLive = (ctx: DaemonLifecycleContext) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const configRef = yield* DaemonConfigRefTag;
      const tls = yield* TlsCertTag;
      const config = yield* Ref.get(configRef);

      const startConfig: HttpServerStartConfig = {
        port: config.port,
        host: config.host,
        ...(tls.certs && {
          tls: {
            key: tls.certs.key,
            cert: tls.certs.caCertPem
              ? Buffer.concat([tls.certs.cert, Buffer.from("\n"), tls.certs.caCertPem])
              : tls.certs.cert,
          },
        }),
      };

      const actualPort = yield* Effect.tryPromise({
        try: () => startHttpServer(ctx, startConfig),
        catch: (cause) =>
          new DaemonLifecycleLayerError({ operation: "startHttpServer", cause }),
      });

      yield* Ref.update(configRef, (c) => ({ ...c, port: actualPort }));
      yield* Effect.addFinalizer(() =>
        closeLifecycleServer(() => closeHttpServer(ctx)),
      );
    }),
  );
```

### Step 3.4: Run focused tests

```bash
pnpm vitest run test/unit/effect/http-server-live.test.ts -t "makeHttpServerLive"
pnpm vitest run test/unit/daemon/daemon-lifecycle-bind.test.ts
```

Expected: PASS. Do not commit yet.

---

## Task 4: Refactor Onboarding Server to Read Tags and Preserve CA Material

**Goal:** Onboarding startup reads canonical host/port/TLS state from Tags, starts after HTTP has written the actual bound port, and serves CA material from `TlsCertTag`.

**Commit boundary:** Do not commit after Task 4.

**Files:**
- Modify: `src/lib/daemon/daemon-lifecycle.ts`
- Modify: `src/lib/effect/daemon-layers.ts`
- Test: `test/unit/effect/http-server-live.test.ts`
- Test: `test/unit/daemon/daemon-onboarding.test.ts`

### Step 4.1: Add Layer-level onboarding tests

Extend `test/unit/effect/http-server-live.test.ts`:

- `makeOnboardingServerLive` skips when `TlsCertTag.certs` is null.
- With TLS active, onboarding binds to host from `DaemonConfigRefTag`.
- With TLS active and non-null `TlsCertTag.caCertDer`, `/ca/download` returns that CA payload.
- Composed HTTP + onboarding with `port: 0` returns `/api/setup-info.httpsUrl` with the actual main-server port, not `:0`.

In the composed test, read the main-server bound address from `ctx.httpServer.address()` or from `DaemonConfigRefTag`. Do not read it from `ctx.upgradeServer.address()`; `ctx.upgradeServer` is the inner HTTPS server and is not the listening socket in protocol-detection mode.

### Step 4.2: Refactor `startOnboardingServer`

Add:

```typescript
export interface OnboardingServerStartConfig {
  /** Main HTTPS port used in redirect/setup URLs. */
  httpsPort: number;
  /** Onboarding listen port, usually httpsPort + 1, or 0 for OS assignment. */
  listenPort: number;
  host: string;
}
```

Change the signature:

```typescript
export function startOnboardingServer(
  ctx: DaemonLifecycleContext,
  deps: OnboardingServerDeps,
  config: OnboardingServerStartConfig,
): Promise<void> {
  // caller decides whether TLS is active
}
```

Delete the old `if (!ctx.tls) return Promise.resolve();` block.

Replacement rules:

| Existing reference | Replacement |
|---|---|
| `ctx.host` | `config.host` |
| `ctx.port + 1` | `config.listenPort` |
| `ctx.port` in `httpsUrl` / redirect `Location` | `config.httpsPort` |
| `actualPort` | unchanged; this is onboarding's own bound port |

### Step 4.3: Refactor `makeOnboardingServerLive`

Update imports to include `type OnboardingServerStartConfig`.

```typescript
export const makeOnboardingServerLive = (
  ctx: DaemonLifecycleContext,
  deps: OnboardingServerDeps,
) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const configRef = yield* DaemonConfigRefTag;
      const tls = yield* TlsCertTag;
      const config = yield* Ref.get(configRef);

      if (!tls.certs) return;

      const startConfig: OnboardingServerStartConfig = {
        httpsPort: config.port,
        listenPort: config.port === 0 ? 0 : config.port + 1,
        host: config.host,
      };

      const effectiveDeps: OnboardingServerDeps = {
        staticDir: deps.staticDir,
        caRootPath: tls.caRootPath,
        caCertDer: tls.caCertDer,
      };

      yield* Effect.tryPromise({
        try: () => startOnboardingServer(ctx, effectiveDeps, startConfig),
        catch: (cause) =>
          new DaemonLifecycleLayerError({
            operation: "startOnboardingServer",
            cause,
          }),
      });

      yield* Effect.addFinalizer(() =>
        closeLifecycleServer(() => closeOnboardingServer(ctx)),
      );
    }),
  );
```

### Step 4.4: Sequence onboarding after HTTP

Replace Tier 3 server composition:

```typescript
const httpAndIpc = Layer.mergeAll(
  makeHttpServerLive(options.ctx),
  makeIpcServerLive(options.ctx, options.ipcContext, options.getStatus),
);

const servers = makeOnboardingServerLive(options.ctx, options.onboarding).pipe(
  Layer.provideMerge(httpAndIpc),
).pipe(Layer.provideMerge(registries));
```

This guarantees the HTTP layer's `Ref.update(port=actualPort)` happens before onboarding reads the Ref for redirect/setup URLs.

### Step 4.5: Update direct onboarding tests

Update every `startOnboardingServer(ctx, deps)` call in `test/unit/daemon/daemon-onboarding.test.ts` to pass `OnboardingServerStartConfig`.

Move the old "is NOT started when TLS is not active" direct-helper test to `makeOnboardingServerLive`; after this refactor, TLS gating belongs in the Layer, not the lifecycle helper.

### Step 4.6: Run focused tests

```bash
pnpm vitest run test/unit/effect/http-server-live.test.ts -t "makeOnboardingServerLive"
pnpm vitest run test/unit/daemon/daemon-onboarding.test.ts
```

Expected: PASS. Do not commit yet.

---

## Task 5: Remove Post-Build Sync and Route Remaining Reads Through Canonical Config

**Goal:** Delete the post-runtime-build TLS/host readback into mutable locals and finish the synchronous read paths (`getStatus`, `buildConfig`, setup-info, restart config, returned daemon handle).

**Files:**
- Modify: `src/lib/effect/daemon-main.ts`
- Modify: `src/lib/server/effect-http-router.ts`
- Test: `test/unit/effect/daemon-main-getstatus.test.ts`
- Test: existing setup-info route tests in `test/unit/server/http-server-layer.test.ts`
- Test: any existing IPC/restart config tests that cover `applyConfig`

### Step 5.1: Add a synchronous runtime-config snapshot helper

Do not make `routerLayer` directly require `DaemonConfigRefTag`; it is built before `makeDaemonLive` creates that tag.

In `daemon-main.ts`, keep a local snapshot that is initialized before router construction and refreshed from the runtime when available:

```typescript
let runtimeConfigSnapshot = makeDaemonConfigFromOptions({
  port,
  host,
  hostExplicit: options.host !== undefined,
  pinHash,
  tlsEnabled,
  keepAwake,
  keepAwakeCommand,
  keepAwakeArgs,
  dismissedPaths: Array.from(dismissedPaths),
  startTime,
  persistedSessionCounts,
});

function readRuntimeConfigSnapshot(): DaemonRuntimeConfig {
  if (!daemonRuntime) return runtimeConfigSnapshot;
  try {
    runtimeConfigSnapshot = daemonRuntime.runSync(
      Effect.gen(function* () {
        const ref = yield* DaemonConfigRefTag;
        return yield* Ref.get(ref);
      }),
    );
  } catch {
    // During startup/shutdown, keep the last known snapshot.
  }
  return runtimeConfigSnapshot;
}

function updateRuntimeConfigSync(
  update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
): void {
  runtimeConfigSnapshot = update(runtimeConfigSnapshot);
  if (!daemonRuntime) return;
  daemonRuntime.runSync(
    Effect.gen(function* () {
      const ref = yield* DaemonConfigRefTag;
      yield* Ref.update(ref, update);
      runtimeConfigSnapshot = yield* Ref.get(ref);
    }),
  );
}
```

If TypeScript rejects assigning inside the generator, compute the new snapshot after `runSync` returns; keep the helper synchronous.

### Step 5.2: Update `buildConfig()`

`buildConfig()` currently reads `port`, `tlsEnabled`, `pinHash`, and keep-awake locals. It must use `readRuntimeConfigSnapshot()` for fields that are now canonical:

```typescript
function buildConfig(): DaemonConfig {
  const cfg = readRuntimeConfigSnapshot();
  return {
    pid: process.pid,
    port: cfg.port,
    pinHash: cfg.pinHash,
    tls: cfg.tlsEnabled,
    debug: false,
    keepAwake: cfg.keepAwake,
    ...(cfg.keepAwakeCommand != null && { keepAwakeCommand: cfg.keepAwakeCommand }),
    ...(cfg.keepAwakeArgs != null && { keepAwakeArgs: cfg.keepAwakeArgs }),
    // projects/instances/dismissedPaths unchanged, but prefer cfg.dismissedPaths
  };
}
```

### Step 5.3: Update `getStatus()`

Read port, host, TLS, pin, and keep-awake fields from `readRuntimeConfigSnapshot()`.

If any write path for a field is not migrated in this task, do not switch that field's status read to the Ref. In this plan, migrate the write paths in Step 5.5 so `getStatus().keepAwake` can safely read from the snapshot.

### Step 5.4: Update `SetupInfoProvider` without adding router Layer requirements

Change the provider interface in `src/lib/server/effect-http-router.ts`:

```typescript
export class SetupInfoProvider extends Context.Tag("SetupInfoProvider")<
  SetupInfoProvider,
  {
    readonly getPort: () => number;
    readonly getIsTls: () => boolean;
  }
>() {}
```

Update `setupInfoHandler`:

```typescript
const setup = maybeSetup.value;
const port = setup.getPort();
const isTls = setup.getIsTls();
const request = yield* HttpServerRequest.HttpServerRequest;
const hostHeader = request.headers["host"] ?? `localhost:${port}`;
const hostBase = hostHeader.replace(/:\d+$/, "");
const httpsUrl = `https://${hostBase}:${port}`;
const httpUrl = `http://${hostBase}:${port}`;
// ...
hasCert: isTls,
```

In `daemon-main.ts`, provide dependency-free closures:

```typescript
Layer.succeed(SetupInfoProvider, {
  getPort: () => readRuntimeConfigSnapshot().port,
  getIsTls: () => readRuntimeConfigSnapshot().tlsEnabled,
}),
```

Update existing setup-info route tests that currently pass `{ port, isTls }`.

### Step 5.5: Update write paths

Replace direct local-only updates with `updateRuntimeConfigSync(...)` where the config Ref now owns the field:

- `applyRestartConfig({ tls })` updates `tlsEnabled` synchronously before persistence/shutdown.
- `applyRestartConfig({ keepAwake })`, `setKeepAwake`, `setKeepAwakeCommand`, and keep-awake args update the config snapshot/Ref before status reads.
- Existing `pinHash` updates should keep updating the Ref; route them through the helper if it simplifies the code.
- If a write can happen before `daemonRuntime` exists, update `runtimeConfigSnapshot` and existing local fallback state consistently.

Do not use fire-and-forget `daemonRuntime.runPromise(...)` for config mutation followed by persistence or shutdown.

### Step 5.6: Delete obsolete ctx sync and imports

Delete:

- `let tlsCerts: TlsCerts | null = null`
- The post-runtime `TlsCertTag` readback block at `daemon-main.ts:1349-1375`
- `ctx.port = port`
- `ctx.host = host`
- `port = ctx.port`
- `ctx.tls = ...`
- Any remaining reads of `ctx.port`, `ctx.host`, or `ctx.tls`

Remove now-unused imports:

- `TlsCertTag` from `daemon-main.ts`
- `type TlsCerts` from the `../cli/tls.js` import

Update `ctx` initialization to server handles only.

### Step 5.7: Update returned daemon handle

Make the returned handle's `port` getter read the live snapshot:

```typescript
get port() {
  return readRuntimeConfigSnapshot().port;
}
```

Add a test or assertion that `port: 0` startup reports the actual bound port through `getStatus().port` and `daemon.port`.

### Step 5.8: Tests

Create or update `test/unit/effect/daemon-main-getstatus.test.ts` with focused assertions:

- TLS success path reports `tlsEnabled: true` and `host: "0.0.0.0"` using controlled certs or a test seam.
- TLS disabled reports `tlsEnabled: false` and `host: "127.0.0.1"`.
- `port: 0` reports the actual bound port in `getStatus().port` and `daemon.port`.
- setup-info route reflects live `getPort()` / `getIsTls()` provider values.
- restart/apply-config TLS update is applied synchronously before persistence/shutdown.

If `startDaemonProcess` cannot be made deterministic with fixture TLS material, add an explicit test seam instead of leaving a vague "mutate the Ref from a callback" note. Acceptable seams:

- `DaemonLiveOptions.ensureCertsLayer` / `tlsCertLayer` override for tests.
- A narrow internal helper that accepts a config snapshot and builds status/setup-info output.

### Step 5.9: Verify the full migration slice

```bash
pnpm check
pnpm lint
pnpm vitest run \
  test/unit/daemon/daemon-lifecycle-bind.test.ts \
  test/unit/daemon/daemon-onboarding.test.ts \
  test/unit/effect/http-server-live.test.ts \
  test/unit/effect/daemon-main-getstatus.test.ts \
  test/unit/server/http-server-layer.test.ts
```

Expected: PASS. Also run:

```bash
rg -n "ctx\\.(host|port|tls)|options\\.ctx\\.(host|port)" src test --glob "!**/*.skip"
```

Expected: no remaining matches, except comments that explicitly describe deleted behavior.

### Step 5.10: Commit Tasks 2-5 together

```bash
git add \
  src/lib/daemon/daemon-lifecycle.ts \
  src/lib/effect/daemon-layers.ts \
  src/lib/effect/daemon-main.ts \
  src/lib/server/effect-http-router.ts \
  test/unit/daemon/daemon-lifecycle-bind.test.ts \
  test/unit/daemon/daemon-onboarding.test.ts \
  test/unit/effect/http-server-live.test.ts \
  test/unit/effect/daemon-main-getstatus.test.ts \
  test/unit/server/http-server-layer.test.ts \
  test/fixtures/test-cert.pem \
  test/fixtures/test-key.pem
git commit -m "fix(effect): make daemon server bind config canonical"
```

---

## Task 6: Manual and Integration Verification

**Goal:** Prove the integrated daemon binds HTTPS on `0.0.0.0`, redirects plain HTTP on the same port, and serves onboarding setup info with correct ports.

### Step 6.0: Verify TLS and Tailscale prerequisites

```bash
mkcert -CAROOT
TS_IP="$(tailscale ip -4 2>/dev/null | head -n1)"
test -n "$TS_IP" || (echo "No Tailscale IPv4 found" && exit 1)
echo "$TS_IP"
```

If `mkcert -CAROOT` fails and no usable certs already exist under the daemon config dir, stop and report an environment blocker. Do not treat missing local TLS prerequisites as an implementation failure.

### Step 6.1: Run the default and broad test paths

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

If `pnpm test:all` fails, inspect `test-output.log`, fix root causes, and rerun the failed suite.

### Step 6.2: Stop any running daemon

```bash
pnpm exec tsx src/bin/cli.ts --stop || true
sleep 1
lsof -nP -i :2633 | grep LISTEN && (echo "Port 2633 still in use" && exit 1) || echo "Port 2633 free"
```

### Step 6.3: Start foreground daemon

In one terminal:

```bash
pnpm exec tsx watch src/bin/cli.ts -- --foreground --restart-daemon
```

Expected stdout includes:

```text
Conduit (foreground)
  OpenCode: http://localhost:4096
  Relay:    https://0.0.0.0:2633
  Project:  /Users/dstern/src/personal/conduit
  Ready.
```

### Step 6.4: Verify bind address

```bash
lsof -nP -i :2633 | grep LISTEN
```

Expected: `*:2633` or `0.0.0.0:2633`, not `127.0.0.1:2633`.

### Step 6.5: Verify HTTPS status via Tailscale

```bash
curl -k -sSf "https://$TS_IP:2633/api/status" | python3 -m json.tool
```

Expected JSON contains `"ok": true`, `"host": "0.0.0.0"`, and `"tlsEnabled": true`.

### Step 6.6: Verify HTTP redirect on the same port

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" "http://$TS_IP:2633/"
```

Expected: `301 https://$TS_IP:2633/`.

### Step 6.7: Verify onboarding server

```bash
curl -sS "http://$TS_IP:2634/api/setup-info" | python3 -m json.tool
```

Expected JSON:

```json
{
  "httpsUrl": "https://<TS_IP>:2633",
  "httpUrl": "http://<TS_IP>:2634",
  "hasCert": true
}
```

Also verify CA download:

```bash
curl -sS -o /tmp/conduit-ca.cer -D - "http://$TS_IP:2634/ca/download" | head
```

Expected: `200` with certificate content, not `404`.

### Step 6.8: Final-fix loop

If any smoke step fails:

1. Use `systematic-debugging`.
2. Patch the root cause.
3. Rerun `pnpm check`, `pnpm lint`, the touched unit/integration tests, and the failed smoke step.
4. Commit with a `fix:` message only after rerun evidence is recorded.

---

## Task 7: Open the PR

After all tests and manual checks pass:

```bash
git push -u origin ds/fix-daemon-effect-server-bind
gh pr create --title "fix(effect): restore HTTPS bind on 0.0.0.0 after Phase 8 daemon migration" \
  --body "$(cat <<'EOF'
## Summary
- Threads bind config (`port`, `host`, `tlsEnabled`, `hostExplicit`) from daemon startup into `DaemonConfigRef`.
- Makes `DaemonLifecycleContext` a server-handle sink only; `host`/`port`/`tls` are removed from its interface.
- `startHttpServer` / `startOnboardingServer` accept explicit config params instead of reading mutable ctx fields.
- `makeHttpServerLive` / `makeOnboardingServerLive` read host/port from `DaemonConfigRefTag` and TLS/CA material from `TlsCertTag`.
- Writes the actual bound port back into the Ref and uses that value for status, setup-info, persistence, redirects, and the daemon handle.
- Deletes the obsolete post-runtime-build "sync ctx out of Ref" block.

## Root cause
Phase 8 (`b3d0f8b`) introduced `DaemonConfigRefTag` but left the server bind path split between the Ref and stale mutable `DaemonLifecycleContext` fields. `tlsEnabled` and `hostExplicit` were not threaded into the initial Ref, so cert loading could short-circuit; server startup then read the pre-TLS ctx snapshot and bound to the wrong interface.

## Test plan
- [ ] `pnpm check`
- [ ] `pnpm lint`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:all`
- [ ] Foreground daemon stdout reports `Relay: https://0.0.0.0:2633`.
- [ ] `lsof -nP -i :2633` shows `*:2633` or `0.0.0.0:2633`, not `127.0.0.1:2633`.
- [ ] `curl -k https://$TS_IP:2633/api/status` returns JSON with `tlsEnabled: true` and `host: "0.0.0.0"`.
- [ ] HTTP to `http://$TS_IP:2633/` redirects to `https://$TS_IP:2633/`.
- [ ] Onboarding server on `$TS_IP:2634` serves `/api/setup-info` with correct URLs and `/ca/download` returns cert content.
EOF
)"
```

No Claude Code footer.

---

## Test Coverage Guarantee Statement

| Task | Correctness guaranteed | Related regression coverage |
|------|------------------------|-----------------------------|
| 1 | `makeDaemonConfigFromOptions` and `makeDaemonLive` seed the Ref from explicit inputs, not ctx. | Full wiring test avoids production TLS side effects; `tls-cert-layer.test.ts` remains focused on TLS behavior. |
| 2 | `startHttpServer` binds to explicit host, returns actual port, and redirects plain HTTP using actual port. | TLS + `port: 0` regression catches stale `:0` redirects. |
| 3 | HTTP Layer reads Ref/TLS tags and writes actual port back. | Real `TlsCertLive` handoff test proves host override reaches HTTP bind. |
| 4 | Onboarding Layer gates on `TlsCertTag`, binds after HTTP port resolution, and serves CA material from TLS tag. | Direct onboarding tests plus composed `/api/setup-info` and `/ca/download` tests cover old helper and new Layer behavior. |
| 5 | Status, setup-info, persistence, restart config, keep-awake status, and daemon handle read/update canonical runtime config. | Setup-info route tests, getStatus tests, restart/apply-config assertions, and port-0 handle assertions catch stale local reads. |
| 6 | Manual smoke proves the real daemon is reachable over Tailscale on HTTPS and onboarding. | Dynamic IP/TLS preflight avoids false failures from machine-specific assumptions. |

---

## Skills To Reference During Execution

- `superpowers:executing-plans`
- `superpowers:test-driven-development`
- `superpowers:verification-before-completion`
- `superpowers:effect-ts`
- `superpowers:systematic-debugging`
- `superpowers:using-git-worktrees`
- `superpowers:requesting-code-review`
