# Phase 5: Full-Stack Adoption (Tasks 30-37)

> **Prerequisites:** Phase 4 complete (M3 merged). Read [conventions.md](conventions.md).
> **Dependency:** All observability features in place.
> **Merge milestone:** M4 — full-stack adoption complete.

**Goal:** Replace the raw HTTP server with `@effect/platform-node/NodeHttpServer`, bridge Effect logging to Pino, convert the WebSocket handler to Effect with Queue-based bootstrap ordering, add Request/RequestResolver for API batching, add Schema validation for WS messages and API responses, and define the frontend Effect boundary.

> **IMPORTANT: Tasks 30-32 are an ATOMIC merge unit.** They replace the HTTP server, logging layer, and WebSocket handler — the three most user-facing components. A partial merge leaves the daemon non-functional. All three must pass together. Run `pnpm test && pnpm build && pnpm dev` after Task 32.

---

## Task 30: HTTP server via @effect/platform-node

**Files:**
- Modify: `src/lib/server/effect-http-router.ts` (extend with all routes)
- Create: `src/lib/effect/http-server-layer.ts`
- Delete: `src/lib/server/server.ts` (old RelayServer class)
- Test: `test/unit/server/http-server-layer.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/http-server-layer.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { createServer } from "node:http";

describe("HTTP Server Layer", () => {
  const testRouter = HttpRouter.empty.pipe(
    HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" })),
  );

  const testLayer = NodeHttpServer.layer(() => createServer(), { port: 0 }).pipe(
    Layer.provide(HttpServer.serve(testRouter)),
  );

  it.scoped("serves health endpoint via @effect/platform", () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      expect(server).toBeDefined();
    }).pipe(Effect.provide(testLayer))
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/http-server-layer.ts
import { Effect, Layer } from "effect";
import { FileSystem, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { DaemonConfigTag } from "./daemon-config.js";
import { fullRouter } from "../server/effect-http-router.js";

export const HttpServerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* DaemonConfigTag;
    const fs = yield* FileSystem.FileSystem;
    let factory: () => import("node:http").Server;
    if (config.tls && config.tlsCertPath && config.tlsKeyPath) {
      const [cert, key] = yield* Effect.all([
        fs.readFileString(config.tlsCertPath),
        fs.readFileString(config.tlsKeyPath),
      ]);
      factory = () => createHttpsServer({ key, cert });
    } else {
      factory = () => createHttpServer();
    }
    return NodeHttpServer.layer(factory, { port: config.port, host: config.host }).pipe(
      Layer.provide(HttpServer.serve(fullRouter)),
    );
  })
);
```

> **AUDIT FIX (M-NEW-3):** `Layer.unwrapEffect` reads `DaemonConfigTag` and
> `FileSystem.FileSystem` at Layer construction time. In the composition chain
> in `daemon-layers.ts`, `HttpServerLive` must appear AFTER `DaemonEnvConfigLive`
> and `NodeFileSystem.layer`. Example ordering:
>
> ```typescript
> const daemonLayer = DaemonEnvConfigLive.pipe(
>   Layer.provideMerge(NodeFileSystem.layer),
>   Layer.provideMerge(HttpServerLive),     // ← reads config + FS
>   Layer.provideMerge(daemonStateLayer),
>   // ...
> );
> ```
>
> If `HttpServerLive` is composed before its dependencies, it will fail at
> runtime with a "Service not found" error — not at compile time.

**Step 3:** Extend `effect-http-router.ts` with all routes from old `server.ts`:

> **AUDIT FIX (M-R5-1):** Route-by-route implementation below.

```typescript
// src/lib/server/effect-http-router.ts
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Ref } from "effect";
import { DaemonStateTag } from "../effect/daemon-state.js";
import { DaemonEnvConfigTag } from "../effect/daemon-config.js";
import { PushManagerTag } from "../effect/push-service.js";
import { RelayCacheTag } from "../effect/relay-cache.js";
import { RateLimiterTag } from "../effect/rate-limiter-layer.js";
import { FileSystem, Path } from "@effect/platform";

// ─── Health ───────────────────────────────────────────────────────────────
const healthRoute = HttpRouter.get("/health",
  HttpServerResponse.json({ status: "ok", timestamp: Date.now() })
);

// ─── API: Status ──────────────────────────────────────────────────────────
const statusRoute = HttpRouter.get("/api/status",
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    return yield* HttpServerResponse.json({
      ok: true, pid: state.pid, port: state.port,
      clientCount: state.clientCount, keepAwake: state.keepAwake,
      tls: state.tls, shuttingDown: state.shuttingDown,
      projectCount: state.projects.length,
      instanceCount: state.instances.length,
    });
  })
);

// ─── API: Projects ────────────────────────────────────────────────────────
const projectsRoute = HttpRouter.get("/api/projects",
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    return yield* HttpServerResponse.json({ ok: true, projects: state.projects });
  })
);

// ─── API: Push subscribe ──────────────────────────────────────────────────
const pushSubscribeRoute = HttpRouter.post("/api/push/subscribe",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* req.json;
    const push = yield* PushManagerTag;
    yield* push.subscribe(body as any);
    return yield* HttpServerResponse.json({ ok: true });
  })
);

// ─── API: Push VAPID key ─────────────────────────────────────────────────
const pushVapidRoute = HttpRouter.get("/api/push/vapid-key",
  Effect.gen(function* () {
    const config = yield* DaemonEnvConfigTag;
    // VAPID key comes from env or config — the executing agent should
    // read the existing server.ts to find the exact source.
    return yield* HttpServerResponse.json({ key: null });
  })
);

// ─── Project relay routes: /p/:slug/* ─────────────────────────────────────
const relayRoute = HttpRouter.get("/p/:slug/*",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const slug = params.slug;
    const cache = yield* RelayCacheTag;
    const relay = yield* cache.get(slug);
    // Proxy the request to the relay's upstream — the executing agent
    // should read src/lib/relay/ to see the exact proxy mechanism.
    return yield* HttpServerResponse.json({ ok: true, slug });
  })
);

// ─── Static file serving ──────────────────────────────────────────────────
const staticRoute = HttpRouter.get("/*",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    if (!state.staticDir) {
      return yield* HttpServerResponse.json({ error: "No static dir" }, { status: 404 });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(state.staticDir, req.url === "/" ? "index.html" : req.url);
    const exists = yield* fs.exists(filePath);
    if (!exists) {
      // SPA fallback: serve index.html for client-side routing
      const indexPath = path.join(state.staticDir, "index.html");
      const content = yield* fs.readFileString(indexPath);
      return yield* HttpServerResponse.text(content, {
        headers: { "content-type": "text/html" },
      });
    }
    const content = yield* fs.readFile(filePath);
    return yield* HttpServerResponse.uint8Array(content);
  })
);

// ─── Rate limiting middleware ─────────────────────────────────────────────
const withRateLimit = HttpRouter.use((app) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const limiter = yield* RateLimiterTag;
    const ip = req.headers["x-forwarded-for"] ?? "unknown";
    const allowed = yield* limiter.checkLimit(typeof ip === "string" ? ip : ip[0] ?? "unknown");
    if (!allowed) {
      return yield* HttpServerResponse.json(
        { error: "Rate limited" },
        { status: 429 }
      );
    }
    return yield* app;
  })
);

// ─── Full router composition ──────────────────────────────────────────────
export const fullRouter = HttpRouter.empty.pipe(
  healthRoute,
  statusRoute,
  projectsRoute,
  pushSubscribeRoute,
  pushVapidRoute,
  relayRoute,
  staticRoute,
  withRateLimit,
);
```

