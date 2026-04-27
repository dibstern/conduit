# Phase 5b: Production Wiring — Connect Effect Layers to Real Traffic

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

> **Prerequisites:** Phase 5 complete (M4 merged). Read [conventions.md](conventions.md).
> **Dependency:** All Phase 5 modules in place (HttpServerLive, PinoLoggerLive, ws-handler-service, ws-message-schemas, opencode-response-schemas, effect-boundary).
> **Merge milestone:** M4b — production wiring complete.

**Goal:** Connect Phase 5's Effect layers to actual traffic. Move all HTTP routes into the Effect router, replace the imperative HTTP/WS stack in `daemon-main.ts`, wire WS transport through Effect, integrate frontend validation, and delete the old imperative modules (`server.ts`, `ws-handler.ts`, `http-router.ts`).

**Architecture:** Phase 5 created Effect replacements that sit idle. This phase wires them in by: (1) completing the Effect HTTP router with auth, static files, and project routes, (2) replacing the daemon's `RequestRouter` + `startHttpServer` with Effect router + `NodeHttpServer.makeHandler`, (3) wrapping the `ws` library in an Effect Layer so relays use `ws-handler-service` for state, (4) integrating frontend Schema validation into the WS message stream.

> **IMPORTANT: Tasks 38-41 are an ATOMIC merge unit.** They replace the entire HTTP request path — auth middleware, static files, router completion, and daemon wiring. A partial merge leaves routes unreachable. All four must pass together. Run `pnpm test && pnpm build && pnpm dev` after Task 41.

---

## Task 38: Auth middleware as Effect HTTP middleware

**Files:**
- Create: `src/lib/effect/auth-middleware.ts`
- Modify: `src/lib/effect/services.ts` (add `AuthManagerTag`)
- Test: `test/unit/server/auth-middleware.test.ts`

**Context:** The existing `AuthManager` class (`src/lib/auth.ts`, 231 lines) handles PIN authentication with rate limiting, cookie management, and lockout. It's used by `RequestRouter.checkAuth()` to gate routes. This task wraps AuthManager as an Effect service and creates HTTP middleware for the Effect router.

**Step 1: Write the failing test**

```typescript
// test/unit/server/auth-middleware.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  AuthManagerTag,
  makeAuthManagerLive,
  withAuthGate,
  authRoute,
  authStatusRoute,
} from "../../../src/lib/effect/auth-middleware.js";
import { AuthManager } from "../../../src/lib/auth.js";

describe("Auth middleware", () => {
  const makeTestAuth = (pin?: string) => {
    const auth = new AuthManager();
    if (pin) auth.setPin(pin);
    return Layer.succeed(AuthManagerTag, auth);
  };

  describe("withAuthGate", () => {
    it.effect("passes through when no PIN is set", () =>
      Effect.gen(function* () {
        const inner = HttpServerResponse.json({ ok: true });
        const guarded = withAuthGate(inner);
        // With no PIN, should pass through to inner handler
        const auth = yield* AuthManagerTag;
        expect(auth.hasPin()).toBe(false);
      }).pipe(Effect.provide(makeTestAuth()))
    );

    it.effect("returns 401 for API routes without valid cookie", () =>
      Effect.gen(function* () {
        const auth = yield* AuthManagerTag;
        expect(auth.hasPin()).toBe(true);
        // Middleware should reject unauthenticated API requests
      }).pipe(Effect.provide(makeTestAuth("1234")))
    );
  });

  describe("authRoute (POST /auth)", () => {
    it.effect("returns cookie on valid PIN", () =>
      Effect.gen(function* () {
        const auth = yield* AuthManagerTag;
        const result = auth.authenticate("1234", "127.0.0.1");
        expect(result.ok).toBe(true);
        expect(result.cookie).toBeDefined();
      }).pipe(Effect.provide(makeTestAuth("1234")))
    );

    it.effect("returns 401 on wrong PIN", () =>
      Effect.gen(function* () {
        const auth = yield* AuthManagerTag;
        const result = auth.authenticate("9999", "127.0.0.1");
        expect(result.ok).toBe(false);
      }).pipe(Effect.provide(makeTestAuth("1234")))
    );

    it.effect("returns 429 on lockout", () =>
      Effect.gen(function* () {
        const auth = yield* AuthManagerTag;
        // Exhaust attempts
        for (let i = 0; i < 5; i++) {
          auth.authenticate("wrong", "1.2.3.4");
        }
        const result = auth.authenticate("wrong", "1.2.3.4");
        expect(result.locked).toBe(true);
      }).pipe(Effect.provide(makeTestAuth("1234")))
    );
  });
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/auth-middleware.ts
import { Context, Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import type { AuthManager } from "../auth.js";

// ─── AuthManager service tag ─────────────────────────────────────────────────

export class AuthManagerTag extends Context.Tag("AuthManager")<
  AuthManagerTag,
  AuthManager
>() {}

export const makeAuthManagerLive = (auth: AuthManager): Layer.Layer<AuthManagerTag> =>
  Layer.succeed(AuthManagerTag, auth);

// ─── Cookie parsing helper ───────────────────────────────────────────────────

const parseCookies = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
};

// ─── Client IP extraction ────────────────────────────────────────────────────

const getClientIp = (req: HttpServerRequest.HttpServerRequest): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
};

// ─── Auth gate middleware ────────────────────────────────────────────────────
// Wraps routes that require authentication when a PIN is set.
// Checks: relay_session cookie → X-Relay-Pin header → reject.
//
// Exempt paths (health, setup, themes, etc.) are NOT wrapped by this
// middleware — they are registered outside the auth gate in the router.

export const withAuthGate = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | AuthManagerTag | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const auth = yield* AuthManagerTag;
    if (!auth.hasPin()) return yield* app;

    const req = yield* HttpServerRequest.HttpServerRequest;
    const cookies = parseCookies(req.headers["cookie"]);
    const sessionCookie = cookies["relay_session"];

    // Check cookie first
    if (sessionCookie && auth.validateCookie(sessionCookie)) {
      return yield* app;
    }

    // Check X-Relay-Pin header
    const pinHeader = req.headers["x-relay-pin"];
    if (typeof pinHeader === "string") {
      const ip = getClientIp(req);
      const result = auth.authenticate(pinHeader, ip);
      if (result.ok) {
        const response = yield* app;
        // Set cookie on successful header auth
        return response.pipe(
          HttpServerResponse.setHeader(
            "Set-Cookie",
            `relay_session=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
          ),
        );
      }
    }

    // Determine response based on route type
    const url = req.url;
    if (url.startsWith("/api/") || url.includes("/api/")) {
      // API routes → 401 JSON
      return yield* HttpServerResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Browser routes → redirect to /auth
    return yield* HttpServerResponse.empty({
      status: 302,
      headers: { Location: "/auth" },
    });
  });

