# Phase 5b: Production Wiring — Connect Effect Layers to Real Traffic

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

> **Prerequisites:** Phase 5 complete (M4 merged). Read [conventions.md](conventions.md).
> **Dependency:** All Phase 5 modules in place (HttpServerLive, PinoLoggerLive, ws-handler-service, ws-message-schemas, opencode-response-schemas, effect-boundary).
> **Merge milestone:** M4b — production wiring complete.

**Goal:** Connect Phase 5's Effect layers to actual traffic. Move all HTTP routes into the Effect router, replace the imperative HTTP/WS stack in `src/lib/daemon/daemon.ts`, wire WS transport through Effect, integrate frontend validation, and delete the old imperative modules (`server.ts`, `ws-handler.ts`, `http-router.ts`).

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
import { expect } from "vitest";
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

// EFFECT-TS FIX (EF-38-4): Tests MUST exercise the actual middleware HTTP
// flow, not just call AuthManager methods directly. The old tests verified
// AuthManager (which is unchanged) instead of withAuthGate (which is new).
//
// Helper to create a mock HttpServerRequest for testing middleware.
// The executing agent MUST verify the HttpServerRequest construction API
// in @effect/platform — it may be HttpServerRequest.make(),
// HttpServerRequest.fromWeb(), or a class constructor. Check:
//   node_modules/@effect/platform/dist/dts/HttpServerRequest.d.ts
// The pattern below uses Layer.succeed to provide a mock request.
const makeTestRequest = (url: string, headers: Record<string, string> = {}) =>
  Layer.succeed(HttpServerRequest.HttpServerRequest, {
    url,
    method: "GET",
    headers,
    // The executing agent must fill in remaining required fields from
    // the HttpServerRequest interface (e.g., json, text, urlParamsBody).
    // For withAuthGate tests, only url, method, and headers are accessed.
  } as unknown as HttpServerRequest.HttpServerRequest);

describe("Auth middleware", () => {
  const makeTestAuth = (pin?: string) => {
    const auth = new AuthManager();
    if (pin) auth.setPin(pin);
    return { auth, layer: Layer.succeed(AuthManagerTag, auth) };
  };

  // ─── withAuthGate: tests go through the actual middleware ─────────────
  describe("withAuthGate", () => {
    const innerOk = HttpServerResponse.json({ ok: true });

    it.effect("passes through when no PIN is set", () =>
      Effect.gen(function* () {
        const response = yield* withAuthGate(innerOk);
        expect(response.status).toBe(200);
      }).pipe(
        Effect.provide(Layer.merge(
          makeTestAuth().layer,
          makeTestRequest("/api/something"),
        )),
      )
    );

    it.effect("passes through with valid session cookie", () =>
      Effect.gen(function* () {
        // Get a real cookie from AuthManager
        const auth = yield* AuthManagerTag;
        const result = auth.authenticate("1234", "127.0.0.1");
        expect(result.ok).toBe(true);
        // Now test the middleware with that cookie
        // (Need to re-provide request layer with cookie header)
      }).pipe(Effect.provide(makeTestAuth("1234").layer))
    );

    it.effect("returns 401 JSON for unauthenticated API route", () =>
      Effect.gen(function* () {
        const response = yield* withAuthGate(innerOk);
        expect(response.status).toBe(401);
      }).pipe(
        Effect.provide(Layer.merge(
          makeTestAuth("1234").layer,
          makeTestRequest("/api/projects", {}), // no cookie, no header
        )),
      )
    );

    it.effect("returns 302 redirect for unauthenticated browser route", () =>
      Effect.gen(function* () {
        const response = yield* withAuthGate(innerOk);
        expect(response.status).toBe(302);
        // Verify Location header points to /auth
      }).pipe(
        Effect.provide(Layer.merge(
          makeTestAuth("1234").layer,
          makeTestRequest("/dashboard", {}), // browser route, no auth
        )),
      )
    );

    it.effect("authenticates via x-relay-pin header and sets cookie", () =>
      Effect.gen(function* () {
        const response = yield* withAuthGate(innerOk);
        expect(response.status).toBe(200);
        // Verify Set-Cookie header is present on response
      }).pipe(
        Effect.provide(Layer.merge(
          makeTestAuth("1234").layer,
          makeTestRequest("/api/data", { "x-relay-pin": "1234", "x-forwarded-for": "10.0.0.1" }),
        )),
      )
    );
  });

  // ─── authRoute: test the POST /auth handler ──────────────────────────
  describe("authRoute (POST /auth)", () => {
    // The executing agent must create mock requests with JSON bodies
    // and pass them through the route handler. Verify:
    // - Valid PIN → 200 + Set-Cookie header
    // - Wrong PIN → 401 + attemptsLeft in body
    // - Missing/invalid JSON body → 400 (EF-38-3 fix)
    // - Locked out IP → 429 + retryAfter in body

    it.effect("returns 400 on invalid JSON body", () =>
      Effect.gen(function* () {
        // This tests the EF-38-3 fix: req.json failure → 400, not unhandled error
        // Create a mock request where .json rejects (invalid body)
      }).pipe(Effect.provide(makeTestAuth("1234").layer))
    );
  });

  // ─── authStatusRoute: test GET /api/auth/status ──────────────────────
  describe("authStatusRoute (GET /api/auth/status)", () => {
    it.effect("returns authenticated: true when no PIN is set", () =>
      Effect.gen(function* () {
        // Verify the R2-38-1 fix: no PIN → { hasPin: false, authenticated: true }
        const auth = yield* AuthManagerTag;
        expect(auth.hasPin()).toBe(false);
        // The executing agent must invoke the route handler and check response body
      }).pipe(Effect.provide(makeTestAuth().layer))
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

// EFFECT-TS FIX (EF-38-1): Use Effect.fn for automatic tracing/telemetry
// and better stack traces on errors.
//
// EFFECT-TS FIX (EF-38-2): The executing agent MUST verify the
// HttpServerResponse.setHeader API. The pipe pattern used previously
// (`response.pipe(HttpServerResponse.setHeader(...))`) may not work —
// `yield* app` returns a resolved HttpServerResponse value, not a pipeable
// Effect. Use the options bag approach instead:
//   `yield* HttpServerResponse.json(body, { headers: { "Set-Cookie": value } })`
// Or if modifying an existing response, use:
//   `HttpServerResponse.setHeader(response, "Set-Cookie", value)`
// Check @effect/platform exports to confirm the correct form.

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
        // Set cookie on successful header auth — use functional combinator,
        // NOT response.pipe() (response is a value, not an Effect)
        return HttpServerResponse.setHeader(
          response,
          "Set-Cookie",
          `relay_session=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
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
  }).pipe(Effect.withSpan("auth.gate"));

// ─── POST /auth route ────────────────────────────────────────────────────────

export const authRoute = HttpRouter.post(
  "/auth",
  Effect.gen(function* () {
    const auth = yield* AuthManagerTag;
    const req = yield* HttpServerRequest.HttpServerRequest;

    // EFFECT-TS FIX (EF-38-3): req.json can fail (invalid JSON body).
    // Without error handling, the failure bubbles as an untyped router error
    // instead of returning 400. Catch and return a typed HTTP response.
    const body = yield* Effect.catchAll(req.json, () =>
      Effect.succeed(null),
    );
    if (body === null) {
      return yield* HttpServerResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }
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

    return yield* HttpServerResponse.json({ ok: true }, {
      headers: {
        "Set-Cookie": `relay_session=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      },
    });
  }).pipe(Effect.withSpan("auth.post")),
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
  }).pipe(Effect.withSpan("auth.status")),
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

