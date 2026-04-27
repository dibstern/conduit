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

  // AUDIT FIX (R2-38-3): Tests must exercise the actual middleware HTTP flow,
  // not just AuthManager methods. The executing agent MUST create mock
  // HttpServerRequest objects and pass them through withAuthGate to verify:
  //
  // 1. No PIN set → inner handler called (passthrough)
  // 2. PIN set + valid cookie → inner handler called
  // 3. PIN set + valid x-relay-pin header → inner handler called + Set-Cookie
  // 4. PIN set + no auth + API route → 401 JSON response
  // 5. PIN set + no auth + browser route → 302 redirect to /auth
  // 6. PIN set + locked out IP → 429 response
  //
  // Use HttpServerRequest.make or similar to create test requests with
  // specific headers/cookies. Verify response status codes and headers.
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

    // AUDIT FIX (R2-38-1): When no PIN is set, auth is disabled — return
    // authenticated: true to match old RequestRouter behavior. Frontend
    // depends on this to skip login UI when auth is disabled.
    if (!auth.hasPin()) {
      return yield* HttpServerResponse.json({ hasPin: false, authenticated: true });
    }

    const req = yield* HttpServerRequest.HttpServerRequest;
    const cookies = parseCookies(req.headers["cookie"]);
    const sessionCookie = cookies["relay_session"];

    // AUDIT FIX (R2-38-2): Check cookie first, then fall back to
    // x-relay-pin header — matches old checkAuth() behavior so API
    // clients using header auth see authenticated: true.
    //
    // AUDIT FIX (R3-38-1): Do NOT call auth.authenticate() here — it
    // consumes a rate-limit attempt. A status-check endpoint must not
    // decrement attempts. For x-relay-pin header, use auth.validatePin()
    // (non-consuming) if available, or auth.validateCookie() only.
    // The executing agent MUST check AuthManager's API for a non-consuming
    // PIN validation method. If none exists, either:
    //   (a) Add one to AuthManager (e.g., auth.checkPin(pin): boolean)
    //   (b) Only check cookies in the status route (header auth still
    //       works via withAuthGate, just not reflected in status response)
    let authenticated = false;
    if (sessionCookie && auth.validateCookie(sessionCookie)) {
      authenticated = true;
    }

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
    // AUDIT FIX (R3-39-1): Add trailing separator to prevent /foo matching /foobar.
    // Without this, staticDir="/foo" would allow access to "/foobar/evil.txt".
    const resolvedBase = pathModule.resolve(staticDir) + pathModule.sep;
    const resolved = pathModule.resolve(staticDir, filePath);
    if (!resolved.startsWith(resolvedBase) && resolved !== pathModule.resolve(staticDir)) {
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
    const rawSlug = params["slug"];
    if (!rawSlug) {
      return yield* HttpServerResponse.json({ error: "Missing slug" }, { status: 400 });
    }
    // AUDIT FIX (R3-40-1): Decode URI component — old code uses
    // decodeURIComponent(match[1]!). Slugs with special chars need decoding.
    const slug = decodeURIComponent(rawSlug);
    const provider = yield* Effect.serviceOption(RemoveProjectProvider);
    if (Option.isNone(provider)) {
      return yield* HttpServerResponse.json({ error: "Not implemented" }, { status: 501 });
    }
    // AUDIT FIX (R3-40-2): Handle removeProject errors — old code catches
    // and returns 404. Without this, errors bubble as 500.
    const result = yield* provider.value.removeProject(slug).pipe(
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    if (!result) {
      return yield* HttpServerResponse.json({ error: "Project not found" }, { status: 404 });
    }
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

> **AUDIT FIX (R2-40-1):** The executing agent MUST add actual test implementations,
> not just "update tests." At minimum cover:
> - `GET /` root redirect: single project → 302 to `/p/{slug}/`, multiple → serves SPA
> - `DELETE /api/projects/:slug` with valid slug, missing slug, missing provider
> - `GET /p/:slug/api/*` delegation to ProjectApiDelegateProvider
> - `GET /p/:slug/dashboard` serves SPA (non-API project route)
> - `GET /auth` and `GET /setup` serve SPA without auth gate
> - `GET /some-file.js` static catch-all goes through auth gate
> - Auth-gated route returns 401/302 when unauthenticated

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
// AUDIT FIX (R2-41-1): The executing agent MUST write actual integration tests,
// not just imports. At minimum:
// 1. Create a test Layer with all provider tags satisfied (AuthManagerTag,
//    StaticDirTag, ProjectsProvider, etc.) using test doubles
// 2. Use NodeHttpServer.makeHandler + HttpClient to make real HTTP requests
// 3. Test: GET /health returns 200, GET /api/auth/status returns correct JSON,
//    POST /auth with valid PIN returns cookie, static file serving works,
//    auth gate blocks unauthenticated requests
// 4. Test error paths: invalid JSON body, missing routes → 404
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
```

> **AUDIT FIX (R3-41-1):** The plan used `ctx.requestHandler = handler` but
> the actual daemon-lifecycle context uses `ctx.router` with a `handleRequest`
> method, not a generic handler field. The executing agent MUST:
> 1. Read `daemon-lifecycle.ts` to find how the request handler is consumed
> 2. Find the exact field/method name (likely `ctx.router.handleRequest`)
> 3. Either wrap the Effect handler in an adapter that matches the expected
>    interface, OR modify daemon-lifecycle.ts to accept a generic
>    `(req: IncomingMessage, res: ServerResponse) => void` handler.
> Do NOT use `ctx.requestHandler = handler` — verify the actual API.

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
        // AUDIT FIX (R2-42-4): Guard against double-resume. Socket error
        // can fire after successful upgrade. Remove error listener on success,
        // or use a `resumed` boolean to ignore late errors.
        Effect.async<import("ws").WebSocket, Error>((resume) => {
          let resumed = false;
          const onError = (err: Error) => {
            if (!resumed) {
              resumed = true;
              resume(Effect.fail(err));
            }
          };
          socket.on("error", onError);
          wss.handleUpgrade(req, socket, head, (ws) => {
            resumed = true;
            socket.removeListener("error", onError);
            wss.emit("connection", ws, req);
            resume(Effect.succeed(ws));
          });
        });

      return { wss, handleUpgrade };
    }),
  );
```

**Step 3:** Add heartbeat fiber helper:

> **AUDIT FIX (R2-42-1):** The old `ws-handler.ts` heartbeat has a full
> ping/pong alive-tracking protocol: marks `isAlive = false` → sends ping →
> on next tick terminates connections that didn't respond with pong. Without
> this, dead connections (half-open TCP) are never detected, causing memory
> leaks and stale client counts. The heartbeat below MUST replicate this
> protocol, not just ping.
>
> **AUDIT FIX (R2-42-2):** `client.ws` is the WsConn type from
> ws-handler-service. The executing agent MUST verify whether WsConn exposes
> the underlying `ws.WebSocket` for calling `ping()` and registering `pong`
> listeners. If WsConn wraps it, either extend the interface or access the
> raw socket via a typed accessor (not `as any`).
>
> **AUDIT FIX (R2-42-3):** `Schedule.spaced` takes a number (milliseconds)
> or `Duration.millis(n)`, NOT a template literal string. Use
> `Schedule.spaced(intervalMs)`.

```typescript
// Heartbeat: pings all connected clients on a schedule.
// Uses ws-handler-service to enumerate clients.
// Implements full alive-tracking protocol matching old ws-handler.ts behavior.
import { WsHandlerStateTag, removeClient } from "./ws-handler-service.js";
import { Schedule } from "effect";

export const makeHeartbeatFiber = (intervalMs = 30_000) =>
  Effect.gen(function* () {
    const ref = yield* WsHandlerStateTag;
    const clients = yield* Ref.get(ref);
    // For each connected client:
    // 1. If isAlive is false from last tick → connection is dead, terminate it
    // 2. Set isAlive = false
    // 3. Send ping (pong handler sets isAlive = true)
    yield* Effect.forEach(
      HashMap.entries(clients),
      ([clientId, client]) =>
        Effect.gen(function* () {
          // The executing agent must implement isAlive tracking:
          // - Add isAlive: boolean to client state in ws-handler-service
          // - Register ws.on("pong") handler to set isAlive = true on connection
          // - Here: check isAlive, if false → terminate, else mark false + ping
          if (client.ws.readyState === 1) {
            // Access underlying ws.WebSocket for ping() — see R2-42-2
            // (client.ws as import("ws").WebSocket).ping();
          }
        }).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.repeat(Schedule.spaced(intervalMs)),
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

> **AUDIT FIX (R3-43-1):** The old `WebSocketHandler` also has
> `getClientsForSession(sessionId)` which is used by wiring files but NOT
> listed in the mapping above. The executing agent MUST:
> 1. Grep for ALL `wsHandler.` method calls across wiring files
> 2. Verify every method is bridged — the list above may be incomplete
> 3. Check ws-handler-service.ts exports for matching functions
> 4. If a method has no ws-handler-service equivalent, add one or inline it

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

> **AUDIT FIX (R3-46-1):** Additional files import `WebSocketHandler` from
> `ws-handler.ts` but are NOT listed above:
> - `test/unit/relay/phase-0b-ordering.test.ts`
> - `test/unit/relay/phase-0b-session-list-first.test.ts`
> - `src/lib/relay/handler-deps-wiring.ts` (type import)
> The executing agent MUST grep for ALL `WebSocketHandler` imports and
> update or delete every consumer — not just the four wiring files listed.

**Step 4:** Write bridge-level tests.

> **AUDIT FIX (R2-43-1):** The executing agent MUST write tests for the bridge
> pattern, not just "update relevant relay tests." At minimum:
> - Create WsHandlerState layer with test doubles
> - Register mock WS clients via addClient
> - Verify broadcast reaches all clients
> - Verify sendTo targets correct client only
> - Verify removeClient cleans up state
> - Verify concurrent ws events (rapid connect/disconnect) don't corrupt state
> - Test the ManagedRuntime lifecycle: creation, usage, disposal

**Step 5:** Verify: `pnpm test && pnpm check`

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

> **AUDIT FIX (U45-1 revised):** User chose async lazy-load with pre-loading
> during the app loading screen. The ~50KB Schema module stays code-split out
> of the main bundle. The app pre-loads the decoder before opening the WS
> connection, so the decoder is always cached and synchronous by the time
> messages arrive. No reordering risk. No bundle bloat.
>
> **AUDIT FIX (R2-45-ASK-1):** `effect-boundary.ts` is kept and used — it is
> the decoder source. Not dead code.

**Files:**
- Modify: `src/lib/frontend/effect-boundary.ts` (add `preloadDecoder` + sync `decodeMessage` exports)
- Modify: `src/lib/frontend/transport/runtime.ts` (pre-load decoder during init, use in message handler)
- Test: `test/unit/frontend/runtime-validation.test.ts`

**Context:** Phase 5 Task 36 created `effect-boundary.ts` with `validateIncomingMessage` (async lazy-load decoder). This task:
1. Adds a `preloadDecoder()` export so the app can eagerly load during loading screen
2. Adds a synchronous `decodeMessage(raw)` export for use after preload
3. Wires the message handler to use the pre-loaded synchronous decoder
4. Keeps ~50KB out of the main bundle via code-splitting

**Step 1: Write the test**

```typescript
// test/unit/frontend/runtime-validation.test.ts
import { describe, it, expect } from "vitest";

describe("effect-boundary preload + decode", () => {
  it("preloadDecoder resolves and caches decoder", async () => {
    const { preloadDecoder, decodeMessage } = await import(
      "../../../src/lib/frontend/effect-boundary.js"
    );
    await preloadDecoder();
    // After preload, decodeMessage should work synchronously
    const result = decodeMessage({ type: "get_sessions" });
    expect(result.type).toBe("get_sessions");
  });

  it("decodeMessage passes through unknown types (graceful degradation)", async () => {
    const { preloadDecoder, decodeMessage } = await import(
      "../../../src/lib/frontend/effect-boundary.js"
    );
    await preloadDecoder();
    const raw = { type: "future_unknown_type", data: 123 };
    const result = decodeMessage(raw);
    // Unknown types pass through unchanged for forward compat
    expect(result).toEqual(raw);
  });

  it("decodeMessage throws if called before preload", async () => {
    // The executing agent should test this edge case — verify
    // decodeMessage throws a clear error if preloadDecoder wasn't called
  });
});

describe("wsMessageStream with validation", () => {
  // AUDIT FIX (R2-45-3): The executing agent MUST write real test
  // implementations, not skeleton comments. At minimum:
  // 1. Create a mock WebSocket that emits MessageEvents
  // 2. Pre-load decoder, then consume stream
  // 3. Test: valid message → decoded in stream output
  // 4. Test: invalid JSON → silently skipped, no stream error
  // 5. Test: unknown type → passes through unchanged
  // 6. Test: malformed known type (e.g. { type: "delta" } missing sessionId)
  //    → verify behavior (pass through or skip)
});
```

**Step 2: Modify effect-boundary.ts**

Add synchronous `decodeMessage` and `preloadDecoder` exports alongside existing `validateIncomingMessage`:

```typescript
// src/lib/frontend/effect-boundary.ts
// ... existing lazy-load code stays ...

// ─── Pre-load API for app init ──────────────────────────────────────────────
// Call preloadDecoder() during loading screen. After it resolves, decodeMessage()
// works synchronously — no async, no reordering.

// AUDIT FIX (R3-45-1): If preloadDecoder fails (network error loading chunk),
// _decoder stays null and decodeMessage throws on every message. The outer
// try/catch in the message handler silently drops ALL messages. Add error
// handling: on failure, set a fallback decoder that passes raw data through
// (same as "unknown type" graceful degradation). Log warning but don't crash.
export const preloadDecoder = async (): Promise<void> => {
  try {
    await getDecoder(); // populates _decoder cache
  } catch (err) {
    console.warn("[effect-boundary] Failed to load Schema decoder, falling back to passthrough:", err);
    _decoder = (raw: unknown) => raw; // graceful degradation
  }
};

export const decodeMessage = (raw: unknown): unknown => {
  if (!_decoder) {
    // Should not happen if preloadDecoder was awaited, but handle gracefully
    return raw;
  }
  return _decoder(raw);
};
```

**Step 3: Modify runtime.ts**

> **AUDIT FIX (R2-45-1):** Import path from runtime.ts must be
> `../../effect-boundary.js` (not `../shared-types.js` — wrong depth).

```typescript
// At top of runtime.ts:
import { preloadDecoder, decodeMessage } from "../../effect-boundary.js";

// During app/transport init (before WS connection opens):
// The executing agent must find the appropriate init point — likely where
// the loading screen is shown — and add:
await preloadDecoder();

// In wsMessageStream message handler, change:
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
    // Synchronous — decoder was pre-loaded during loading screen.
    // Known types get validated; unknown types pass through for forward compat.
    const msg = decodeMessage(raw) as RelayMessage;
    emit(Effect.succeed(Chunk.of(msg)));
  } catch {
    // skip bad JSON
  }
});
```

> **NOTE:** The `as RelayMessage` cast is on `decodeMessage(raw)` which returns
> either a validated known type or the raw unknown type passed through. The cast
> is necessary because the stream expects `RelayMessage`, but the executing agent
> should be aware this is a deliberate type widening for forward compatibility —
> unknown message types will have the raw shape, not the schema-validated shape.

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
| 45 | Frontend validation (async pre-load during loading screen) | — | Low |
| 46 | Delete old files + verification | `static-files.ts`, old tests | Medium |

> **Tasks 38-41 are ATOMIC.** They replace the entire HTTP request path (including WS upgrade auth from merged Task 44).
> **Tasks 42-43 are ATOMIC.** They replace the WS transport.
> **Tasks 45-46 are independent** and can be committed separately.
