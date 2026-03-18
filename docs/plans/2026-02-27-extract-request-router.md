# Extract RequestRouter: Deduplicate daemon.ts / server.ts

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract ~400 lines of duplicated HTTP routing, auth, and static file serving code from `daemon.ts` and `server.ts` into a single `RequestRouter` class.

**Architecture:** Create `src/lib/http-router.ts` with a `RequestRouter` class that owns all HTTP request handling: CORS, auth endpoints, auth gate, route dispatch, push APIs, static file serving. Both `RelayServer` (server.ts) and `Daemon` (daemon.ts) instantiate it with a dependency object and delegate their `handleRequest` to it. Extension points (`authExemptPaths`, `getHealthResponse`, `onProjectApiRequest`, `caRootPath`) handle the behavioral differences between the two consumers.

**Tech Stack:** TypeScript (strict), Node.js `http` module, Vitest, fast-check

---

## Current State

### Duplication Map

| Duplicated Code | server.ts | daemon.ts |
|---|---|---|
| MIME_TYPES map | :53-71 | :59-74 |
| handleAuth() | :537-580 | :661-704 |
| checkAuth() | :582-598 | :707-722 |
| CORS headers | :196-204 | :736-744 |
| Auth status API | :219-225 | :759-765 |
| Auth gate | :228-263 | :768-812 |
| Auth page GET | :266-269 | :815-818 |
| Setup page | :272-275 | :821-824 |
| Setup info API | :278-293 | :827-843 |
| Projects API | :309-323 | :863-877 |
| Push APIs (3 routes) | :326-424 | :879-978 |
| Health check | :427-437 | :846-849 |
| Info endpoint | :440-450 | :853-860 |
| Project routes | :490-518 | :981-991 |
| Root/dashboard | :296-306 | :999-1008 |
| Static file serving | :603-663 | :1012-1069 |

### Behavioral Differences

| Behavior | server.ts | daemon.ts |
|---|---|---|
| Auth exempt paths | (none) | `/setup`, `/health`, `/api/status` |
| Health response | `{ ok, projects, uptime }` | Full `getStatus()` with pinEnabled, tlsEnabled, etc. |
| Health endpoints | `/health` only | `/health` + `/api/status` |
| Project API request | Delegates to `project.onApiRequest` | No project API delegation |
| CA cert download | Yes (if `tls.caRoot` set) | No |
| Static 404 fallback | Tries SPA fallback, then 404 | Returns 404 directly |
| MIME entries | 19 entries | 15 entries (missing .jpeg, .gif, .ttf) |

---

## Task 1: Create RequestRouter with MIME_TYPES and CORS

**Files:**
- Create: `src/lib/http-router.ts`
- Create: `test/unit/http-router.test.ts`

### Step 1: Write the failing test