// EFFECT-TS FIX (EF-39-1): Use Effect.fn for automatic tracing/telemetry
// and better stack traces. Replaces bare Effect.gen + manual withSpan.
//
// EFFECT-TS FIX (EF-39-2): Removed recursive self-call for directory
// index.html. The old code called `serveStaticFile(pathModule.join(...))`
// which could recurse on nested directories. Replaced with flat inline
// handling — resolve the index.html path directly and serve it.

// Helper: build an HTTP response for a file's content
const serveFileContent = (
  fs: FileSystem.FileSystem,
  pathModule: Path.Path,
  resolved: string,
  filePath: string,
) =>
  Effect.gen(function* () {
    const content = yield* fs.readFile(resolved);
    const ext = pathModule.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    return yield* HttpServerResponse.uint8Array(content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": getCacheControl(filePath),
      },
    });
  });

export const serveStaticFile = Effect.fn("static.serveFile")(
  function* (requestPath: string) {
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
        // Flat index.html resolution — no recursion
        const indexPath = pathModule.resolve(resolved, "index.html");
        const indexExists = yield* fs.exists(indexPath);
        if (indexExists) {
          return yield* serveFileContent(fs, pathModule, indexPath, "index.html");
        }
        return yield* HttpServerResponse.text("Not Found", { status: 404 });
      }
      return yield* serveFileContent(fs, pathModule, resolved, filePath);
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
  },
  // AUDIT FIX (A39-1): Catch PlatformError from fs.exists/stat/readFile
  // (e.g. permission denied). Without this, FS errors bubble as unhandled
  // router errors instead of returning 500.
  Effect.catchTag("SystemError", (err) =>
    HttpServerResponse.text("Internal Server Error", { status: 500 }).pipe(
      Effect.tap(Effect.logWarning("Static file error", err)),
    ),
  ),
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
  }).pipe(Effect.withSpan("route.deleteProject"))
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
  }).pipe(Effect.withSpan("route.project"))
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
  }).pipe(Effect.withSpan("route.root"))
);

// ─── Static catch-all ────────────────────────────────────────────────────────
const staticCatchAll = HttpRouter.get("/*",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    return yield* serveStaticFile(req.url);
  })
);
```

**Step 3:** Compose into full router with auth gate as `HttpRouter.use` middleware.

// EFFECT-TS FIX (EF-40-1): Use HttpRouter.use() to compose the auth gate
// as proper middleware instead of wrapping each route individually with
// withAuthGate(). This is more idiomatic, less error-prone (impossible to
// forget wrapping a new route), and matches how @effect/platform expects
// middleware to be composed.
//
// The executing agent MUST verify HttpRouter.use() exists in the installed
// @effect/platform version. Check:
//   node_modules/@effect/platform/dist/dts/HttpRouter.d.ts
// If HttpRouter.use() is not available, alternatives:
//   - HttpRouter.provideServiceEffect() for middleware that adds context
//   - HttpApp.use() / HttpMiddleware.make() from @effect/platform
//   - Fall back to withAuthGate() wrapping individual routes (less ideal)

```typescript
// ─── Router composition ─────────────────────────────────────────────────────

// Group 1: Unauthenticated routes (no auth gate)
const publicRoutes = HttpRouter.empty.pipe(
  // ... existing health, info, status, push, themes, setup-info, ca routes ...
  HttpRouter.merge(authPageRoute),    // GET /auth (login page)
  HttpRouter.merge(setupPageRoute),   // GET /setup
  HttpRouter.merge(authRoute),        // POST /auth
  HttpRouter.merge(authStatusRoute),  // GET /api/auth/status (reads cookie, no gate)
);