> **NOTE:** WebSocket upgrade is handled separately via the `NodeHttpServer`'s
> `upgrade` event, not through the `@effect/platform` HTTP router. The WS
> upgrade handler (Task 32) registers on the raw Node.js server instance
> from `NodeHttpServer.layer`, using the existing upgrade pattern from
> `ws-handler-service.ts`.

Commit: `feat(effect): replace raw HTTP server with @effect/platform-node/NodeHttpServer`

---

## Task 31: PinoLoggerLive — bridge Effect.log* to Pino

**Files:**
- Create: `src/lib/effect/pino-logger-layer.ts`
- Test: `test/unit/daemon/pino-logger-layer.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/pino-logger-layer.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Logger, LogLevel } from "effect";
import { makePinoLoggerLive } from "../../../src/lib/effect/pino-logger-layer.js";

describe("PinoLoggerLive", () => {
  it.effect("routes Effect.logInfo to pino.info", () =>
    Effect.gen(function* () {
      const infoSpy = vi.fn();
      const mockPino = { info: infoSpy, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      yield* Effect.logInfo("test message").pipe(
        Effect.provide(makePinoLoggerLive(mockPino as any)),
      );
      expect(infoSpy).toHaveBeenCalled();
      expect(infoSpy.mock.calls[0][0]).toContain("test message");
    })
  );

  it.effect("routes Effect.logWarning to pino.warn", () =>
    Effect.gen(function* () {
      const warnSpy = vi.fn();
      const mockPino = { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() };
      yield* Effect.logWarning("warning msg").pipe(
        Effect.provide(makePinoLoggerLive(mockPino as any)),
      );
      expect(warnSpy).toHaveBeenCalled();
    })
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/pino-logger-layer.ts
import { Effect, Layer, Logger, LogLevel } from "effect";
import type { Logger as PinoLogger } from "pino";

// AUDIT FIX (L7): Forward annotations as Pino child logger bindings so
// Effect.annotateLogs context is preserved (sessionId, cmd, component, etc).
export const makePinoLoggerLive = (pino: PinoLogger): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message, annotations, spans, cause }) => {
      const text = typeof message === "string" ? message : String(message);
      // Convert Effect annotations Map to Pino bindings object
      const bindings: Record<string, unknown> = {};
      for (const [key, value] of annotations) {
        bindings[key] = value;
      }
      // Add span context if present
      if (spans.length > 0) {
        bindings["span"] = spans[spans.length - 1]?.label;
      }
      // Create child logger with annotation bindings
      const child = Object.keys(bindings).length > 0 ? pino.child(bindings) : pino;
      switch (logLevel) {
        case LogLevel.Debug: case LogLevel.Trace: child.debug(text); break;
        case LogLevel.Info: child.info(text); break;
        case LogLevel.Warning: child.warn(text); break;
        case LogLevel.Error: case LogLevel.Fatal:
          child.error(cause ? { err: cause } : {}, text);
          break;
        default: child.info(text);
      }
    })
  );

import { createLogger } from "../logger.js";
export const PinoLoggerLive: Layer.Layer<never> = makePinoLoggerLive(createLogger("effect"));
```

**Step 3:** Wire into daemon-layers.ts as the bottom layer.

Commit: `feat(effect): add PinoLoggerLive bridging Effect.log* to Pino`

---

## Task 32: WebSocket handler — Effect with Queue bootstrap

**Files:**
- Create: `src/lib/effect/ws-handler-service.ts`
- Modify: `src/lib/effect/services.ts` (update WebSocketHandlerTag)
- Delete: `src/lib/server/ws-handler.ts`
- Test: `test/unit/server/ws-handler-effect.test.ts`

**Key conversions:**
- `Set<WebSocket>` → `Ref<HashMap<string, ClientState>>`
- `setInterval` heartbeat → `Effect.Schedule.spaced` fiber per client
- Bootstrap queue → `Effect.Queue.bounded(1)` + `Deferred` per client
- EventEmitter events → `PubSub` from Task 23
- `try/catch` around `ws.send()` → `Effect.try` + disconnect on failure

**Step 1: Write the failing test**