```typescript
// test/unit/http-router.test.ts
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { RequestRouter, MIME_TYPES } from "../../src/lib/http-router.js";
import { AuthManager } from "../../src/lib/auth.js";

/** Minimal deps for tests that don't need auth or projects */
function minimalDeps(overrides: Partial<Parameters<typeof RequestRouter["prototype"]["constructor"]>[0]> = {}) {
  return {
    auth: new AuthManager(),
    staticDir: "/tmp/nonexistent",
    getProjects: () => [],
    port: 0,
    isTls: false,
    ...overrides,
  };
}

/** Start an HTTP server backed by RequestRouter, returns { port, close } */
async function startRouter(
  deps: Parameters<typeof RequestRouter["prototype"]["constructor"]>[0],
): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new RequestRouter(deps);
  const server = createServer((req, res) => {
    router.handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("RequestRouter", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  describe("MIME_TYPES", () => {
    it("exports a complete MIME types map", () => {
      expect(MIME_TYPES[".html"]).toBe("text/html; charset=utf-8");
      expect(MIME_TYPES[".css"]).toBe("text/css; charset=utf-8");
      expect(MIME_TYPES[".js"]).toBe("application/javascript; charset=utf-8");
      expect(MIME_TYPES[".json"]).toBe("application/json");
      expect(MIME_TYPES[".png"]).toBe("image/png");
      expect(MIME_TYPES[".jpeg"]).toBe("image/jpeg");
      expect(MIME_TYPES[".gif"]).toBe("image/gif");
      expect(MIME_TYPES[".svg"]).toBe("image/svg+xml");
      expect(MIME_TYPES[".woff2"]).toBe("font/woff2");
      expect(MIME_TYPES[".ttf"]).toBe("font/ttf");
      expect(MIME_TYPES[".webp"]).toBe("image/webp");
    });
  });

  describe("CORS", () => {
    it("OPTIONS returns 204 with CORS headers", async () => {
      const { port, close } = await startRouter(minimalDeps());
      cleanup = close;

      const res = await fetch(`http://127.0.0.1:${port}/anything`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
      expect(res.headers.get("access-control-allow-headers")).toContain("X-Relay-Pin");
    });

    it("all responses include CORS headers", async () => {
      const { port, close } = await startRouter(minimalDeps());
      cleanup = close;

      const res = await fetch(`http://127.0.0.1:${port}/info`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/http-router.test.ts`
Expected: FAIL — module `../../src/lib/http-router.js` not found

### Step 3: Write minimal implementation

```typescript
// src/lib/http-router.ts
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import type { AuthManager } from "./auth.js";
import { getClientIp, parseCookies, readBody } from "./http-utils.js";
import type { PushNotificationManager } from "./push.js";
import { getVersion } from "./version.js";

// ─── MIME types (canonical — used by both RelayServer and Daemon) ────────────

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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RouterProject {
  slug: string;
  directory: string;
  title: string;
}

export interface RequestRouterDeps {
  auth: AuthManager;
  staticDir: string;
  getProjects: () => RouterProject[];
  port: number;
  isTls: boolean;
  pushManager?: PushNotificationManager;

  // Extension points for consumer-specific behavior
  /** Paths exempt from auth gate (daemon adds /setup, /health, /api/status) */
  authExemptPaths?: string[];
  /** Custom health response (daemon returns getStatus()) */
  getHealthResponse?: () => object;
  /** Handle project-scoped API requests (server delegates to project.onApiRequest) */
  onProjectApiRequest?: (
    slug: string,
    req: IncomingMessage,
    res: ServerResponse,
    subPath: string,
  ) => boolean;
  /** Path to CA root certificate file for /ca/download */
  caRootPath?: string;
}

// ─── RequestRouter ──────────────────────────────────────────────────────────

export class RequestRouter {
  private readonly deps: RequestRouterDeps;

  constructor(deps: RequestRouterDeps) {
    this.deps = deps;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // CORS headers on all responses
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Relay-Pin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth endpoint (must be accessible without auth)
    if (pathname === "/auth" && req.method === "POST") {
      await this.handleAuth(req, res);
      return;
    }

    // Auth status API (before auth gate)
    if (pathname === "/api/auth/status" && req.method === "GET") {
      const hasPin = this.deps.auth.hasPin();
      const authenticated = hasPin ? this.checkAuth(req) : true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hasPin, authenticated }));
      return;
    }

    // Auth gate
    if (this.deps.auth.hasPin()) {
      const authed = this.checkAuth(req);
      if (!authed) {
        const exemptPaths = this.deps.authExemptPaths ?? [];
        const isExempt = exemptPaths.includes(pathname);
        if (!isExempt) {
          const isBrowserRoute =
            pathname === "/" || pathname === "" || pathname === "/auth" || pathname.startsWith("/p/");
          const isApiRoute = pathname.startsWith("/api/");
          const hasPinHeader = req.headers["x-relay-pin"] !== undefined;

          if (isApiRoute || hasPinHeader) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "PIN required" } }));
            return;
          }
          if (isBrowserRoute) {
            if (pathname !== "/auth") {
              res.writeHead(302, { Location: "/auth" });
              res.end();
              return;
            }
            await this.serveStaticFile(res, "index.html");
            return;
          }
          // Static files fall through (login page assets)
        }
      }
    }

    // Auth page
    if (pathname === "/auth" && req.method === "GET") {
      await this.serveStaticFile(res, "index.html");
      return;
    }

    // Setup page
    if (pathname === "/setup") {
      await this.serveStaticFile(res, "index.html");
      return;
    }

    // Setup info API
    if (pathname === "/api/setup-info" && req.method === "GET") {
      const lanMode = url.searchParams.get("mode") === "lan";
      const host = req.headers.host ?? `localhost:${this.deps.port}`;
      const hostBase = host.replace(/:\d+$/, "");
      const httpsUrl = `https://${hostBase}:${this.deps.port}`;
      const httpUrl = `http://${hostBase}:${this.deps.port}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ httpsUrl, httpUrl, hasCert: this.deps.isTls, lanMode }));
      return;
    }

    // Health check
    if (pathname === "/health" || pathname === "/api/status") {
      const body = this.deps.getHealthResponse
        ? this.deps.getHealthResponse()
        : { ok: true, projects: this.deps.getProjects().length, uptime: process.uptime() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Info endpoint
    if (pathname === "/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: getVersion() }));
      return;
    }

    // Projects list API
    if (pathname === "/api/projects" && req.method === "GET") {
      const dashProjects = this.deps.getProjects().map((p) => ({
        slug: p.slug,
        path: p.directory,
        title: p.title || undefined,
        sessions: 0,
        clients: 0,
        isProcessing: false,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: dashProjects, version: getVersion() }));
      return;
    }

    // Push notification API
    if (await this.handlePushRoutes(pathname, req, res)) {
      return;
    }

    // CA certificate download
    if (pathname === "/ca/download") {
      await this.handleCaDownload(res);
      return;
    }

    // Project routes: /p/{slug}/...
    const projectMatch = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const slug = projectMatch[1];
      const subPath = projectMatch[2] ?? "/";
      const projects = this.deps.getProjects();
      const project = projects.find((p) => p.slug === slug);

      if (!project) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `Project "${slug}" not found` } }));
        return;
      }

      // Project-scoped API
      if (subPath.startsWith("/api/") && this.deps.onProjectApiRequest) {
        if (this.deps.onProjectApiRequest(slug, req, res, subPath.slice(4))) {
          return;
        }
      }

      await this.serveStaticFile(res, "index.html");
      return;
    }

    // Static files
    if (pathname !== "/" && pathname !== "") {
      const served = await this.tryServeStatic(res, pathname.slice(1));
      if (served) return;
    }

    // Root: single project redirect or dashboard
    const projects = this.deps.getProjects();
    if (projects.length === 1) {
      res.writeHead(302, { Location: `/p/${projects[0].slug}/` });
      res.end();
      return;
    }

    // 0 or multiple projects — serve SPA dashboard
    await this.serveStaticFile(res, "index.html");
  }

  // ─── Auth ──────────────────────────────────────────────────────────────

  private async handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let pin: string;

    try {
      const data = JSON.parse(body);
      pin = String(data.pin ?? "");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }));
      return;
    }

    const ip = getClientIp(req);
    const result = this.deps.auth.authenticate(pin, ip);

    if (result.ok) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `relay_session=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true }));
    } else if (result.locked) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, locked: true, retryAfter: result.retryAfter }));
    } else {
      const attemptsLeft = this.deps.auth.getRemainingAttempts(ip);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, attemptsLeft }));
    }
  }

  checkAuth(req: IncomingMessage): boolean {
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionCookie = cookies.relay_session;
    if (sessionCookie && this.deps.auth.validateCookie(sessionCookie)) {
      return true;
    }

    const pinHeader = req.headers["x-relay-pin"];
    if (typeof pinHeader === "string") {
      const ip = getClientIp(req);
      const result = this.deps.auth.authenticate(pinHeader, ip);
      return result.ok;
    }

    return false;
  }

  // ─── Push notification routes ──────────────────────────────────────────

  private async handlePushRoutes(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (pathname === "/api/push/vapid-key" && req.method === "GET") {
      const publicKey = this.deps.pushManager?.getPublicKey();
      if (!publicKey) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_AVAILABLE", message: "Push notifications not available" } }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publicKey }));
      return true;
    }

    if (pathname === "/api/push/subscribe" && req.method === "POST") {
      if (!this.deps.pushManager) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_AVAILABLE", message: "Push notifications not available" } }));
        return true;
      }
      const body = await readBody(req);
      try {
        const { subscription } = JSON.parse(body);
        if (!subscription?.endpoint) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Missing subscription endpoint" } }));
          return true;
        }
        this.deps.pushManager.addSubscription(subscription.endpoint, subscription);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }));
      }
      return true;
    }

    if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
      if (!this.deps.pushManager) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_AVAILABLE", message: "Push notifications not available" } }));
        return true;
      }
      const body = await readBody(req);
      try {
        const { endpoint } = JSON.parse(body);
        if (!endpoint) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Missing endpoint" } }));
          return true;
        }
        this.deps.pushManager.removeSubscription(endpoint);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }));
      }
      return true;
    }

    return false;
  }

  // ─── CA certificate download ───────────────────────────────────────────

  private async handleCaDownload(res: ServerResponse): Promise<void> {
    if (!this.deps.caRootPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "No CA certificate available" } }));
      return;
    }
    try {
      const pem = await readFile(this.deps.caRootPath);
      res.writeHead(200, {
        "Content-Type": "application/x-pem-file",
        "Content-Disposition": 'attachment; filename="opencode-relay-ca.pem"',
        "Content-Length": pem.length,
      });
      res.end(pem);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "CA certificate file not found" } }));
    }
  }

  // ─── Static file serving ───────────────────────────────────────────────

  private async serveStaticFile(res: ServerResponse, filePath: string): Promise<void> {
    if (!filePath || filePath === "") filePath = "index.html";

    const resolved = resolve(this.deps.staticDir, filePath);
    if (!resolved.startsWith(resolve(this.deps.staticDir))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const fileStat = await stat(resolved);
      if (fileStat.isDirectory()) {
        return this.serveStaticFile(res, join(filePath, "index.html"));
      }

      const content = await readFile(resolved);
      const ext = extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const cacheControl =
        filePath.includes(".") && /\.[a-f0-9]{8,}\./.test(filePath)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "Cache-Control": cacheControl,
      });
      res.end(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (filePath !== "index.html") {
          try {
            const indexPath = resolve(this.deps.staticDir, "index.html");
            const content = await readFile(indexPath);
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=0, must-revalidate",
            });
            res.end(content);
            return;
          } catch {
            // index.html also doesn't exist
          }
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      } else {
        throw err;
      }
    }
  }

  private async tryServeStatic(res: ServerResponse, filePath: string): Promise<boolean> {
    const resolved = resolve(this.deps.staticDir, filePath);
    if (!resolved.startsWith(resolve(this.deps.staticDir))) return false;
    try {
      const s = await stat(resolved);
      if (!s.isFile()) return false;
      const content = await readFile(resolved);
      const ext = extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const cacheControl =
        filePath.includes(".") && /\.[a-f0-9]{8,}\./.test(filePath)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": content.length,
        "Cache-Control": cacheControl,
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }
}
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/http-router.test.ts`
Expected: PASS

### Step 5: Commit

```
git add src/lib/http-router.ts test/unit/http-router.test.ts
git commit -m "feat: extract RequestRouter with MIME_TYPES, CORS, and full route handling"
```

---

## Task 2: Add RequestRouter unit tests for auth, routes, and static serving

**Files:**
- Modify: `test/unit/http-router.test.ts`

### Step 1: Add comprehensive route tests

Add test cases covering all routes that the router handles. These tests should exercise `RequestRouter` directly (via a thin HTTP server wrapper), NOT through `RelayServer` or `Daemon`. The existing `server.pbt.test.ts` and `daemon.test.ts` tests serve as integration tests and should continue to pass unchanged.

Test categories to add:

1. **Auth routes:** POST /auth with correct PIN, wrong PIN, invalid JSON, empty body. Auth lockout (429). Auth status endpoint with and without PIN.
2. **Auth gate:** Unauthenticated browser request redirects to /auth. API request returns JSON 401. Cookie auth roundtrip. X-Relay-Pin header auth. Static assets served without auth. authExemptPaths bypasses gate.
3. **Route dispatch:** /health returns health response. /health with custom getHealthResponse. /info returns version. /api/projects returns project list. /setup serves SPA. /api/setup-info returns config.
4. **Project routes:** Known slug serves SPA. Unknown slug returns 404. onProjectApiRequest delegation.
5. **Root routing:** Single project redirects. Zero projects serves SPA. Multiple projects serves SPA.
6. **Static files:** Serves files with correct MIME. Hash-named files get immutable cache. Directory traversal blocked. SPA fallback for unknown paths. 404 when no index.html.
7. **Push API:** vapid-key without pushManager returns 404. subscribe/unsubscribe with and without pushManager.
8. **CA download:** Without caRootPath returns 404. With valid path returns PEM.

### Step 2: Run tests

Run: `pnpm vitest run test/unit/http-router.test.ts`
Expected: PASS

### Step 3: Commit

```
git add test/unit/http-router.test.ts
git commit -m "test: comprehensive RequestRouter unit tests"
```

---

## Task 3: Wire RelayServer to use RequestRouter

**Files:**
- Modify: `src/lib/server.ts`
- Modify: `src/lib/http-router.ts` (if interface adjustments needed)

### Step 1: Run existing server tests as baseline

Run: `pnpm vitest run test/unit/server.pbt.test.ts`
Expected: PASS (all existing tests pass before refactoring)

### Step 2: Refactor RelayServer

Replace the entire `handleRequest`, `handleAuth`, `checkAuth`, `serveStatic` methods and `MIME_TYPES` constant with a `RequestRouter` instance.

The refactored `RelayServer` should:
1. Import `RequestRouter` from `./http-router.js`
2. Remove the local `MIME_TYPES` constant
3. Create a `RequestRouter` in the constructor
4. Delegate `handleRequest` to `this.router.handleRequest(req, res)`
5. Pass `caRootPath: this.tls?.caRoot` and `onProjectApiRequest` to the router
6. Keep: constructor, start/stop, getHttpServer, getUrls, isTls, addProject/removeProject/getProjects, getAuth
7. The `checkAuth` method is still needed externally by `relay-stack.ts` upgrade handler — expose it via `this.router.checkAuth(req)` or keep a thin wrapper

After refactoring, `server.ts` should be approximately 120-150 lines.

### Step 3: Run existing tests to verify nothing broke

Run: `pnpm vitest run test/unit/server.pbt.test.ts`
Expected: PASS (all existing tests still pass)

### Step 4: Run the full unit test suite

Run: `pnpm vitest run`
Expected: PASS

### Step 5: Commit

```
git add src/lib/server.ts src/lib/http-router.ts
git commit -m "refactor: wire RelayServer to delegate HTTP handling to RequestRouter"
```

---

## Task 4: Wire Daemon to use RequestRouter

**Files:**
- Modify: `src/lib/daemon.ts`

### Step 1: Run existing daemon tests as baseline

Run: `pnpm vitest run test/unit/daemon.test.ts`
Expected: PASS

### Step 2: Refactor Daemon

Replace the daemon's `handleRequest`, `handleAuth`, `checkAuth`, `serveStaticFile`, `tryServeStatic` methods and `MIME_TYPES` constant with a `RequestRouter` instance.

The refactored `Daemon` should:
1. Import `RequestRouter` from `./http-router.js`
2. Remove the local `MIME_TYPES` constant (lines 58-74)
3. Remove `handleAuth` (lines 661-704)
4. Remove `checkAuth` (lines 707-722) — but keep a thin wrapper that delegates to `this.router.checkAuth(req)` for the WebSocket upgrade handler (line 229)
5. Remove `handleRequest` (lines 726-1009)
6. Remove `serveStaticFile` (lines 1012-1039)
7. Remove `tryServeStatic` (lines 1043-1069)
8. Create a `RequestRouter` in `start()` with:
   - `auth: this.auth`
   - `staticDir: this.staticDir`
   - `getProjects: () => this.getProjects().map(p => ({ slug: p.slug, directory: p.directory, title: p.title }))`
   - `port: this.port`
   - `isTls: this.tlsEnabled`
   - `pushManager: this.pushManager ?? undefined`
   - `authExemptPaths: ["/setup", "/health", "/api/status"]`
   - `getHealthResponse: () => this.getStatus()`
9. In `startHttpServer`, delegate to `this.router.handleRequest(req, res)`
10. In the upgrade handler (line 229), call `this.router.checkAuth(req)` instead of `this.checkAuth(req)`

After refactoring, `daemon.ts` should be approximately 900-950 lines.

### Step 3: Run existing tests to verify nothing broke

Run: `pnpm vitest run test/unit/daemon.test.ts`
Expected: PASS

### Step 4: Run the full unit test suite

Run: `pnpm vitest run`
Expected: PASS

### Step 5: Commit

```
git add src/lib/daemon.ts
git commit -m "refactor: wire Daemon to delegate HTTP handling to RequestRouter"
```

---

## Task 5: Typecheck and lint

**Files:**
- Possibly: minor fixes across touched files

### Step 1: Run typecheck

Run: `pnpm check`
Expected: PASS (no type errors)

### Step 2: Run linter

Run: `pnpm lint`
Expected: PASS (no lint errors)

### Step 3: Fix any issues found

If typecheck or lint fail, fix the issues.

### Step 4: Commit (if fixes needed)

```
git add -A
git commit -m "fix: resolve type/lint issues from RequestRouter extraction"
```

---

## Task 6: Run full test suite and verify

**Files:** (none — verification only)

### Step 1: Run all unit tests

Run: `pnpm vitest run`
Expected: PASS

### Step 2: Run property-based tests specifically

Run: `pnpm test:pbt`
Expected: PASS

### Step 3: Run integration tests (if OpenCode server available)

Run: `pnpm test:integration` (skip if no OpenCode server running)

### Step 4: Build

Run: `pnpm build`
Expected: PASS

---

## Summary of expected outcomes

| Metric | Before | After |
|---|---|---|
| `server.ts` lines | 664 | ~120-150 |
| `daemon.ts` lines | 1351 | ~900-950 |
| `http-router.ts` lines | (new) | ~350 |
| Duplicated route code | ~400 lines x2 | 0 |
| MIME_TYPES definitions | 2 (diverged) | 1 |
| handleAuth copies | 2 | 1 |
| checkAuth copies | 2 | 1 |
| Push API route copies | 2 | 1 |
| Test files | server.pbt + daemon | server.pbt + daemon + http-router |