// Group 2: Auth-gated routes — withAuthGate applied once via HttpRouter.use
const protectedRoutes = HttpRouter.empty.pipe(
  HttpRouter.merge(deleteProjectRoute),
  HttpRouter.merge(projectRoute),     // GET /p/:slug/* (specific — before catch-all)
  HttpRouter.merge(rootRoute),        // GET /          (exact)
  // Apply auth gate as middleware to all protected routes at once
  HttpRouter.use((handler) => withAuthGate(handler)),
);

// AUDIT FIX (R5-40-1): Static catch-all MUST be in public routes, NOT behind
// auth gate. The old router (http-router.ts:234) intentionally lets static
// files (CSS/JS/images) through the auth gate so the login page at /auth can
// load its own bundles. Putting staticCatchAll behind withAuthGate would return
// 401 for /assets/app.a1b2c3.js → broken login page. The static catch-all is
// registered AFTER both public and protected routes so it only matches requests
// that no other route handled.
//
// Security note: static files are public by design — they contain no sensitive
// data (the SPA is client-side, all data comes via auth-gated API routes).

// Merge: public first, then protected, then static catch-all (public, last)
const fullRouter = HttpRouter.empty.pipe(
  HttpRouter.merge(publicRoutes),
  HttpRouter.merge(protectedRoutes),
  HttpRouter.merge(staticCatchAll),   // GET /* (catch-all — MUST be LAST, NOT auth-gated)
);
```

> **AUDIT FIX (A40-2): Route ordering is CRITICAL.** The catch-all `GET /*`
> (`staticCatchAll`) will shadow `GET /p/:slug/*` (`projectRoute`) if registered
> first. In Effect router, more specific routes MUST be registered before less
> specific ones. The composition above registers in order:
> ```
> deleteProjectRoute,  // DELETE /api/projects/:slug  (specific)
> projectRoute,        // GET /p/:slug/*              (specific)
> rootRoute,           // GET /                       (exact)
> staticCatchAll,      // GET /*                      (catch-all, LAST)
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
> - `GET /some-file.js` static catch-all serves file WITHOUT auth gate (R5-40-1)
> - Auth-gated API route (e.g. DELETE /api/projects/:slug) returns 401 when unauthenticated
> - Auth-gated browser route (e.g. GET /p/:slug/dashboard) returns 302 when unauthenticated

Commit: `feat(effect): complete Effect HTTP router with auth, static, and project routes`

---

## Task 41: Replace daemon HTTP stack with Effect router

> **AUDIT NOTE:** This is the highest-risk task. It replaces the HTTP request path that serves all traffic. Test thoroughly.

**Files:**
- Modify: `src/lib/daemon/daemon.ts` (class `Daemon`, replace `this.router` creation and WS upgrade auth)
- Modify: `src/lib/daemon/daemon-lifecycle.ts` (update `DaemonLifecycleContext.router` type if needed)
- Delete: `src/lib/server/server.ts`
- Delete: `src/lib/server/http-router.ts`
- Modify: `src/lib/server/static-files.ts` (update MIME_TYPES import)
- Test: `test/unit/daemon/daemon-http-integration.test.ts`

> **AUDIT FIX (R5-41-1): Corrected file paths and structure.**
> The daemon is a class at `src/lib/daemon/daemon.ts` (not `src/lib/effect/daemon-main.ts`).
> There is no separate `daemon-layers.ts` file. `daemon-lifecycle.ts` is at
> `src/lib/daemon/daemon-lifecycle.ts` (not `src/lib/server/`).
> The daemon uses `class Daemon` (plain class, does NOT extend TrackedService) with instance fields
> (`this.router`, `this.auth`, `this.registry`), not a functional `startDaemonProcess`.

**Context:** `Daemon.start()` currently:
1. Creates `this.router = new RequestRouter(...)` with auth, staticDir, getProjects, etc. (line ~630)
2. Calls `this.startHttpServer()` (line ~675)
3. `DaemonLifecycleContext.router` is typed as `{ handleRequest(req, res): Promise<void> } | null`
4. The WS upgrade handler at line ~688 uses `this.router!.checkAuth(req)` for auth

After this task:
1. The Effect router serves ALL HTTP routes
2. `NodeHttpServer.makeHandler(effectRouter)` converts it to a Node request handler
3. The daemon still uses `daemon-lifecycle.ts` for TLS peek/redirect (keep this)
4. `RequestRouter` and `RelayServer` are deleted

**Step 1: Write integration test**

```typescript
// test/unit/daemon/daemon-http-integration.test.ts
//
// EFFECT-TS FIX (EF-41-1): This is the highest-risk task — replacing the
// entire HTTP stack. Tests MUST be written BEFORE deleting old modules, not
// after. The skeleton below provides real test structure. The executing agent
// must fill in the concrete assertions after verifying NodeHttpServer and
// HttpClient APIs against installed @effect/platform-node.
//
// AUDIT FIX (R2-41-1): Write actual integration tests, not just imports.

import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { createServer } from "node:http";
import { effectRouterWithCors } from "../../../src/lib/server/effect-http-router.js";
import { AuthManagerTag } from "../../../src/lib/effect/auth-middleware.js";
import { StaticDirTag } from "../../../src/lib/effect/static-file-handler.js";
import { ProjectsProvider } from "../../../src/lib/server/effect-http-router.js";
import { AuthManager } from "../../../src/lib/auth.js";
import { NodeFileSystem } from "@effect/platform-node";

// ─── Test layer with all provider tags satisfied ────────────────────────────
const testAuth = new AuthManager();
const TestAuthLayer = Layer.succeed(AuthManagerTag, testAuth);
const TestStaticDir = Layer.succeed(StaticDirTag, "/tmp/conduit-test-static");
const TestProjectsProvider = Layer.succeed(ProjectsProvider, {
  getProjects: () => [
    { slug: "test-project", title: "Test", directory: "/tmp", status: "active" },
  ],
});

// Compose all test providers
const TestProviders = Layer.mergeAll(
  TestAuthLayer,
  TestStaticDir,
  TestProjectsProvider,
  NodeFileSystem.layer,
  // The executing agent must add any additional optional providers
  // (HealthProvider, PushProvider, etc.) or verify they degrade gracefully
);

// The executing agent MUST verify how to spin up a test HTTP server using
// NodeHttpServer.makeHandler or HttpApp.toWebHandler. The pattern is:
//   1. Create handler from Effect router + test layer
//   2. Start a Node http.createServer with that handler
//   3. Use HttpClient to make requests against localhost:port
//   4. Tear down after tests

describe("Daemon HTTP integration", () => {
  // Test helper: the executing agent must implement this based on the
  // actual NodeHttpServer.makeHandler API. Example approach:
  //
  // const withTestServer = <A>(
  //   test: (baseUrl: string) => Effect.Effect<A>
  // ) => Effect.scoped(Effect.gen(function* () {
  //   const handler = NodeHttpServer.makeHandler(
  //     effectRouterWithCors.pipe(Effect.provide(TestProviders))
  //   );
  //   const server = createServer(handler);
  //   server.listen(0); // random port
  //   const port = (server.address() as { port: number }).port;
  //   yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
  //   return yield* test(`http://localhost:${port}`);
  // }));

  it.effect("GET /health returns 200", () =>
    Effect.gen(function* () {
      // Use withTestServer helper to make a real HTTP request
      // const response = yield* withTestServer((url) =>
      //   HttpClient.get(`${url}/health`)
      // );
      // expect(response.status).toBe(200);
    })
  );

  it.effect("GET /api/auth/status returns authenticated:true when no PIN", () =>
    Effect.gen(function* () {
      // No PIN set → { hasPin: false, authenticated: true }
    })
  );

  it.effect("POST /auth with invalid JSON returns 400", () =>
    Effect.gen(function* () {
      // Tests EF-38-3 fix: req.json failure → 400, not unhandled error
    })
  );

  it.effect("auth gate blocks unauthenticated API requests with 401", () =>
    Effect.gen(function* () {
      // Set a PIN on testAuth, then request /api/projects without cookie
      // testAuth.setPin("9999");
      // const response = yield* withTestServer((url) =>
      //   HttpClient.get(`${url}/api/projects`)
      // );
      // expect(response.status).toBe(401);
      // testAuth.setPin(""); // cleanup
    })
  );

  it.effect("GET / redirects to /p/{slug}/ with single project", () =>
    Effect.gen(function* () {
      // TestProjectsProvider has 1 project → expect 302 redirect
    })
  );

  it.effect("GET /nonexistent returns 404 from static handler", () =>
    Effect.gen(function* () {
      // Static catch-all with no matching file → 404
    })
  );
});
```

**Step 2: Modify `src/lib/daemon/daemon.ts`**

> **AUDIT FIX (R5-41-2): The daemon is class-based.** All references below use
> `this.router`, `this.auth`, `this.staticDir`, `this.registry` — instance
> fields of the `Daemon` class. The executing agent must modify the `start()`
> method, not a standalone function.

Replace the `this.router = new RequestRouter(...)` block (line ~630) with Effect router provider wiring:

```typescript
// BEFORE (line ~630):
// this.router = new RequestRouter({ auth: this.auth, staticDir: this.staticDir, ... });

// AFTER:
import { effectRouterWithCors } from "../server/effect-http-router.js";
import { AuthManagerTag } from "../effect/auth-middleware.js";
import { StaticDirTag } from "../effect/static-file-handler.js";
import { NodeHttpServer } from "@effect/platform-node";

// Create the Effect-based request handler
const routerLayer = Layer.mergeAll(
  Layer.succeed(AuthManagerTag, this.auth),
  Layer.succeed(StaticDirTag, this.staticDir),
  Layer.succeed(ProjectsProvider, {
    getProjects: () => this.registry.allProjects().map(toRouterProject),
  }),
  // ... other provider layers from daemon context
);
const effectHandler = NodeHttpServer.makeHandler(effectRouterWithCors, routerLayer);

// Wrap in DaemonLifecycleContext.router shape:
// { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> }
this.router = {
  handleRequest: async (req, res) => effectHandler(req, res),
};
```

> **AUDIT FIX (A41-1):** The executing agent MUST verify `NodeHttpServer.makeHandler`
> signature against installed `@effect/platform-node`. The actual API may be:
> - `NodeHttpServer.makeHandler(httpApp)` → `(req, res) => void` (no Layer param)
> - `NodeHttpServer.makeHandler(httpApp, Layer)` → `(req, res) => void`
> - Or `HttpApp.toWebHandler(httpApp)` from `@effect/platform`
> Check `node_modules/@effect/platform-node/dist/dts/NodeHttpServer.d.ts`.
> If the handler doesn't accept a Layer param, provide context via
> `httpApp.pipe(Effect.provide(routerLayer))` before passing to makeHandler.

The `this.startHttpServer()` call can remain as-is — `daemon-lifecycle.ts`'s
`startHttpServer(ctx)` already consumes `ctx.router!.handleRequest(req, res)`,
and Step 2 above assigns `this.router` with the correct `{ handleRequest }` shape.

> **AUDIT FIX (R3-41-1 — RESOLVED by R5-41-2):** The Step 2 wrapper above
> assigns `this.router = { handleRequest: async (req, res) => effectHandler(req, res) }`,
> which matches `DaemonLifecycleContext.router` type
> (`{ handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> } | null`
> — see `src/lib/daemon/daemon-lifecycle.ts:57-59`).
> No changes to daemon-lifecycle.ts are needed for the HTTP handler.

**Step 3:** The TLS peek server in `src/lib/daemon/daemon-lifecycle.ts` delegates
to `ctx.router!.handleRequest(req, res)` — this continues to work with the
wrapper above. No changes needed.

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

// EFFECT-TS FIX (EF-42-2): Heartbeat uses Effect.repeat(Schedule.spaced(...))
// which will STALL FOREVER in it.effect tests because TestClock is active.
// Time does not advance unless you call TestClock.adjust.
//
// The executing agent MUST use the fork + TestClock.adjust pattern:
describe("Heartbeat", () => {
  it.effect("pings connected clients on schedule", () =>
    Effect.gen(function* () {
      // 1. Set up WsHandlerState with mock clients
      // 2. Fork the heartbeat fiber
      const fiber = yield* Effect.fork(makeHeartbeatFiber(30_000));
      // 3. Advance TestClock past the interval
      yield* TestClock.adjust("30 seconds");
      // 4. Assert: mock clients received ping
      // 5. Interrupt the fiber to clean up
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(/* test layers */))
  );

  it.effect("terminates dead connections (no pong response)", () =>
    Effect.gen(function* () {
      // 1. Set up client with isAlive = true
      // 2. Fork heartbeat, advance past first tick → isAlive set to false
      const fiber = yield* Effect.fork(makeHeartbeatFiber(30_000));
      yield* TestClock.adjust("30 seconds");
      // 3. Don't send pong (simulate dead connection)
      // 4. Advance past second tick → connection should be terminated
      yield* TestClock.adjust("30 seconds");
      // 5. Assert: dead client was removed from state
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(/* test layers */))
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/ws-transport-layer.ts
import { Context, Effect, Layer, Scope } from "effect";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
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
      // AUDIT FIX (R5-42-1): Use createRequire instead of dynamic import("ws").
      // The existing ws-handler.ts deliberately uses createRequire because
      // "ws is CJS-only and named ESM imports behave inconsistently across
      // tsx, vitest, and Node ESM." This is a known issue documented in the
      // codebase. Using import("ws") would reintroduce the inconsistency.
      //
      // Wrap in Effect.try (synchronous, can throw) rather than
      // Effect.tryPromise (async, for promises).
      const { WebSocketServer } = yield* Effect.try({
        try: () => {
          const require = createRequire(import.meta.url);
          return require("ws") as typeof import("ws");
        },
        catch: (e) => new Error(`Failed to load ws module: ${e}`),
      });

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
> **AUDIT FIX (R2-42-2 — RESOLVED):** `WsConn` interface in ws-handler-service
> only has `send`, `readyState`, `close`. It lacks `ping()` and `terminate()`
> needed for heartbeat. The executing agent MUST extend `WsConn`:
> ```typescript
> export interface WsConn {
>   send(data: string): void;
>   readyState: number;
>   close(code?: number, reason?: string): void;
>   ping?(): void;        // Optional — only present on real ws.WebSocket
>   terminate?(): void;   // Optional — forceful close without handshake
> }
> ```
> Then the heartbeat uses optional chaining: `client.ws.ping?.()` and
> `client.ws.terminate?.()`. This keeps WsConn testable (mocks don't need
> ping/terminate) while allowing real ws.WebSocket instances to pass through.
> The `ws` library's WebSocket has both methods — confirmed in ws types.
>
> **AUDIT FIX (R2-42-3 — CORRECTED):** `Schedule.spaced` accepts any
> `DurationInput`, which includes both numbers (milliseconds) and human-readable
> strings like `"30 seconds"`. Both `Schedule.spaced(30_000)` and
> `Schedule.spaced("30 seconds")` are valid. Use whichever is clearer.
> The original audit incorrectly stated strings are not accepted.

```typescript
// Heartbeat: pings all connected clients on a schedule.
// Uses ws-handler-service to enumerate clients.
// Implements full alive-tracking protocol matching old ws-handler.ts behavior.
import { WsHandlerStateTag, removeClient } from "./ws-handler-service.js";
import { Schedule } from "effect";

// EFFECT-TS FIX (EF-42-3): Use Effect.fn for automatic tracing/telemetry.
export const makeHeartbeatFiber = (intervalMs = 30_000) =>
  Effect.fn("ws.heartbeat")(function* () {
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
            client.ws.ping?.();
          }
        }).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: "unbounded", discard: true },
    );
  })().pipe(
    Effect.repeat(Schedule.spaced(intervalMs)),
    Effect.annotateLogs("component", "ws-heartbeat"),
  );
```

Commit: `feat(effect): add WebSocket transport Layer wrapping ws library`

---

## Task 43: Wire relay to Effect WS transport, delete ws-handler.ts

**Files:**
- Create: `src/lib/server/ws-handler-shape.ts` (extract interface from WebSocketHandler — see R5-43-1)
- Modify: `src/lib/relay/relay-stack.ts` (replace `new WebSocketHandler(...)`)
- Modify: `src/lib/relay/monitoring-wiring.ts` (update type import to `WebSocketHandlerShape`)
- Modify: `src/lib/relay/poller-wiring.ts` (update type import to `WebSocketHandlerShape`)
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` (update type import to `WebSocketHandlerShape`)
- Modify: `src/lib/relay/timer-wiring.ts` (update type import to `WebSocketHandlerShape`)
- Modify: `src/lib/relay/handler-deps-wiring.ts` (update type import — uses `.on()` events)
- Modify: `src/lib/handlers/types.ts` (verify `HandlerDeps.wsHandler` is compatible with shape)
- Verify: `src/lib/relay/sse-wiring.ts`, `src/lib/relay/pty-upstream.ts` (heavy `wsHandler.` consumers via deps — no import change needed, but bridge must satisfy their usage)
- Verify: `src/lib/session/session-switch.ts` (uses `deps.wsHandler.setClientSession`, `sendTo`)
- Verify: ALL handler files in `src/lib/handlers/` (80+ wsHandler call sites via `HandlerDeps`)
- Delete: `src/lib/server/ws-handler.ts`
- Test: update relevant relay tests

> **AUDIT FIX (R5-43-1): Extract `WebSocketHandlerShape` interface before building bridge.**
>
> `handler-deps-wiring.ts:38` types `wsHandler` as the concrete `WebSocketHandler`
> class — the bridge object cannot satisfy this. The executing agent MUST:
>
> **Step 0 (before building bridge):** Extract a `WebSocketHandlerShape` interface
> covering ALL methods used across the codebase. Grep for `wsHandler.` to find them:
>
> ```typescript
> // src/lib/server/ws-handler-shape.ts
> import type { RelayMessage } from "../types.js";
> import type { IncomingMessage } from "node:http";
> import type { Duplex } from "node:stream";
>
> /** Shape of the WebSocket handler — satisfied by both the old WebSocketHandler
>  * class and the new Effect bridge. Extracted to decouple consumers from the
>  * concrete class so ws-handler.ts can be deleted. */
> export interface WebSocketHandlerShape {
>   // ── Methods used by HandlerDeps (handlers/types.ts:62-70) ──────────
>   broadcast(msg: RelayMessage): void;
>   sendTo(clientId: string, msg: RelayMessage): void;
>   setClientSession(clientId: string, sessionId: string): void;
>   getClientSession(clientId: string): string | undefined;
>   getClientsForSession(sessionId: string): string[];
>   sendToSession(sessionId: string, msg: RelayMessage): void;
>
>   // ── Methods used by wiring files ──────────────────────────────────
>   broadcastPerSessionEvent(sessionId: string, msg: RelayMessage): void;
>   markClientBootstrapped(clientId: string): void;
>   getClientCount(): number;
>
>   // ── Transport (used by relay-stack.ts, daemon.ts WS upgrade) ──────
>   handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
>   close(): void;
>
>   // ── EventEmitter pattern (used by handler-deps-wiring.ts) ─────────
>   on(event: "client_connected", cb: (data: {
>     clientId: string; clientCount: number; requestedSessionId?: string;
>   }) => void): void;
>   on(event: "client_disconnected", cb: (data: {
>     clientId: string; clientCount: number; sessionId?: string;
>   }) => void): void;
>   on(event: "message", cb: (data: {
>     clientId: string; handler: string; payload: Record<string, unknown>;
>   }) => void): void;
> }
> ```
>
> Then update ALL consumers to import `WebSocketHandlerShape` instead of
> `WebSocketHandler`:
> - `handler-deps-wiring.ts:24,38`
> - `monitoring-wiring.ts:10,43`
> - `session-lifecycle-wiring.ts:8,23`
> - `poller-wiring.ts:8,31`
> - `timer-wiring.ts:9,17`
> - `relay-stack.ts:32,60,111`
> - Any other files found by grep

**Context:** `relay-stack.ts` line ~331 creates `new WebSocketHandler(serviceRegistry, server, { registry, verifyClient })`. The wiring files import `WebSocketHandler` as a type only. The executing agent must:

1. Extract `WebSocketHandlerShape` interface (Step 0 above)
2. Replace the `new WebSocketHandler(...)` call with creation of bridge + WsTransport layer
3. Wire the `ws.on("connection")` event to register clients in `ws-handler-service`
4. Wire `ws.on("message")` to the existing `parseIncomingMessage` + `routeMessage` pure functions from `ws-router.ts`
5. Wire `ws.on("close")` and `ws.on("error")` to `removeClient`
6. Update the `ProjectRelay` interface — `wsHandler` property type changes from `WebSocketHandler` to `WebSocketHandlerShape`

**Key: COMPLETE bridge method mapping (all `wsHandler.` usages across codebase):**

State/messaging methods (bridge to ws-handler-service Effect functions via ManagedRuntime):

> **EFFECT-TS FIX (EF-43-1): `runSync` vs `runPromise` for the bridge.**
>
> The plan uses `runtime.runSync(...)` throughout the bridge. This is safe
> **only if** every ws-handler-service function is purely synchronous (uses
> only `Ref`, `HashMap`, `Effect.sync` — no `Effect.promise`,
> `Effect.tryPromise`, `Effect.async`, or other async operations). Currently
> ws-handler-service meets this constraint.
>
> **CRITICAL CONSTRAINT:** If anyone adds an async operation to
> ws-handler-service in the future (e.g., logging to disk, persistence),
> `runSync` will throw at runtime with no compile-time warning.
>
> **Recommended safer alternative for fire-and-forget calls** (broadcast,
> sendTo, removeClient): use `runtime.runPromise(...).catch(logError)`.
> This handles both sync and async operations without blocking the event
> loop. For calls that MUST be synchronous (getClientCount, getClientIds —
> return values needed immediately), `runSync` is acceptable.
>
> The executing agent MUST:
> 1. Use `runtime.runSync` only for methods that return a value synchronously
>    (getClientCount, getClientIds, getClientSession, getSessionViewers)
> 2. Use `runtime.runPromise(...).catch(...)` for fire-and-forget mutations
>    (addClient, removeClient, broadcast, sendTo, sendToSession, etc.)
> 3. Add a code comment at the ManagedRuntime creation site documenting the
>    sync constraint: "ws-handler-service effects MUST remain synchronous
>    for runSync bridge calls — see Phase 5b plan EF-43-1"

- `wsHandler.broadcast(message)` → `broadcast` from ws-handler-service
- `wsHandler.sendTo(clientId, message)` → `sendTo` from ws-handler-service
- `wsHandler.sendToSession(sessionId, message)` → `sendToSession` from ws-handler-service (used in monitoring-wiring:131, sse-wiring:365,578)
- `wsHandler.broadcastPerSessionEvent(sessionId, message)` → `broadcastPerSessionEvent` from ws-handler-service
- `wsHandler.markClientBootstrapped(clientId)` → `markClientBootstrapped` from ws-handler-service
- `wsHandler.getClientCount()` → `getClientCount` from ws-handler-service
- `wsHandler.getClientsForSession(sessionId)` → `getSessionViewers` from ws-handler-service (used in monitoring-wiring:145, poller-wiring:81, sse-wiring:382)
- `wsHandler.setClientSession(clientId, sessionId)` → `bindClientSession` from ws-handler-service

Transport/lifecycle methods (bridge to WsTransportTag or direct implementation):
- `wsHandler.handleUpgrade(req, socket, head)` → delegate to `WsTransportTag.handleUpgrade` (used in relay-stack:757,766)
- `wsHandler.close()` → close the ManagedRuntime + wss (used in relay-stack:549 for shutdown)

Event emitter methods (bridge TrackedService `.on()` pattern):
- `wsHandler.on("client_connected", cb)` → used in handler-deps-wiring:119
- `wsHandler.on("client_disconnected", cb)` → used in handler-deps-wiring:131
- `wsHandler.on("message", cb)` → used in handler-deps-wiring:201

**Event system bridge design:** The old `WebSocketHandler` extends `TrackedService` (EventEmitter pattern). The bridge MUST provide an equivalent. Options:
- (a) Simple EventEmitter: `const events = new EventEmitter()` on the bridge object, emit during `wss.on("connection")` handler. Bridge `.on()` delegates to this emitter.
- (b) Effect PubSub: overkill for imperative consumers — choose (a).

> **AUDIT FIX (R5-43-2): TrackedService / ServiceRegistry integration.**
>
> The old `WebSocketHandler` extends `TrackedService` and registers itself
> with the daemon's `ServiceRegistry` (first constructor arg at
> `relay-stack.ts:331`). `ServiceRegistry` is used for daemon health tracking
> and service lifecycle management. The bridge using a plain EventEmitter
> skips this integration.
>
> The executing agent MUST:
> 1. Check what `TrackedService` actually provides beyond EventEmitter
>    (read `src/lib/daemon/tracked-service.ts`)
> 2. Check how `ServiceRegistry` uses registered services (health checks,
>    shutdown coordination, status reporting)
> 3. If TrackedService only provides EventEmitter + a name for logging,
>    the bridge can register itself with `serviceRegistry.register("ws-handler", bridge)`
>    directly (or use `serviceRegistry.track(name, service)` — verify API)
> 4. If TrackedService provides lifecycle hooks (start/stop/health), the bridge
>    must implement those or document why they're not needed
>
> If `ServiceRegistry` integration is genuinely unnecessary for the bridge
> (e.g., the registry only tracks services for logging), document this
> decision explicitly in a code comment so future maintainers know it's
> intentional, not an oversight.

The `wss.on("connection")` handler in Step 2 must emit these events:
```typescript
// EFFECT-TS FIX (EF-43-1 applied): Use runPromise for fire-and-forget
// mutations, runSync only for synchronous reads that return values.
const logBridgeError = (op: string) => (err: unknown) =>
  console.error(`[ws-bridge] ${op} failed:`, err);

wss.on("connection", (ws, req) => {
  const clientId = generateClientId();
  const requestedSessionId = extractSessionFromUrl(req.url);
  // addClient is fire-and-forget — use runPromise
  runtime.runPromise(addClient(clientId, ws)).catch(logBridgeError("addClient"));
  events.emit("client_connected", { clientId, requestedSessionId });

  ws.on("message", (data) => {
    const msg = parseIncomingMessage(data);
    if (msg) events.emit("message", { clientId, handler: msg.handler, payload: msg.payload });
  });

  ws.on("close", () => {
    // getClientSession returns a value — runSync is acceptable (sync-safe)
    const sessionId = runtime.runSync(getClientSession(clientId));
    // removeClient is fire-and-forget — use runPromise
    runtime.runPromise(removeClient(clientId)).catch(logBridgeError("removeClient"));
    events.emit("client_disconnected", { clientId, sessionId });
  });
});
```

> **AUDIT FIX (R3-43-1):** The old `WebSocketHandler` also has
> `getClientsForSession(sessionId)` which is used by wiring files but NOT
> listed in the mapping above. The executing agent MUST:
> 1. Grep for ALL `wsHandler.` method calls across wiring files
> 2. Verify every method is bridged — the list above may be incomplete
> 3. Check ws-handler-service.ts exports for matching functions
> 4. If a method has no ws-handler-service equivalent, add one or inline it

The bridge wraps Effect functions using a scoped ManagedRuntime. Fire-and-forget mutations use `runtime.runPromise(...).catch(logError)` for safety; synchronous reads that return values use `runtime.runSync(...)` (acceptable because ws-handler-service operations are sync-safe). See EF-43-1 above for constraints.

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
// EFFECT-TS FIX (EF-43-1 applied): runPromise for mutations, runSync for reads.
// ws-handler-service effects MUST remain synchronous for runSync bridge calls.
const logBridgeError = (op: string) => (err: unknown) =>
  console.error(`[ws-bridge] ${op} failed:`, err);

wss.on("connection", (ws, req) => {
  const clientId = generateClientId();
  // Register in Effect state (fire-and-forget)
  runtime.runPromise(addClient(clientId, ws)).catch(logBridgeError("addClient"));

  ws.on("message", (data) => {
    const msg = parseIncomingMessage(data);
    if (msg) routeMessage(msg, clientId, handlers);
  });

  ws.on("close", () => {
    runtime.runPromise(removeClient(clientId)).catch(logBridgeError("removeClient"));
  });

  ws.on("error", () => {
    runtime.runPromise(removeClient(clientId)).catch(logBridgeError("removeClient"));
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
> `http-router.ts` which removes the `RequestRouter` class used by the WS upgrade
> handler (`this.router!.checkAuth(req)` at `src/lib/daemon/daemon.ts` line ~703).
> Without this fix applied in the same commit as Task 41, the code won't compile
> between Tasks 41 and 44. **The auth check replacement below MUST be applied as
> part of Task 41's changes.**

**Merged into Task 41 Step 2.** When replacing the RequestRouter in `src/lib/daemon/daemon.ts`, also update the WS upgrade handler (line ~688-720):

```typescript
// BEFORE (daemon.ts line ~703):
if (this.auth.hasPin() && !this.router!.checkAuth(req)) {

// AFTER:
// Use AuthManager directly (already available as this.auth on the Daemon class).
// Import parseCookies from auth-middleware.ts or http-utils.ts, or define inline.
const cookies = parseCookies(req.headers.cookie ?? "");
const sessionCookie = cookies["relay_session"] ?? "";
const pinHeader = req.headers["x-relay-pin"];
const authenticated = !this.auth.hasPin() ||
  this.auth.validateCookie(sessionCookie) ||
  (typeof pinHeader === "string" && this.auth.authenticate(pinHeader, getClientIp(req)).ok);
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
  // AUDIT FIX (R2-45-3 + R4-45-1): The executing agent MUST write FULL test
  // implementations — not comments. Provide a MockWebSocket class:
  //
  // class MockWebSocket extends EventTarget {
  //   constructor(public readyState = WebSocket.OPEN) { super(); }
  //   close() { this.readyState = WebSocket.CLOSED; }
  //   emitMessage(data: string) {
  //     this.dispatchEvent(new MessageEvent("message", { data }));
  //   }
  // }
  //
  // Then write tests that:
  // 1. Create MockWebSocket, call preloadDecoder(), create stream, emit messages
  // 2. Collect stream output via Stream.runCollect or toArray
  // 3. Assert: valid known type (e.g. { type: "delta", sessionId: "s1", text: "hi" })
  //    → appears in collected output with correct shape
  // 4. Assert: invalid JSON string "not json{" → silently skipped, stream continues
  // 5. Assert: unknown type { type: "future_type", data: 1 } → passes through unchanged
  // 6. Assert: malformed known type { type: "delta" } (missing sessionId) → passes
  //    through raw (graceful degradation, not dropped)
  // 7. Assert: stream completes when socket closes
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

> **AUDIT FIX (R4-45-2):** The `as RelayMessage` cast is INTENTIONAL but must
> be understood: `decodeMessage(raw)` returns validated data for known types OR
> raw passthrough for unknown/malformed types. The cast is safe because:
> 1. All messages have a `type` field (JSON parse succeeded + has structure)
> 2. Downstream switch statements on `msg.type` already ignore unknown types
> 3. Malformed known types (e.g. `{ type: "delta" }` missing fields) pass through
>    raw — downstream code accesses optional fields safely via existing guards
>
> This is deliberate type widening for forward compatibility. The alternative
> (dropping failed decodes) would break when the server adds new message types
> that the frontend schema doesn't know yet. Do NOT change this to drop messages.
> The executing agent should verify that downstream consumers don't destructure
> without null checks on fields that could be missing in the passthrough case.

Commit: `feat(effect): integrate Schema validation into frontend WS message stream`

---

## Task 46: Delete old files, cleanup, and final verification

**Files to delete:**
- ~~`src/lib/server/static-files.ts`~~ — **DO NOT DELETE.** `daemon-lifecycle.ts:22`
  imports `serveStaticFile`/`tryServeStatic` for the HTTP onboarding server
  (pre-TLS setup page at `/setup`). This is a separate server from the main
  daemon and still needs the Node-native static file helpers. Deletion would
  break onboarding. The Effect `static-file-handler.ts` serves the MAIN daemon
  only — the onboarding server is not Effect-based.
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
# Expected: 1 (daemon-lifecycle.ts onboarding server — intentionally kept)
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
| 46 | Delete old files + verification | old tests (NOT static-files.ts) | Medium |

> **Tasks 38-41 are ATOMIC.** They replace the entire HTTP request path (including WS upgrade auth from merged Task 44).
> **Tasks 42-43 are ATOMIC.** They replace the WS transport.
> **Tasks 45-46 are independent** and can be committed separately.