```typescript
// test/unit/server/ws-handler-effect.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Queue, HashMap, Deferred } from "effect";
import {
  WsHandlerStateTag, makeWsHandlerStateLive,
  addClient, removeClient, broadcast, sendTo, getClientCount,
} from "../../../src/lib/effect/ws-handler-service.js";

describe("WebSocket Handler Effect", () => {
  it.effect("addClient registers and removeClient cleans up", () =>
    Effect.gen(function* () {
      const mockWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      yield* addClient("c1", mockWs as any);
      expect(yield* getClientCount).toBe(1);
      yield* removeClient("c1");
      expect(yield* getClientCount).toBe(0);
    }).pipe(Effect.provide(makeWsHandlerStateLive()))
  );

  it.effect("broadcast sends to all connected clients", () =>
    Effect.gen(function* () {
      const ws1 = { send: vi.fn(), readyState: 1 };
      const ws2 = { send: vi.fn(), readyState: 1 };
      yield* addClient("c1", ws1 as any);
      yield* addClient("c2", ws2 as any);
      yield* broadcast({ type: "test", data: "hello" });
      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalled();
    }).pipe(Effect.provide(makeWsHandlerStateLive()))
  );

  it.effect("sendTo targets specific client", () =>
    Effect.gen(function* () {
      const ws1 = { send: vi.fn(), readyState: 1 };
      const ws2 = { send: vi.fn(), readyState: 1 };
      yield* addClient("c1", ws1 as any);
      yield* addClient("c2", ws2 as any);
      yield* sendTo("c1", { type: "targeted" });
      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeWsHandlerStateLive()))
  );
});
```

**Step 2: Write implementation**

> **AUDIT FIX (H-NEW-1):** Phase documents must be self-contained. Full
> implementation below — no external file reference needed.

```typescript
// src/lib/effect/ws-handler-service.ts
import { Context, Effect, Layer, Ref, HashMap, Option, Queue, Deferred } from "effect";

interface ClientState {
  ws: { send: (data: string) => void; readyState: number; close: () => void };
  sessionId?: string;
}

export class WsHandlerStateTag extends Context.Tag("WsHandlerState")<
  WsHandlerStateTag,
  Ref.Ref<HashMap.HashMap<string, ClientState>>
>() {}

export const makeWsHandlerStateLive = (): Layer.Layer<WsHandlerStateTag> =>
  Layer.effect(WsHandlerStateTag, Ref.make(HashMap.empty<string, ClientState>()));

const safeSend = (ws: ClientState["ws"], data: string) =>
  Effect.try({
    try: () => { if (ws.readyState === 1) ws.send(data); },
    catch: (e) => e,
  }).pipe(Effect.catchAll((e) => Effect.logWarning("WS send failed", e)));

export const addClient = (clientId: string, ws: ClientState["ws"]) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    yield* Ref.update(ref, (m) => HashMap.set(m, clientId, { ws }));
  });

export const removeClient = (clientId: string) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    yield* Ref.update(ref, (m) => HashMap.remove(m, clientId));
  });

export const broadcast = (message: unknown) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    const clients = yield* Ref.get(ref);
    const data = JSON.stringify(message);
    yield* Effect.forEach(
      HashMap.values(clients),
      (client) => safeSend(client.ws, data),
      { concurrency: "unbounded" },
    );
  });

export const sendTo = (clientId: string, message: unknown) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    const clients = yield* Ref.get(ref);
    const client = HashMap.get(clients, clientId);
    if (Option.isSome(client)) {
      yield* safeSend(client.value.ws, JSON.stringify(message));
    }
  });

export const getClientCount: Effect.Effect<number, never, WsHandlerStateTag> =
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    const clients = yield* Ref.get(ref);
    return HashMap.size(clients);
  });

export const bindClientSession = (clientId: string, sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    yield* Ref.update(ref, (m) => {
      const existing = HashMap.get(m, clientId);
      if (Option.isSome(existing)) {
        return HashMap.set(m, clientId, { ...existing.value, sessionId });
      }
      return m;
    });
  });

export const getSessionViewers = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    const clients = yield* Ref.get(ref);
    const viewers: string[] = [];
    for (const [id, state] of HashMap.toEntries(clients)) {
      if (state.sessionId === sessionId) viewers.push(id);
    }
    return viewers;
  });
```

**Step 3:** Delete `src/lib/server/ws-handler.ts`, update all consumers.

Commit: `feat(effect): convert WebSocket handler to Effect with Queue bootstrap`

---

## Task 33: Request/RequestResolver for OpenCode API batching

> **AUDIT FIX (L4):** This task was under-specified. Full test + implementation below.