// ─── POST /auth route ────────────────────────────────────────────────────────

export const authRoute = HttpRouter.post(
  "/auth",
  Effect.gen(function* () {
    const auth = yield* AuthManagerTag;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* req.json;
    const { pin } = body as { pin?: string };

    if (!pin || typeof pin !== "string") {
      return yield* HttpServerResponse.json(
        { ok: false, error: "PIN required" },
        { status: 400 },
      );
    }

    const ip = getClientIp(req);
    const result = auth.authenticate(pin, ip);

    if (result.locked) {
      return yield* HttpServerResponse.json(
        { ok: false, locked: true, retryAfter: result.retryAfter },
        { status: 429 },
      );
    }

    if (!result.ok) {
      return yield* HttpServerResponse.json(
        { ok: false, attemptsLeft: auth.getRemainingAttempts(ip) },
        { status: 401 },
      );
    }

    // AUDIT FIX (A38-2): The executing agent MUST verify HttpServerResponse.setHeader API.
    // It may be a standalone combinator `HttpServerResponse.setHeader(name, value)(response)`
    // or a method on the response. Check @effect/platform exports. Alternative patterns:
    //   response.pipe(HttpServerResponse.setHeader("Set-Cookie", value))
    //   HttpServerResponse.json({ ok: true }, { headers: { "Set-Cookie": value } })
    return yield* HttpServerResponse.json({ ok: true }, {
      headers: {
        "Set-Cookie": `relay_session=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      },
    });
  }),
);

// ─── GET /api/auth/status route ──────────────────────────────────────────────

export const authStatusRoute = HttpRouter.get(
  "/api/auth/status",
  Effect.gen(function* () {
    const auth = yield* AuthManagerTag;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const cookies = parseCookies(req.headers["cookie"]);
    const sessionCookie = cookies["relay_session"];
    const authenticated = sessionCookie
      ? auth.validateCookie(sessionCookie)
      : false;

    return yield* HttpServerResponse.json({
      hasPin: auth.hasPin(),
      authenticated,
    });
  }),
);
```

**Step 3:** Add `AuthManagerTag` to `services.ts` re-exports.

Commit: `feat(effect): add auth middleware for Effect HTTP router`

---

## Task 39: Static file serving via @effect/platform

**Files:**
- Create: `src/lib/effect/static-file-handler.ts`
- Test: `test/unit/server/static-file-handler.test.ts`

**Context:** The existing `static-files.ts` uses raw Node.js `fs` and writes directly to `ServerResponse`. This task creates an Effect-based equivalent using `@effect/platform` FileSystem that returns `HttpServerResponse` objects, suitable for the Effect router. It also moves `MIME_TYPES` here so `http-router.ts` can be deleted later.

**Step 1: Write the failing test**

```typescript
// test/unit/server/static-file-handler.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  serveStaticFile,
  getCacheControl,
  MIME_TYPES,
  StaticDirTag,
} from "../../../src/lib/effect/static-file-handler.js";

describe("Static file handler", () => {
  describe("getCacheControl", () => {
    it("returns immutable for content-hashed files", () => {
      expect(getCacheControl("app.a1b2c3d4.js")).toContain("immutable");
    });

    it("returns must-revalidate for unhashed files", () => {
      expect(getCacheControl("index.html")).toContain("must-revalidate");
    });
  });

  describe("MIME_TYPES", () => {
    it("maps .html to text/html", () => {
      expect(MIME_TYPES[".html"]).toContain("text/html");
    });

    it("maps .js to application/javascript", () => {
      expect(MIME_TYPES[".js"]).toContain("application/javascript");
    });
  });

  describe("serveStaticFile", () => {
    // The executing agent MUST create a temp directory with test fixtures
    // and test: file serving, SPA fallback, directory traversal prevention,
    // MIME type detection, and cache control headers.
    // Use Effect.gen with NodeFileSystem.layer.
  });
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/static-file-handler.ts
import { Context, Effect, Layer } from "effect";
import { FileSystem, Path, HttpServerResponse } from "@effect/platform";

// ─── MIME types (moved from http-router.ts) ──────────────────────────────────

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

// ─── Cache control ───────────────────────────────────────────────────────────

export function getCacheControl(filePath: string): string {
  return filePath.includes(".") && /\.[a-f0-9]{8,}\./.test(filePath)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
}

// ─── Static dir tag ──────────────────────────────────────────────────────────

export class StaticDirTag extends Context.Tag("StaticDir")<
  StaticDirTag,
  string
>() {}

// ─── Static file serving ─────────────────────────────────────────────────────
// Returns HttpServerResponse for use in Effect HTTP router.
// SPA fallback: if file not found, serves index.html.
// Directory traversal prevention via path.resolve check.

export const serveStaticFile = (requestPath: string) =>
  Effect.gen(function* () {
    const staticDir = yield* StaticDirTag;
    const fs = yield* FileSystem.FileSystem;
    const pathModule = yield* Path.Path;

    const filePath = requestPath === "/" || requestPath === ""
      ? "index.html"
      : requestPath.replace(/^\//, "");

    // Prevent directory traversal
    const resolved = pathModule.resolve(staticDir, filePath);
    if (!resolved.startsWith(pathModule.resolve(staticDir))) {
      return yield* HttpServerResponse.text("Forbidden", { status: 403 });
    }

    // Try to serve the requested file
    const exists = yield* fs.exists(resolved);
    if (exists) {
      const info = yield* fs.stat(resolved);
      if (info.type === "Directory") {
        return yield* serveStaticFile(pathModule.join(requestPath, "index.html"));
      }
      const content = yield* fs.readFile(resolved);
      const ext = pathModule.extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      return yield* HttpServerResponse.uint8Array(content, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": getCacheControl(filePath),
        },
      });
    }

    // SPA fallback: try index.html
    if (filePath !== "index.html") {
      const indexPath = pathModule.resolve(staticDir, "index.html");
      const indexExists = yield* fs.exists(indexPath);
      if (indexExists) {
        const content = yield* fs.readFile(indexPath);
        return yield* HttpServerResponse.uint8Array(content, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=0, must-revalidate",
          },
        });
      }
    }

    return yield* HttpServerResponse.text("Not Found", { status: 404 });
  }).pipe(
    // AUDIT FIX (A39-1): Catch PlatformError from fs.exists/stat/readFile
    // (e.g. permission denied). Without this, FS errors bubble as unhandled
    // router errors instead of returning 500.
    Effect.catchTag("SystemError", (err) =>
      HttpServerResponse.text("Internal Server Error", { status: 500 }).pipe(
        Effect.tap(Effect.logWarning("Static file error", err)),
      ),
    ),
    Effect.withSpan("static.serveFile"),
  );
```

> **AUDIT FIX (A39-2):** The executing agent MUST verify `HttpServerResponse.uint8Array`
> exists in the installed `@effect/platform` version. If not, alternatives:
> - `HttpServerResponse.raw(content, { headers: {...} })`
> - `HttpServerResponse.file(resolvedPath)` (serves file directly with auto content-type)
> - Build response manually via `HttpServerResponse.empty().pipe(HttpServerResponse.setBody(...))`
> Check `node_modules/@effect/platform/dist/dts/HttpServerResponse.d.ts` for actual exports.

Commit: `feat(effect): add static file serving via @effect/platform`

---

## Task 40: Complete the Effect HTTP router with all remaining routes

**Files:**
- Modify: `src/lib/server/effect-http-router.ts`
- Test: extend `test/unit/server/effect-http-router.test.ts`

**Context:** The Effect router (284 lines, extended in Phase 5) has: health, info, status, projects, push (subscribe/unsubscribe), themes, setup-info, ca/download, CORS. Missing routes from old `http-router.ts`:

- `POST /auth` — authentication (from Task 38)
- `GET /api/auth/status` — auth status check (from Task 38)
- `DELETE /api/projects/:slug` — project removal
- `GET /p/:slug/*` — project SPA routes + API delegation
- `GET /auth` — login page (static SPA)
- `GET /setup` — setup page (static SPA)
- `GET /` — root redirect (single project → `/p/{slug}/`, else dashboard)
- `GET /*` — static file catch-all with auth gate
- Auth gate middleware wrapping protected routes

**Step 1:** Read the current `effect-http-router.ts` to understand existing routes and provider tags.

**Step 2:** Add new provider tags and routes.

```typescript
// New provider tags needed:
export class RemoveProjectProvider extends Context.Tag("RemoveProjectProvider")<
  RemoveProjectProvider,
  { removeProject: (slug: string) => Effect.Effect<void> }
>() {}

export class ProjectApiDelegateProvider extends Context.Tag("ProjectApiDelegateProvider")<
  ProjectApiDelegateProvider,
  { delegateApiRequest: (slug: string, subPath: string, req: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse> }
>() {}
```

**New routes to add:**

```typescript
// ─── POST /auth ──────────────────────────────────────────────────────────────
// Delegates to authRoute from auth-middleware.ts

// ─── GET /api/auth/status ────────────────────────────────────────────────────
// Delegates to authStatusRoute from auth-middleware.ts

// ─── DELETE /api/projects/:slug ──────────────────────────────────────────────
// AUDIT FIX (A40-1): Verify HttpRouter DELETE method name. It may be:
//   HttpRouter.del(...)  OR  HttpRouter.delete(...)  OR  HttpRouter.route("DELETE")(...)
// Check: node_modules/@effect/platform/dist/dts/HttpRouter.d.ts
const deleteProjectRoute = HttpRouter.del("/api/projects/:slug",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const slug = params["slug"];
    if (!slug) {
      return yield* HttpServerResponse.json({ error: "Missing slug" }, { status: 400 });
    }
    const provider = yield* Effect.serviceOption(RemoveProjectProvider);
    if (Option.isNone(provider)) {
      return yield* HttpServerResponse.json({ error: "Not implemented" }, { status: 501 });
    }
    yield* provider.value.removeProject(slug);
    return yield* HttpServerResponse.json({ ok: true });
  })
);

// ─── GET /p/:slug/* ──────────────────────────────────────────────────────────
// Project routes: /p/:slug/api/* delegates to project API handler.
// All other /p/:slug/* paths serve the SPA (index.html).
const projectRoute = HttpRouter.get("/p/:slug/*",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const slug = params["slug"];
    const req = yield* HttpServerRequest.HttpServerRequest;
    const subPath = req.url.replace(`/p/${slug}/`, "");

    // /p/:slug/api/* → delegate to project handler
    if (subPath.startsWith("api/")) {
      const delegate = yield* Effect.serviceOption(ProjectApiDelegateProvider);
      if (Option.isSome(delegate)) {
        return yield* delegate.value.delegateApiRequest(slug, subPath, req);
      }
    }

    // All other project routes → serve SPA
    return yield* serveStaticFile("/index.html");
  })
);

// ─── GET /auth, /setup ───────────────────────────────────────────────────────
// Serve SPA for auth/setup pages (no auth gate — these ARE the login pages)
const authPageRoute = HttpRouter.get("/auth", serveStaticFile("/index.html"));
const setupPageRoute = HttpRouter.get("/setup", serveStaticFile("/index.html"));

// ─── GET / ───────────────────────────────────────────────────────────────────
// Root: if exactly one project, redirect to /p/{slug}/. Else serve dashboard.
const rootRoute = HttpRouter.get("/",
  Effect.gen(function* () {
    const provider = yield* ProjectsProvider;
    const projects = provider.getProjects();
    if (projects.length === 1 && projects[0]) {
      return yield* HttpServerResponse.empty({
        status: 302,
        headers: { Location: `/p/${projects[0].slug}/` },
      });
    }
    return yield* serveStaticFile("/index.html");
  })
);

// ─── Static catch-all ────────────────────────────────────────────────────────
// Wrapped in auth gate for protected static assets.
const staticCatchAll = HttpRouter.get("/*",
  withAuthGate(
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return yield* serveStaticFile(req.url);
    })
  )
);
```

**Step 3:** Compose into full router with auth gate wrapping protected routes.

The router composition must order routes carefully:
1. Unauthenticated routes first (health, info, auth, setup, push, ca, themes, setup-info)
2. Auth status (needs AuthManagerTag but no gate)
3. Auth-gated routes (projects DELETE, project routes, static catch-all)

> **AUDIT FIX (A40-2): Route ordering is CRITICAL.** The catch-all `GET /*`
> (`staticCatchAll`) will shadow `GET /p/:slug/*` (`projectRoute`) if registered
> first. In Effect router, more specific routes MUST be registered before less
> specific ones. The composition must be:
> ```
> projectRoute,        // GET /p/:slug/*  (specific)
> rootRoute,           // GET /           (exact)
> staticCatchAll,      // GET /*          (catch-all, LAST)
> ```
> The executing agent must verify that HttpRouter respects registration order
> for overlapping patterns. If it uses longest-match instead, ordering is less
> critical — but verify before relying on it.

**Step 4:** Update tests to cover new routes.

Commit: `feat(effect): complete Effect HTTP router with auth, static, and project routes`

---

## Task 41: Replace daemon HTTP stack with Effect router

> **AUDIT NOTE:** This is the highest-risk task. It replaces the HTTP request path that serves all traffic. Test thoroughly.

**Files:**
- Modify: `src/lib/effect/daemon-main.ts` (`startDaemonProcess`)
- Modify: `src/lib/effect/daemon-layers.ts` (add auth + static layers)
- Delete: `src/lib/server/server.ts`
- Delete: `src/lib/server/http-router.ts`
- Modify: `src/lib/server/static-files.ts` (update MIME_TYPES import)
- Test: `test/unit/daemon/daemon-http-integration.test.ts`

**Context:** `startDaemonProcess` currently:
1. Creates `new RequestRouter(...)` with auth, staticDir, projects, etc. (lines 1076-1115)
2. Calls `startHttpServer(ctx)` from `daemon-lifecycle.ts` (line 1117)
3. The HTTP server handler calls `router.handleRequest(req, res)`

After this task:
1. The Effect router serves ALL HTTP routes
2. `NodeHttpServer.makeHandler(effectRouter)` converts it to a Node request handler
3. The daemon still uses `daemon-lifecycle.ts` for TLS peek/redirect (keep this)
4. `RequestRouter` and `RelayServer` are deleted

**Step 1: Write integration test**

```typescript
// test/unit/daemon/daemon-http-integration.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
// Test that the full Effect router serves health, auth, projects, static files
```

**Step 2: Modify daemon-main.ts**

Replace the RequestRouter creation block (lines 1076-1115) with Effect router provider wiring:

```typescript
// BEFORE (lines 1076-1115):
// router = new RequestRouter({ auth, staticDir, getProjects, ... });

// AFTER:
import { effectRouterWithCors } from "../server/effect-http-router.js";
import { AuthManagerTag } from "./auth-middleware.js";
import { StaticDirTag } from "./static-file-handler.js";
import { NodeHttpServer } from "@effect/platform-node";

// Create the Effect-based request handler
const routerLayer = Layer.mergeAll(
  Layer.succeed(AuthManagerTag, auth),
  Layer.succeed(StaticDirTag, staticDir),
  Layer.succeed(ProjectsProvider, {
    getProjects: () => registry.getProjects().map(toRouterProject),
  }),
  // ... other provider layers from daemon context
);
const handler = NodeHttpServer.makeHandler(effectRouterWithCors, routerLayer);
```

> **AUDIT FIX (A41-1):** The executing agent MUST verify `NodeHttpServer.makeHandler`
> signature against installed `@effect/platform-node`. The actual API may be:
> - `NodeHttpServer.makeHandler(httpApp)` → `(req, res) => void` (no Layer param)
> - `NodeHttpServer.makeHandler(httpApp, Layer)` → `(req, res) => void`
> - Or `HttpApp.toWebHandler(httpApp)` from `@effect/platform`
> Check `node_modules/@effect/platform-node/dist/dts/NodeHttpServer.d.ts`.
> If the handler doesn't accept a Layer param, provide context via
> `httpApp.pipe(Effect.provide(routerLayer))` before passing to makeHandler.

Replace the `startHttpServer(ctx)` call to use the Effect handler:

```typescript
// The daemon-lifecycle.ts startHttpServer creates the Node server
// but now uses the Effect handler instead of router.handleRequest
ctx.requestHandler = handler;
```

**Step 3:** Update `daemon-lifecycle.ts` `startHttpServer` to accept an Effect handler.

The TLS peek server in `daemon-lifecycle.ts` needs the request handler. Currently it uses `router.handleRequest`. Change to accept a generic `(req, res) => void` handler.

**Step 4:** Delete `src/lib/server/server.ts`.

> **AUDIT FIX (A41-2):** `relay-stack.ts` `createRelayStack()` (lines 824-831)
> creates `RelayServer` for standalone (non-daemon) mode. Deleting `server.ts`
> breaks this path. The executing agent MUST:
> 1. Grep for `new RelayServer` and all `RelayServer` imports
> 2. For standalone mode in relay-stack.ts: replace with inline `createServer`
>    + the Effect router handler (same handler the daemon uses). The standalone
>    path needs: `const server = createServer(handler); server.listen(port);`
> 3. If standalone mode is unused in practice (only daemon mode matters),
>    document the deprecation and remove the standalone code path entirely.
>    Grep for `noServer: false` or `noServer` === `undefined` to verify.

**Step 5:** Delete `src/lib/server/http-router.ts`.

Update `static-files.ts` to import `MIME_TYPES` from `static-file-handler.ts` instead.

**Step 6:** Update all tests that imported from deleted files.

Commit: `refactor(effect): replace daemon HTTP stack with Effect router`

---

## Task 42: WebSocket transport Layer — ws library in Effect

**Files:**
- Create: `src/lib/effect/ws-transport-layer.ts`
- Test: `test/unit/server/ws-transport-layer.test.ts`

**Context:** The old `ws-handler.ts` (483 lines) does two things:
1. **Transport:** ws.WebSocket.Server creation, upgrade protocol, ping/pong heartbeat, compression config
2. **State:** Client tracking, bootstrap queue, broadcast, sendTo

Phase 5 Task 32 replaced (2) with `ws-handler-service.ts`. This task replaces (1) with an Effect Layer wrapping the `ws` library.

**Step 1: Write the failing test**

```typescript
// test/unit/server/ws-transport-layer.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, HashMap } from "effect";
import {
  WsTransportTag,
  makeWsTransportLive,
} from "../../../src/lib/effect/ws-transport-layer.js";

describe("WS Transport Layer", () => {
  it.effect("creates WebSocket.Server in noServer mode", () =>
    Effect.gen(function* () {
      const transport = yield* WsTransportTag;
      expect(transport.wss).toBeDefined();
    }).pipe(Effect.provide(makeWsTransportLive({ noServer: true })))
  );

  it.effect("handleUpgrade delegates to wss", () =>
    Effect.gen(function* () {
      const transport = yield* WsTransportTag;
      expect(transport.handleUpgrade).toBeTypeOf("function");
    }).pipe(Effect.provide(makeWsTransportLive({ noServer: true })))
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/ws-transport-layer.ts
import { Context, Effect, Layer, Scope } from "effect";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// ─── WS Transport service ────────────────────────────────────────────────────
// Wraps the ws library WebSocket.Server. Provides upgrade handling
// and exposes the server instance for relay-level WS management.
//
// State management (client tracking, bootstrap queue, broadcast)
// is handled by ws-handler-service.ts — this layer only handles
// the ws library transport concerns.

export interface WsTransport {
  /** The underlying ws WebSocket.Server instance */
  readonly wss: import("ws").WebSocketServer;
  /** Upgrade an HTTP connection to WebSocket */
  readonly handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => Effect.Effect<import("ws").WebSocket>;
}

export class WsTransportTag extends Context.Tag("WsTransport")<
  WsTransportTag,
  WsTransport
>() {}

interface WsTransportConfig {
  noServer: boolean;
  perMessageDeflate?: boolean | object;
  maxPayload?: number;
}

// Scoped layer: creates WebSocket.Server, closes on scope finalization
export const makeWsTransportLive = (
  config: WsTransportConfig,
): Layer.Layer<WsTransportTag> =>
  Layer.scoped(
    WsTransportTag,
    Effect.gen(function* () {
      // Dynamic import to avoid pulling ws into frontend bundles
      const { WebSocketServer } = yield* Effect.promise(() => import("ws"));

      const wss = new WebSocketServer({
        noServer: config.noServer,
        maxPayload: config.maxPayload ?? 50 * 1024 * 1024, // 50MB default
        ...(config.perMessageDeflate !== undefined
          ? { perMessageDeflate: config.perMessageDeflate }
          : {
              perMessageDeflate: {
                zlibDeflateOptions: { level: 1 },
                serverMaxWindowBits: 10,
                concurrencyLimit: 2,
              },
            }),
      });

      // Register finalizer to close the server on scope exit
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          wss.close();
        }),
      );

      const handleUpgrade = (
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
      ): Effect.Effect<import("ws").WebSocket> =>
        Effect.async<import("ws").WebSocket, Error>((resume) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
            resume(Effect.succeed(ws));
          });
          socket.on("error", (err) => {
            resume(Effect.fail(err));
          });
        });

      return { wss, handleUpgrade };
    }),
  );
```

**Step 3:** Add heartbeat fiber helper:

```typescript
// Heartbeat: pings all connected clients on a schedule.
// Uses ws-handler-service to enumerate clients.
import { WsHandlerStateTag } from "./ws-handler-service.js";
import { Schedule } from "effect";

export const makeHeartbeatFiber = (intervalMs = 30_000) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    const clients = yield* Ref.get(ref);
    // Ping each connected client
    yield* Effect.forEach(
      HashMap.values(clients),
      (client) =>
        Effect.try({
          try: () => {
            if (client.ws.readyState === 1) {
              (client.ws as any).ping?.();
            }
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.repeat(Schedule.spaced(`${intervalMs} millis`)),
    Effect.annotateLogs("component", "ws-heartbeat"),
  );
```

Commit: `feat(effect): add WebSocket transport Layer wrapping ws library`

---

## Task 43: Wire relay to Effect WS transport, delete ws-handler.ts

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (replace `new WebSocketHandler(...)`)
- Modify: `src/lib/relay/monitoring-wiring.ts` (update type import)
- Modify: `src/lib/relay/poller-wiring.ts` (update type import)
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` (update type import)
- Modify: `src/lib/relay/timer-wiring.ts` (update type import)
- Delete: `src/lib/server/ws-handler.ts`
- Test: update relevant relay tests

**Context:** `relay-stack.ts` line 422-431 creates `new WebSocketHandler(server, { registry, verifyClient })`. The wiring files import `WebSocketHandler` as a type only. The executing agent must:

1. Replace the `new WebSocketHandler(...)` call with creation of `WsTransportTag` layer + `WsHandlerStateTag` layer
2. Create a bridge that implements the `WebSocketHandlerShape` interface using the Effect services
3. Wire the `ws.on("connection")` event to register clients in `ws-handler-service`
4. Wire `ws.on("message")` to the existing `parseIncomingMessage` + `routeMessage` pure functions from `ws-router.ts`
5. Wire `ws.on("close")` and `ws.on("error")` to `removeClient`
6. Update the `ProjectRelay` interface — `wsHandler` property type changes from `WebSocketHandler` to the new bridge

**Key: The wiring files use `WebSocketHandler` type for:**
- `wsHandler.broadcast(message)` → `broadcast` from ws-handler-service
- `wsHandler.sendTo(clientId, message)` → `sendTo` from ws-handler-service
- `wsHandler.broadcastPerSessionEvent(sessionId, message)` → `broadcastPerSessionEvent` from ws-handler-service
- `wsHandler.markClientBootstrapped(clientId)` → `markClientBootstrapped` from ws-handler-service
- `wsHandler.getClientCount()` → `getClientCount` from ws-handler-service
- `wsHandler.setClientSession(clientId, sessionId)` → `bindClientSession` from ws-handler-service

The bridge wraps Effect functions into synchronous calls using `Effect.runSync` on a scoped ManagedRuntime, matching the existing imperative call sites.

**Step 1:** Create the imperative bridge:

```typescript
// In relay-stack.ts: create a bridge object that satisfies WebSocketHandlerShape
// using the Effect ws-handler-service functions + a ManagedRuntime

import { ManagedRuntime, Layer } from "effect";
import {
  makeWsHandlerStateLive,
  addClient, removeClient, broadcast, sendTo,
  bindClientSession, getClientSession, getSessionViewers,
  sendToSession, broadcastPerSessionEvent, markClientBootstrapped,
  getClientCount, getClientIds,
} from "../effect/ws-handler-service.js";
```

**Step 2:** Wire ws connection events:

```typescript
// On new WebSocket connection:
wss.on("connection", (ws, req) => {
  const clientId = generateClientId();
  // Register in Effect state
  runtime.runSync(addClient(clientId, ws));

  ws.on("message", (data) => {
    const msg = parseIncomingMessage(data);
    if (msg) routeMessage(msg, clientId, handlers);
  });

  ws.on("close", () => {
    runtime.runSync(removeClient(clientId));
  });

  ws.on("error", () => {
    runtime.runSync(removeClient(clientId));
  });
});
```

**Step 3:** Delete `src/lib/server/ws-handler.ts`. Update all imports:
- `monitoring-wiring.ts`, `poller-wiring.ts`, `session-lifecycle-wiring.ts`, `timer-wiring.ts` — change `import type { WebSocketHandler }` to import the bridge type
- Delete `test/unit/server/ws-handler.pbt.test.ts` and `test/unit/server/ws-handler-sessions.test.ts` (replaced by `ws-handler-effect.test.ts`)

**Step 4:** Verify: `pnpm test && pnpm check`

Commit: `refactor(effect): wire relay to Effect WS transport, delete ws-handler.ts`

---

## Task 44: WS upgrade handler auth check (MERGED INTO TASK 41)

> **AUDIT FIX (A44-1):** This task was originally standalone, but Task 41 deletes
> `http-router.ts` which removes the `router` variable used by the WS upgrade
> handler (`router?.checkAuth(req)` at daemon-main.ts line 1149). Without this
> fix applied in the same commit as Task 41, the code won't compile between
> Tasks 41 and 44. **The auth check replacement below MUST be applied as part
> of Task 41's changes.**

**Merged into Task 41 Step 2.** When replacing the RequestRouter in daemon-main.ts, also update the WS upgrade handler (lines 1135-1177):

```typescript
// BEFORE:
const authenticated = router?.checkAuth(req);

// AFTER:
// Use AuthManager directly (already available in startDaemonProcess scope).
// Import parseCookies from auth-middleware.ts or define inline.
const cookies = parseCookies(req.headers.cookie ?? "");
const sessionCookie = cookies["relay_session"] ?? "";
const pinHeader = req.headers["x-relay-pin"];
const authenticated = !auth.hasPin() ||
  auth.validateCookie(sessionCookie) ||
  (typeof pinHeader === "string" && auth.authenticate(pinHeader, getClientIp(req)).ok);
```

> **NOTE:** `pinHeader` may be `string | string[] | undefined`. The `typeof`
> check ensures only `string` values reach `auth.authenticate()`.

No separate commit — this is part of Task 41's commit.

---

## Task 45: Frontend validation integration

**Files:**
- Modify: `src/lib/frontend/transport/runtime.ts`
- Test: `test/unit/frontend/runtime-validation.test.ts`

**Context:** Phase 5 Task 36 created `effect-boundary.ts` with `validateIncomingMessage`. The `wsMessageStream` function in `runtime.ts` currently does:
```typescript
const msg = JSON.parse(evt.data) as RelayMessage;
emit(Effect.succeed(Chunk.of(msg)));
```

This task wires in validation so malformed messages are caught at the boundary.

**Step 1: Write the test**

```typescript
// test/unit/frontend/runtime-validation.test.ts
import { describe, it, expect } from "vitest";
import { wsMessageStream } from "../../../src/lib/frontend/transport/runtime.js";

describe("wsMessageStream with validation", () => {
  it("parses valid relay messages", async () => {
    // Create a mock WebSocket that emits a valid message
    // Verify the stream produces the parsed message
  });

  it("skips invalid JSON gracefully", async () => {
    // Create a mock WebSocket that emits invalid JSON
    // Verify the stream skips without erroring
  });

  it("passes through unknown message types", async () => {
    // Create a mock WebSocket that emits { type: "future_type" }
    // Verify the stream passes it through (graceful degradation)
  });
});
```

**Step 2: Modify runtime.ts**

> **AUDIT FIX (U45-1):** User chose synchronous eager import (approach 2) to
> guarantee message ordering. Adds ~50KB to main bundle but eliminates async
> complexity and first-message reordering risk.

```typescript
// At top of runtime.ts, add static imports:
import { RelayMessageSchema } from "../shared-types.js";
import { Schema, Either } from "effect";

// Create decoder once at module load (synchronous, no lazy import)
const decodeRelayMessage = Schema.decodeUnknownEither(RelayMessageSchema);

// In wsMessageStream, change:
// BEFORE:
socket.addEventListener("message", (evt) => {
  try {
    const msg = JSON.parse(evt.data) as RelayMessage;
    emit(Effect.succeed(Chunk.of(msg)));
  } catch {
    // skip bad JSON
  }
});

// AFTER:
socket.addEventListener("message", (evt) => {
  try {
    const raw = JSON.parse(evt.data);
    // Synchronous Schema validation — known types get validated,
    // unknown types pass through unchanged (graceful degradation)
    const result = decodeRelayMessage(raw);
    const msg = (Either.isRight(result) ? result.right : raw) as RelayMessage;
    emit(Effect.succeed(Chunk.of(msg)));
  } catch {
    // skip bad JSON
  }
});
```

> **NOTE:** This adds `effect` and `RelayMessageSchema` to the main frontend
> bundle (~50KB gzipped). The `effect-boundary.ts` lazy-load module from
> Phase 5 Task 36 is still available for consumers that prefer code-splitting,
> but the stream uses the synchronous path for ordering guarantees.

Commit: `feat(effect): integrate Schema validation into frontend WS message stream`

---

## Task 46: Delete old files, cleanup, and final verification

**Files to delete:**
- `src/lib/server/static-files.ts` (replaced by `static-file-handler.ts`)
- Old test files for deleted modules:
  - `test/unit/server/server.pbt.test.ts`
  - `test/unit/server/push-routes.test.ts` (if it depends on RelayServer)
  - `test/unit/server/http-router.test.ts`
  - `test/unit/server/ws-handler.pbt.test.ts`
  - `test/unit/server/ws-handler-sessions.test.ts`

**Files to verify no stale imports:**

```bash
# No imports of deleted modules
grep -r "from.*server/server" src/ --include="*.ts" | grep -v node_modules
# Expected: 0 (relay-stack standalone mode handled)

grep -r "from.*server/http-router" src/ --include="*.ts" | grep -v node_modules
# Expected: 0 (MIME_TYPES moved to static-file-handler.ts)

grep -r "from.*server/ws-handler" src/ --include="*.ts" | grep -v node_modules
# Expected: 0 (all consumers updated)

grep -r "from.*server/static-files" src/ --include="*.ts" | grep -v node_modules
# Expected: 0 (replaced by static-file-handler.ts)
```

**Verification suite:**

```bash
# 1. All tests pass
pnpm test

# 2. Build succeeds
pnpm build

# 3. Type check passes
pnpm check

# 4. No old module imports remain
grep -r "RequestRouter\|RelayServer\|WebSocketHandler" src/ --include="*.ts" | \
  grep -v "node_modules\|\.test\.\|ws-handler-service\|ws-handler-effect" | wc -l
# Expected: 0

# 5. Effect modules serve traffic (smoke test)
pnpm dev
# Verify: /health responds, WS connects, auth works if PIN set
```

**Commit:** `chore: delete old imperative HTTP/WS modules, verify clean migration`

This is **merge milestone M4b**.

---

## Summary

| Task | What | Deletes | Risk |
|------|------|---------|------|
| 38 | Auth middleware for Effect router | — | Low |
| 39 | Static file serving via @effect/platform | — | Low |
| 40 | Complete Effect router (all routes) | — | Medium |
| 41 | Replace daemon HTTP stack + WS upgrade auth | `server.ts`, `http-router.ts` | **High** |
| 42 | WS transport Layer (ws library in Effect) | — | Medium |
| 43 | Wire relay to Effect WS, delete ws-handler | `ws-handler.ts` | **High** |
| 44 | *(merged into Task 41)* | — | — |
| 45 | Frontend validation (sync eager import) | — | Low |
| 46 | Delete old files + verification | `static-files.ts`, old tests | Medium |

> **Tasks 38-41 are ATOMIC.** They replace the entire HTTP request path (including WS upgrade auth from merged Task 44).
> **Tasks 42-43 are ATOMIC.** They replace the WS transport.
> **Tasks 45-46 are independent** and can be committed separately.