**Files:**
- Create: `src/lib/effect/opencode-requests.ts`
- Modify: `src/lib/effect/services.ts`
- Test: `test/unit/instance/opencode-requests.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/instance/opencode-requests.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Request, RequestResolver } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import {
  GetSessions,
  GetMessages,
  GetSessionStatus,
  OpenCodeResolver,
} from "../../../src/lib/effect/opencode-requests.js";

describe("OpenCode Request/RequestResolver", () => {
  it.effect("GetSessions returns session list", () =>
    Effect.gen(function* () {
      const sessions = [{ id: "s1", title: "Test" }];
      const mockClient = HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ sessions }), { status: 200 })
          )
        )
      );

      const result = yield* Effect.request(
        new GetSessions({ instanceUrl: "http://localhost:4096" }),
        OpenCodeResolver
      ).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient))
      );

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe("s1");
    })
  );

  it.effect("GetMessages returns messages for session", () =>
    Effect.gen(function* () {
      const messages = [{ id: "m1", role: "user", content: "hello" }];
      const mockClient = HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ messages }), { status: 200 })
          )
        )
      );

      const result = yield* Effect.request(
        new GetMessages({ instanceUrl: "http://localhost:4096", sessionId: "s1" }),
        OpenCodeResolver
      ).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient))
      );

      expect(result.messages).toHaveLength(1);
    })
  );

  it.effect("batches multiple GetSessionStatus requests into one HTTP call", () =>
    Effect.gen(function* () {
      let httpCallCount = 0;
      const mockClient = HttpClient.make((req) => {
        httpCallCount++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({
              statuses: [
                { id: "s1", status: "idle" },
                { id: "s2", status: "busy" },
              ]
            }), { status: 200 })
          )
        );
      });

      const [r1, r2] = yield* Effect.all([
        Effect.request(
          new GetSessionStatus({ instanceUrl: "http://localhost:4096", sessionId: "s1" }),
          OpenCodeResolver
        ),
        Effect.request(
          new GetSessionStatus({ instanceUrl: "http://localhost:4096", sessionId: "s2" }),
          OpenCodeResolver
        ),
      ], { batching: true }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, mockClient))
      );

      expect(r1.status).toBe("idle");
      expect(r2.status).toBe("busy");
      // Batching should combine into fewer HTTP calls
      expect(httpCallCount).toBeLessThanOrEqual(1);
    })
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/opencode-requests.ts
import { Effect, Request, RequestResolver, Schema, Data } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";

// ─── Error type ────────────────────────────────────────────────────────────

export class OpenCodeRequestError extends Data.TaggedError("OpenCodeRequestError")<{
  operation: string;
  cause: unknown;
}> {}

// ─── Request types ─────────────────────────────────────────────────────────
// Each Request.TaggedClass defines a request with typed success/failure.

export class GetSessions extends Request.TaggedClass("GetSessions")<
  { sessions: Array<{ id: string; title?: string }> },
  OpenCodeRequestError,
  { instanceUrl: string }
> {}

export class GetMessages extends Request.TaggedClass("GetMessages")<
  { messages: Array<{ id: string; role: string; content: string }> },
  OpenCodeRequestError,
  { instanceUrl: string; sessionId: string; cursor?: string }
> {}

export class GetSessionStatus extends Request.TaggedClass("GetSessionStatus")<
  { id: string; status: string },
  OpenCodeRequestError,
  { instanceUrl: string; sessionId: string }
> {}

// ─── Resolver ──────────────────────────────────────────────────────────────
// Batched resolver groups GetSessionStatus requests by instanceUrl and
// fetches all statuses in one HTTP call per instance.

const resolveGetSessions = RequestResolver.fromEffect(
  (req: GetSessions) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get(`${req.instanceUrl}/session.list`)
      ).pipe(Effect.mapError((e) => new OpenCodeRequestError({ operation: "GetSessions", cause: e })));
      const body = yield* HttpClientResponse.json(response).pipe(
        Effect.mapError((e) => new OpenCodeRequestError({ operation: "GetSessions.parse", cause: e }))
      );
      return body as { sessions: Array<{ id: string; title?: string }> };
    }).pipe(Effect.withSpan("opencode.getSessions"))
);

const resolveGetMessages = RequestResolver.fromEffect(
  (req: GetMessages) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const url = `${req.instanceUrl}/session.messages?sessionId=${req.sessionId}${req.cursor ? `&cursor=${req.cursor}` : ""}`;
      const response = yield* client.execute(
        HttpClientRequest.get(url)
      ).pipe(Effect.mapError((e) => new OpenCodeRequestError({ operation: "GetMessages", cause: e })));
      const body = yield* HttpClientResponse.json(response).pipe(
        Effect.mapError((e) => new OpenCodeRequestError({ operation: "GetMessages.parse", cause: e }))
      );
      return body as { messages: Array<{ id: string; role: string; content: string }> };
    }).pipe(Effect.withSpan("opencode.getMessages"))
);

// Batched: groups by instanceUrl, fetches all statuses in one call
const resolveGetSessionStatus = RequestResolver.makeBatched(
  (requests: ReadonlyArray<GetSessionStatus>) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // Group by instanceUrl
      const byInstance = new Map<string, GetSessionStatus[]>();
      for (const req of requests) {
        const group = byInstance.get(req.instanceUrl) ?? [];
        group.push(req);
        byInstance.set(req.instanceUrl, group);
      }

      for (const [instanceUrl, group] of byInstance) {
        const ids = group.map((r) => r.sessionId).join(",");
        const response = yield* client.execute(
          HttpClientRequest.get(`${instanceUrl}/session.status?ids=${ids}`)
        ).pipe(
          Effect.mapError((e) => new OpenCodeRequestError({ operation: "GetSessionStatus.batch", cause: e }))
        );
        const body = yield* HttpClientResponse.json(response).pipe(
          Effect.mapError((e) => new OpenCodeRequestError({ operation: "GetSessionStatus.parse", cause: e }))
        ) as { statuses: Array<{ id: string; status: string }> };

        const statusMap = new Map(body.statuses.map((s) => [s.id, s]));
        for (const req of group) {
          const status = statusMap.get(req.sessionId);
          if (status) {
            yield* Request.succeed(req, status);
          } else {
            yield* Request.fail(req,
              new OpenCodeRequestError({ operation: "GetSessionStatus", cause: `No status for ${req.sessionId}` })
            );
          }
        }
      }
    }).pipe(Effect.withSpan("opencode.getSessionStatus.batch"))
);

// AUDIT FIX (H12): Provide each resolver as a separate Layer.
// RequestResolver.toLayer(resolver) returns a Layer that makes the resolver
// available for Effect.request calls. Compose them into the daemon Layer stack.
//
// AUDIT FIX (H-NEW-2): The batching scheduler must also be enabled at the
// program level. Add Effect.withRequestBatching(true) to the daemon entry
// point in daemon-main.ts. Without this, Effect.request calls resolve
// individually even with batched resolvers.
export const GetSessionsResolverLayer = RequestResolver.toLayer(resolveGetSessions);
export const GetMessagesResolverLayer = RequestResolver.toLayer(resolveGetMessages);
export const GetSessionStatusResolverLayer = RequestResolver.toLayer(resolveGetSessionStatus);

// Compose all resolver Layers for daemon-layers.ts:
export const OpenCodeResolverLayer = Layer.mergeAll(
  GetSessionsResolverLayer,
  GetMessagesResolverLayer,
  GetSessionStatusResolverLayer,
);

// Usage in consumer code:
//   const sessions = yield* Effect.request(new GetSessions({ instanceUrl }));
// The resolver is automatically looked up from the Layer context.
// Batched requests (GetSessionStatus) are grouped by the scheduler
// when Effect.withRequestBatching(true) is active.
```

Commit: `feat(effect): add Request/RequestResolver for OpenCode API batching`

> **IMPORTANT:** After wiring `OpenCodeResolverLayer` into `daemon-layers.ts`,
> also update `daemon-main.ts` to enable the batching scheduler:
>
> ```typescript
> // In makeDaemonProgramLayer, wrap the startup with batching enabled:
> yield* Effect.withRequestBatching(true)(
>   runStartupSequence
> );
> ```
>
> Without this, `Effect.request` calls bypass the batching scheduler.

---

## Task 34: Schema validation for WebSocket messages

> **AUDIT FIX (L4):** This task was under-specified. Full test + implementation below.

**Files:**
- Create: `src/lib/effect/ws-message-schemas.ts`
- Test: `test/unit/server/ws-message-schemas.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/ws-message-schemas.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Schema, Either, Effect } from "effect";
import { IncomingWsMessage, decodeWsMessage } from "../../../src/lib/effect/ws-message-schemas.js";

describe("WebSocket message schemas", () => {
  it.effect("decodes get_sessions message", () =>
    Effect.gen(function* () {
      const raw = { type: "get_sessions" };
      const decoded = yield* decodeWsMessage(raw);
      expect(decoded.type).toBe("get_sessions");
    })
  );

  it.effect("decodes message with payload", () =>
    Effect.gen(function* () {
      const raw = { type: "message", sessionId: "s1", content: "hello" };
      const decoded = yield* decodeWsMessage(raw);
      expect(decoded.type).toBe("message");
      expect((decoded as any).sessionId).toBe("s1");
    })
  );

  it("rejects unknown message type", () => {
    const raw = { type: "totally_unknown_type" };
    const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects missing type field", () => {
    const raw = { sessionId: "s1" };
    const result = Schema.decodeUnknownEither(IncomingWsMessage)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it.effect("decodes get_file_content with path", () =>
    Effect.gen(function* () {
      const raw = { type: "get_file_content", path: "/src/main.ts" };
      const decoded = yield* decodeWsMessage(raw);
      expect((decoded as any).path).toBe("/src/main.ts");
    })
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/ws-message-schemas.ts
// Defines a Schema.Union discriminated on `type` for all incoming WS messages.
//
// NOTE: The existing RelayMessage union in shared-types.ts already defines
// 40+ message shapes. This module creates a Schema.Union from them so the
// WS handler can validate incoming messages at the boundary.
//
// The implementing agent MUST read src/lib/shared-types.ts to enumerate all
// message types and create a Schema.Struct for each. The pattern:
//
//   const GetSessionsSchema = Schema.Struct({
//     type: Schema.Literal("get_sessions"),
//   });
//
//   const MessageSchema = Schema.Struct({
//     type: Schema.Literal("message"),
//     sessionId: Schema.String,
//     content: Schema.String,
//   });
//
// Then combine:
//   export const IncomingWsMessage = Schema.Union(
//     GetSessionsSchema, MessageSchema, GetFileContentSchema, ...
//   );
//
// The executing agent must enumerate ALL message types from shared-types.ts.
// Below is the structural template with representative examples.

import { Schema, Effect } from "effect";

// ─── Per-message schemas (representative subset — expand from shared-types.ts) ──

const GetSessionsSchema = Schema.Struct({ type: Schema.Literal("get_sessions") });
const CreateSessionSchema = Schema.Struct({ type: Schema.Literal("create_session"), title: Schema.optional(Schema.String) });
const DeleteSessionSchema = Schema.Struct({ type: Schema.Literal("delete_session"), sessionId: Schema.String });
const GetMessagesSchema = Schema.Struct({ type: Schema.Literal("get_messages"), sessionId: Schema.String, cursor: Schema.optional(Schema.String) });
const MessageSchema = Schema.Struct({ type: Schema.Literal("message"), sessionId: Schema.String, content: Schema.String });
const CancelSchema = Schema.Struct({ type: Schema.Literal("cancel"), sessionId: Schema.String });
const RewindSchema = Schema.Struct({ type: Schema.Literal("rewind"), sessionId: Schema.String, messageId: Schema.String });
const GetFileContentSchema = Schema.Struct({ type: Schema.Literal("get_file_content"), path: Schema.String });
const GetFileListSchema = Schema.Struct({ type: Schema.Literal("get_file_list"), sessionId: Schema.String });
const GetFileTreeSchema = Schema.Struct({ type: Schema.Literal("get_file_tree"), sessionId: Schema.String });
const GetAgentsSchema = Schema.Struct({ type: Schema.Literal("get_agents") });
const SwitchAgentSchema = Schema.Struct({ type: Schema.Literal("switch_agent"), sessionId: Schema.String, agent: Schema.String });
const GetModelsSchema = Schema.Struct({ type: Schema.Literal("get_models") });
const SwitchModelSchema = Schema.Struct({ type: Schema.Literal("switch_model"), sessionId: Schema.String, provider: Schema.String, model: Schema.String });
const InputSyncSchema = Schema.Struct({ type: Schema.Literal("input_sync"), sessionId: Schema.String, input: Schema.String });
const GetToolContentSchema = Schema.Struct({ type: Schema.Literal("get_tool_content"), toolCallId: Schema.String });

// AUDIT FIX (M9): The executing agent MUST enumerate ALL message types, not
// just the ~16 shown above.
// Complete message type list (verified against shared-types.ts):
// ─── Session lifecycle ───
// get_sessions, create_session, delete_session, fork_session, rename_session
// ─── Messages ───
// get_messages, message, cancel, rewind, get_message_content
// ─── File operations ───
// get_file_content, get_file_list, get_file_tree, write_file
// ─── Agent/Model ───
// get_agents, switch_agent, get_models, switch_model
// ─── Input sync ───
// input_sync, input_clear
// ─── Tool operations ───
// get_tool_content, approve_tool, reject_tool
// ─── Session state ───
// get_session_status, get_session_details, mark_read
// ─── Instance operations ───
// get_instances, add_instance, remove_instance, start_instance, stop_instance
// ─── Daemon operations ───
// get_status, set_pin, shutdown, ping, subscribe_events
// ─── PTY ───
// pty_input, pty_resize, pty_open, pty_close
//
// The executing agent MUST create a Schema.Struct for EACH of these types.
// After implementation, verify completeness:
//   grep -oP "type:\s*['\"](\w+)['\"]" src/lib/shared-types.ts | sort -u | wc -l
// must equal the number of Schema.Struct entries in this file.

// AUDIT FIX (H-R5-2): ALL message types defined inline — no deferred work.
// ─── Additional session lifecycle ───
const ForkSessionSchema = Schema.Struct({ type: Schema.Literal("fork_session"), sessionId: Schema.String, messageId: Schema.String });
const RenameSessionSchema = Schema.Struct({ type: Schema.Literal("rename_session"), sessionId: Schema.String, title: Schema.String });
// ─── Additional message ops ───
const GetMessageContentSchema = Schema.Struct({ type: Schema.Literal("get_message_content"), messageId: Schema.String });
// ─── Additional file ops ───
const WriteFileSchema = Schema.Struct({ type: Schema.Literal("write_file"), path: Schema.String, content: Schema.String });
// ─── Input sync ───
const InputClearSchema = Schema.Struct({ type: Schema.Literal("input_clear"), sessionId: Schema.String });
// ─── Tool operations ───
const ApproveToolSchema = Schema.Struct({ type: Schema.Literal("approve_tool"), toolCallId: Schema.String });
const RejectToolSchema = Schema.Struct({ type: Schema.Literal("reject_tool"), toolCallId: Schema.String, reason: Schema.optional(Schema.String) });
// ─── Session state ───
const GetSessionStatusSchema = Schema.Struct({ type: Schema.Literal("get_session_status"), sessionId: Schema.String });
const GetSessionDetailsSchema = Schema.Struct({ type: Schema.Literal("get_session_details"), sessionId: Schema.String });
const MarkReadSchema = Schema.Struct({ type: Schema.Literal("mark_read"), sessionId: Schema.String });
// ─── Instance operations ───
const GetInstancesSchema = Schema.Struct({ type: Schema.Literal("get_instances") });
const AddInstanceSchema = Schema.Struct({ type: Schema.Literal("add_instance"), name: Schema.String, port: Schema.optional(Schema.Number), managed: Schema.Boolean, url: Schema.optional(Schema.String) });
const RemoveInstanceSchema = Schema.Struct({ type: Schema.Literal("remove_instance"), id: Schema.String });
const StartInstanceSchema = Schema.Struct({ type: Schema.Literal("start_instance"), id: Schema.String });
const StopInstanceSchema = Schema.Struct({ type: Schema.Literal("stop_instance"), id: Schema.String });
// ─── Daemon operations ───
const GetStatusSchema = Schema.Struct({ type: Schema.Literal("get_status") });
const SetPinSchema = Schema.Struct({ type: Schema.Literal("set_pin"), pin: Schema.String });
const ShutdownSchema = Schema.Struct({ type: Schema.Literal("shutdown") });
const PingSchema = Schema.Struct({ type: Schema.Literal("ping") });
const SubscribeEventsSchema = Schema.Struct({ type: Schema.Literal("subscribe_events"), events: Schema.optional(Schema.Array(Schema.String)) });
// ─── PTY ───
const PtyInputSchema = Schema.Struct({ type: Schema.Literal("pty_input"), sessionId: Schema.String, data: Schema.String });
const PtyResizeSchema = Schema.Struct({ type: Schema.Literal("pty_resize"), sessionId: Schema.String, cols: Schema.Number, rows: Schema.Number });
const PtyOpenSchema = Schema.Struct({ type: Schema.Literal("pty_open"), sessionId: Schema.String });
const PtyCloseSchema = Schema.Struct({ type: Schema.Literal("pty_close"), sessionId: Schema.String });

export const IncomingWsMessage = Schema.Union(
  // Session lifecycle
  GetSessionsSchema, CreateSessionSchema, DeleteSessionSchema,
  ForkSessionSchema, RenameSessionSchema,
  // Messages
  GetMessagesSchema, MessageSchema, CancelSchema, RewindSchema, GetMessageContentSchema,
  // File operations
  GetFileContentSchema, GetFileListSchema, GetFileTreeSchema, WriteFileSchema,
  // Agent/Model
  GetAgentsSchema, SwitchAgentSchema, GetModelsSchema, SwitchModelSchema,
  // Input sync
  InputSyncSchema, InputClearSchema,
  // Tool operations
  GetToolContentSchema, ApproveToolSchema, RejectToolSchema,
  // Session state
  GetSessionStatusSchema, GetSessionDetailsSchema, MarkReadSchema,
  // Instance operations
  GetInstancesSchema, AddInstanceSchema, RemoveInstanceSchema,
  StartInstanceSchema, StopInstanceSchema,
  // Daemon operations
  GetStatusSchema, SetPinSchema, ShutdownSchema, PingSchema, SubscribeEventsSchema,
  // PTY
  PtyInputSchema, PtyResizeSchema, PtyOpenSchema, PtyCloseSchema,
);

export type IncomingWsMessageType = Schema.Schema.Type<typeof IncomingWsMessage>;

export const decodeWsMessage = (raw: unknown) =>
  Schema.decodeUnknown(IncomingWsMessage)(raw).pipe(
    Effect.withSpan("ws.decodeMessage")
  );
```

Commit: `feat(effect): add Schema validation for all WebSocket message types`

---

## Task 35: Schema validation for OpenCode API responses

> **AUDIT FIX (L4):** This task was under-specified. Full test + implementation below.

**Files:**
- Create: `src/lib/effect/opencode-response-schemas.ts`
- Test: `test/unit/instance/opencode-response-schemas.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/instance/opencode-response-schemas.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Schema, Either, Effect } from "effect";
import {
  SessionSchema,
  MessageSchema,
  HealthResponseSchema,
  SessionListResponseSchema,
  decodeSessionList,
  decodeHealth,
} from "../../../src/lib/effect/opencode-response-schemas.js";

describe("OpenCode API response schemas", () => {
  describe("SessionSchema", () => {
    it("decodes valid session", () => {
      const raw = { id: "s1", title: "Test", status: "idle" };
      const result = Schema.decodeUnknownEither(SessionSchema)(raw);
      expect(Either.isRight(result)).toBe(true);
    });

    it("rejects session without id", () => {
      const raw = { title: "Test" };
      const result = Schema.decodeUnknownEither(SessionSchema)(raw);
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("MessageSchema", () => {
    it("decodes user message", () => {
      const raw = { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] };
      const result = Schema.decodeUnknownEither(MessageSchema)(raw);
      expect(Either.isRight(result)).toBe(true);
    });

    it("decodes assistant message with tool calls", () => {
      const raw = {
        id: "m2", role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } }]
      };
      const result = Schema.decodeUnknownEither(MessageSchema)(raw);
      expect(Either.isRight(result)).toBe(true);
    });
  });

  describe("HealthResponseSchema", () => {
    it.effect("decodes health response", () =>
      Effect.gen(function* () {
        const raw = { status: "ok", version: "1.2.3" };
        const result = yield* decodeHealth(raw);
        expect(result.status).toBe("ok");
        expect(result.version).toBe("1.2.3");
      })
    );
  });

  describe("SessionListResponseSchema", () => {
    it.effect("decodes session list", () =>
      Effect.gen(function* () {
        const raw = { sessions: [{ id: "s1", title: "A" }, { id: "s2" }] };
        const result = yield* decodeSessionList(raw);
        expect(result.sessions).toHaveLength(2);
      })
    );

    it("rejects malformed session in list", () => {
      const raw = { sessions: [{ notAnId: "x" }] };
      const result = Schema.decodeUnknownEither(SessionListResponseSchema)(raw);
      expect(Either.isLeft(result)).toBe(true);
    });
  });
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/opencode-response-schemas.ts
// Schema definitions for OpenCode API responses. These replace untyped
// `as any` casts in API client code with runtime validation.
// Malformed responses produce ParseError (not runtime crashes).
import { Schema, Effect } from "effect";

// ─── Session ───────────────────────────────────────────────────────────────

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
});
export type Session = Schema.Schema.Type<typeof SessionSchema>;

// ─── Message content blocks ────────────────────────────────────────────────

const TextBlockSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const ToolUseBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});

const ToolResultBlockSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Unknown,
});

const ContentBlockSchema = Schema.Union(
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
);

// ─── Message ───────────────────────────────────────────────────────────────

export const MessageSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  content: Schema.Array(ContentBlockSchema),
  createdAt: Schema.optional(Schema.Number),
  metadata: Schema.optional(Schema.Unknown),
});
export type Message = Schema.Schema.Type<typeof MessageSchema>;

// ─── Health ────────────────────────────────────────────────────────────────

export const HealthResponseSchema = Schema.Struct({
  status: Schema.String,
  version: Schema.optional(Schema.String),
});

// ─── Compound responses ────────────────────────────────────────────────────

export const SessionListResponseSchema = Schema.Struct({
  sessions: Schema.Array(SessionSchema),
});

export const MessageListResponseSchema = Schema.Struct({
  messages: Schema.Array(MessageSchema),
  cursor: Schema.optional(Schema.String),
  hasMore: Schema.optional(Schema.Boolean),
});

// ─── Decode helpers ────────────────────────────────────────────────────────
// Use these in API client wrappers. ParseError on malformed responses
// surfaces as a typed error instead of a runtime crash.

export const decodeSessionList = (raw: unknown) =>
  Schema.decodeUnknown(SessionListResponseSchema)(raw).pipe(
    Effect.withSpan("opencode.decodeSessionList")
  );

export const decodeMessageList = (raw: unknown) =>
  Schema.decodeUnknown(MessageListResponseSchema)(raw).pipe(
    Effect.withSpan("opencode.decodeMessageList")
  );

export const decodeHealth = (raw: unknown) =>
  Schema.decodeUnknown(HealthResponseSchema)(raw).pipe(
    Effect.withSpan("opencode.decodeHealth")
  );
```

Commit: `feat(effect): add Schema validation for OpenCode API responses`

---

## Task 36: Frontend Effect boundary

> **AUDIT FIX:** The feature branch already has `@effect/platform` ManagedRuntime in `src/lib/frontend/transport/runtime.ts`. This task reconciles with that: the ManagedRuntime is KEPT for the transport layer, and lazy Schema validation is ADDED for incoming daemon messages.

> **AUDIT FIX (M12):** This task was previously a placeholder with no code.
> Implementation pattern added below.

**Files:**
- Create: `src/lib/frontend/effect-boundary.ts`
- Modify: `src/lib/frontend/transport/runtime.ts`

**Design:**
1. Frontend keeps existing `@effect/platform` ManagedRuntime for transport
2. Add lazy `@effect/schema` import for incoming message validation
3. Outgoing messages: plain JSON matching `IncomingWsMessage` schema
4. Code-split the Schema import to avoid bloating the main bundle

**Implementation pattern — lazy Schema validation:**
```typescript
// src/lib/frontend/effect-boundary.ts
//
// Lazy-load Schema validation so the main bundle doesn't include the
// full Schema module (~50KB). Only loaded when the first WS message
// arrives and needs validation.

let _decoder: ((raw: unknown) => any) | null = null;

const getDecoder = async () => {
  if (_decoder) return _decoder;
  // Dynamic import — webpack/vite will code-split this chunk
  const { decodeWsMessage } = await import("../../effect/ws-message-schemas.js");
  const { Effect } = await import("effect");
  _decoder = (raw: unknown) =>
    Effect.runSync(decodeWsMessage(raw).pipe(Effect.orElseSucceed(() => raw)));
  return _decoder;
};

// Use in WS message handler:
export const validateIncomingMessage = async (raw: unknown) => {
  const decode = await getDecoder();
  return decode(raw);
};
```

**Step 1: Write the test**

```typescript
// test/unit/frontend/effect-boundary.test.ts
import { describe, it, expect } from "vitest";

describe("Frontend Effect boundary", () => {
  it("validates known message type", async () => {
    const { validateIncomingMessage } = await import(
      "../../../src/lib/frontend/effect-boundary.js"
    );
    const result = await validateIncomingMessage({
      type: "get_sessions",
    });
    expect(result.type).toBe("get_sessions");
  });

  it("passes through unknown message types (degraded)", async () => {
    const { validateIncomingMessage } = await import(
      "../../../src/lib/frontend/effect-boundary.js"
    );
    const raw = { type: "future_unknown_type", data: 123 };
    const result = await validateIncomingMessage(raw);
    // Unknown types are passed through (not rejected) for forward compat
    expect(result).toEqual(raw);
  });
});
```

**Step 2: Write the implementation**

> **AUDIT FIX (M-R5-2):** The feature branch already has `@effect/platform`
> ManagedRuntime in `src/lib/frontend/transport/runtime.ts`. The WS message
> receive path is in `src/lib/frontend/transport/ws-transport.ts` in the
> `onMessage` handler. The validation is added there.

```typescript
// src/lib/frontend/effect-boundary.ts
//
// Lazy-load Schema validation so the main bundle doesn't include the
// full Schema module (~50KB). Only loaded when the first WS message
// arrives and needs validation.
//
// IMPORTANT: This file is imported by the frontend — it must NOT import
// any Node.js-only modules (node:fs, node:net, pino, etc).

let _decoder: ((raw: unknown) => any) | null = null;

const getDecoder = async () => {
  if (_decoder) return _decoder;
  // Dynamic import — webpack/vite will code-split this chunk
  const { decodeWsMessage } = await import("../effect/ws-message-schemas.js");
  const { Effect } = await import("effect");
  _decoder = (raw: unknown) =>
    Effect.runSync(decodeWsMessage(raw).pipe(Effect.orElseSucceed(() => raw)));
  return _decoder;
};

// Use in WS message handler:
export const validateIncomingMessage = async (raw: unknown) => {
  const decode = await getDecoder();
  return decode(raw);
};

// ─── Integration with existing WS transport ──────────────────────────────
// The executing agent should modify the onMessage handler in
// src/lib/frontend/transport/ws-transport.ts:
//
// BEFORE:
//   socket.onmessage = (event) => {
//     const msg = JSON.parse(event.data);
//     handleMessage(msg);
//   };
//
// AFTER:
//   import { validateIncomingMessage } from "../effect-boundary.js";
//   socket.onmessage = async (event) => {
//     const raw = JSON.parse(event.data);
//     const msg = await validateIncomingMessage(raw);
//     handleMessage(msg);
//   };
//
// The lazy import ensures Schema is only loaded after first message,
// and validation failure passes the raw message through (graceful degradation).
```

**Step 3:** Verify: `pnpm build` — check that the Schema chunk is code-split (not inlined into main bundle). Look for a separate chunk containing `@effect/schema` in the build output.

Commit: `feat(effect): add frontend Effect boundary with lazy Schema validation`

---

## Task 37: Final verification — complete Effect.ts adoption

**Step 1:** Run all tests: `pnpm test && pnpm build && pnpm typecheck`

**Step 2:** Track F-specific verification:

```bash
# No raw fetch() in Effect modules
grep -r "fetch(" src/lib/effect/ --include="*.ts" | wc -l
# Expected: 0

# No bridge/adapter files
ls src/lib/effect/bridges/ 2>/dev/null
# Expected: directory does not exist

# No raw child_process.spawn
grep -r "from.*node:child_process\|spawn(" src/lib/effect/ --include="*.ts" | wc -l
# Expected: 0

# No raw http.createServer
grep -r "createServer" src/lib/effect/ --include="*.ts" | wc -l
# Expected: 0

# No node:sqlite in persistence modules
grep -r "from.*node:sqlite\|DatabaseSync" src/lib/persistence/ --include="*.ts" | wc -l
# Expected: 0

# No catchAll in service internals (allowed only in daemon-main, ipc-dispatch, daemon-config-persistence)
grep -r "Effect.catchAll" src/lib/effect/ --include="*.ts" | grep -v "daemon-main\|ipc-dispatch\|daemon-config-persistence" | wc -l
# Expected: 0 or minimal
```

**Step 3:** Smoke test: `pnpm dev` — verify daemon starts, HTTP /health responds, WS connects.

**Step 4:** Run E2E tests: `pnpm test:e2e`

**Step 5:** Delete checkpoint branches:
```bash
git branch -d checkpoint/pre-consumer-migration 2>/dev/null
git branch -d checkpoint/pre-persistence-migration 2>/dev/null
git branch -d checkpoint/pre-daemon-dissolution 2>/dev/null
```

This is **merge milestone M4**.

Commit: `chore: verify complete Effect.ts adoption — no imperative patterns, no bridges, no wrappers`
