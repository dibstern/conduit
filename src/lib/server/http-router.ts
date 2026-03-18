// ─── HTTP Request Router ─────────────────────────────────────────────────────
// Unified HTTP request handling extracted from server.ts and daemon.ts.
// Owns: CORS headers, auth endpoints, auth gate, route dispatch (health, info,
// setup, projects, push APIs, CA download, project routes, root/dashboard),
// and static file serving.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthManager } from "../auth.js";
import { createLogger } from "../logger.js";
import type {
	ApiError,
	AuthResponse,
	AuthStatusResponse,
	DashboardProjectResponse,
	HealthResponse,
	InfoResponse,
	ProjectStatusResponse,
	ProjectsListResponse,
	PushOkResponse,
	SetupInfoResponse,
	ThemesResponse,
	VapidKeyResponse,
} from "../shared-types.js";
import { getVersion } from "../version.js";
import { getClientIp, parseCookies, readBody } from "./http-utils.js";
import type { PushNotificationManager } from "./push.js";
import { serveStaticFile, tryServeStatic } from "./static-files.js";

const log = createLogger("router");

// ─── MIME types ──────────────────────────────────────────────────────────────

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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouterProject {
	slug: string;
	directory: string;
	title: string;
	status?: "registering" | "ready" | "error";
	/** Error message when status is "error". */
	error?: string;
	/** Connected browser clients for this project. */
	clients?: number;
	/** Cached session count for this project. */
	sessions?: number;
	/** True when at least one session is busy or retrying. */
	isProcessing?: boolean;
}

export interface RequestRouterDeps {
	auth: AuthManager;
	staticDir: string;
	getProjects: () => RouterProject[];
	port: number;
	isTls: boolean;
	pushManager?: PushNotificationManager;
	/** Paths exempt from the auth gate (e.g. daemon uses ["/setup", "/health", "/api/status"]) */
	authExemptPaths?: string[];
	/** Custom health response — daemon returns getStatus() */
	getHealthResponse?: () => object;
	/** Delegate project API requests — server uses project.onApiRequest */
	onProjectApiRequest?: (
		slug: string,
		req: IncomingMessage,
		res: ServerResponse,
		subPath: string,
	) => boolean;
	/** Path to CA root certificate for /ca/download */
	caRootPath?: string;
}

/** Serialize a RouterProject to the dashboard API shape. */
function serializeProject(p: RouterProject): DashboardProjectResponse {
	return {
		slug: p.slug,
		path: p.directory,
		title: p.title || "",
		status: p.status ?? "ready",
		...(p.error != null && { error: p.error }),
		sessions: p.sessions ?? 0,
		clients: p.clients ?? 0,
		isProcessing: p.isProcessing ?? false,
	};
}

// ─── RequestRouter ───────────────────────────────────────────────────────────

export class RequestRouter {
	private readonly auth: AuthManager;
	private readonly staticDir: string;
	private readonly getProjects: () => RouterProject[];
	private readonly port: number;
	private readonly isTls: boolean;
	private readonly pushManager?: PushNotificationManager;
	private readonly authExemptPaths: string[];
	private readonly getHealthResponse?: () => object;
	private readonly onProjectApiRequest?: RequestRouterDeps["onProjectApiRequest"];
	private readonly caRootPath?: string;

	constructor(deps: RequestRouterDeps) {
		this.auth = deps.auth;
		this.staticDir = deps.staticDir;
		this.getProjects = deps.getProjects;
		this.port = deps.port;
		this.isTls = deps.isTls;
		if (deps.pushManager != null) this.pushManager = deps.pushManager;
		this.authExemptPaths = deps.authExemptPaths ?? [];
		if (deps.getHealthResponse != null)
			this.getHealthResponse = deps.getHealthResponse;
		this.onProjectApiRequest = deps.onProjectApiRequest;
		if (deps.caRootPath != null) this.caRootPath = deps.caRootPath;
	}

	// ─── Main entry point ────────────────────────────────────────────────

	async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(
			req.url ?? "/",
			`http://${req.headers.host ?? "localhost"}`,
		);
		const pathname = url.pathname;

		try {
			// CORS headers on every response
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader(
				"Access-Control-Allow-Methods",
				"GET, POST, PATCH, DELETE, OPTIONS",
			);
			res.setHeader(
				"Access-Control-Allow-Headers",
				"Content-Type, Authorization, X-Relay-Pin",
			);

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			// ─── Auth endpoint (always accessible) ──────────────────────
			if (pathname === "/auth" && req.method === "POST") {
				await this.handleAuth(req, res);
				return;
			}

			// ─── Auth status API (before auth gate — tells client if auth is needed) ──
			if (pathname === "/api/auth/status" && req.method === "GET") {
				const hasPin = this.auth.hasPin();
				const authenticated = hasPin ? this.checkAuth(req) : true;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						hasPin,
						authenticated,
					} satisfies AuthStatusResponse),
				);
				return;
			}

			// ─── Auth gate (if PIN is set) ──────────────────────────────
			if (this.auth.hasPin()) {
				const authed = this.checkAuth(req);
				if (!authed) {
					const isExempt = this.authExemptPaths.includes(pathname);
					if (!isExempt) {
						const isProjectApiRoute = /^\/p\/[^/]+\/api\//.test(pathname);
						const isBrowserRoute =
							!isProjectApiRoute &&
							(pathname === "/" ||
								pathname === "" ||
								pathname === "/auth" ||
								pathname.startsWith("/p/"));
						const isApiRoute =
							pathname.startsWith("/api/") || isProjectApiRoute;
						const hasPinHeader = req.headers["x-relay-pin"] !== undefined;

						if (isApiRoute || hasPinHeader) {
							res.writeHead(401, {
								"Content-Type": "application/json",
							});
							res.end(
								JSON.stringify({
									error: {
										code: "AUTH_REQUIRED",
										message: "PIN required",
									},
								} satisfies ApiError),
							);
							return;
						}
						if (isBrowserRoute) {
							if (pathname !== "/auth") {
								res.writeHead(302, { Location: "/auth" });
								res.end();
								return;
							}
							// /auth itself serves the Svelte SPA
							await this.serveStaticFile(res, "index.html");
							return;
						}
						// Static files fall through so the login page can load assets
					}
				}
			}

			// ─── Auth page (GET /auth — serves Svelte PinPage) ──────────
			if (pathname === "/auth" && req.method === "GET") {
				await this.serveStaticFile(res, "index.html");
				return;
			}

			// ─── Setup page (serves Svelte SetupPage) ───────────────────
			if (pathname === "/setup") {
				await this.serveStaticFile(res, "index.html");
				return;
			}

			// ─── Setup info API ─────────────────────────────────────────
			if (pathname === "/api/setup-info" && req.method === "GET") {
				const lanMode = url.searchParams.get("mode") === "lan";
				const host = req.headers.host ?? `localhost:${this.port}`;
				const hostBase = host.replace(/:\d+$/, "");
				const httpsUrl = `https://${hostBase}:${this.port}`;
				const httpUrl = `http://${hostBase}:${this.port}`;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						httpsUrl,
						httpUrl,
						hasCert: this.isTls,
						lanMode,
					} satisfies SetupInfoResponse),
				);
				return;
			}

			// ─── Health check (/health and /api/status) ─────────────────
			if (pathname === "/health" || pathname === "/api/status") {
				const body = this.getHealthResponse
					? this.getHealthResponse()
					: ({
							ok: true,
							projects: this.getProjects().length,
							uptime: process.uptime(),
						} satisfies HealthResponse);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
				return;
			}

			// ─── Info endpoint ───────────────────────────────────────────
			if (pathname === "/info") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ version: getVersion() } satisfies InfoResponse),
				);
				return;
			}

			// ─── Theme list API ─────────────────────────────────────────
			if (pathname === "/api/themes" && req.method === "GET") {
				try {
					const { loadThemeFiles } = await import("./theme-loader.js");
					const themes: ThemesResponse = await loadThemeFiles();
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(themes));
				} catch {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								code: "THEME_LOAD_FAILED",
								message: "Failed to load themes",
							},
						} satisfies ApiError),
					);
				}
				return;
			}

			// ─── Projects list API ──────────────────────────────────────
			if (pathname === "/api/projects" && req.method === "GET") {
				const projects = this.getProjects();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						projects: projects.map(serializeProject),
						version: getVersion(),
					} satisfies ProjectsListResponse),
				);
				return;
			}

			// ─── Push notification API ──────────────────────────────────
			if (await this.handlePushRoutes(pathname, req, res)) {
				return;
			}

			// ─── CA certificate download ────────────────────────────────
			if (pathname === "/ca/download") {
				await this.handleCaDownload(res);
				return;
			}

			// ─── Project routes: /p/{slug}/... ──────────────────────────
			const projectMatch = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
			if (projectMatch) {
				const slug = projectMatch[1];
				const subPath = projectMatch[2] ?? "/";
				const projects = this.getProjects();
				const project = projects.find((p) => p.slug === slug);

				if (!project) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								code: "NOT_FOUND",
								message: `Project "${slug}" not found`,
							},
						} satisfies ApiError),
					);
					return;
				}

				// ─── Per-project status API ─────────────────────────
				if (subPath === "/api/status" && req.method === "GET") {
					// Auth gate — return JSON 401, not 302 redirect
					if (this.auth.hasPin() && !this.checkAuth(req)) {
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(
							JSON.stringify({
								error: {
									code: "AUTH_REQUIRED",
									message: "PIN required",
								},
							} satisfies ApiError),
						);
						return;
					}
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							status: project.status ?? "ready",
							...(project.error != null && { error: project.error }),
						} satisfies ProjectStatusResponse),
					);
					return;
				}

				// API sub-routes — delegate if handler provided
				if (subPath.startsWith("/api/") && this.onProjectApiRequest) {
					const handled = this.onProjectApiRequest(
						// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
						slug!,
						req,
						res,
						subPath.slice(4),
					);
					if (handled) return;
				}

				// Serve index.html for SPA routes
				await this.serveStaticFile(res, "index.html");
				return;
			}

			// ─── Static files ───────────────────────────────────────────
			if (pathname !== "/" && pathname !== "") {
				const served = await this.tryServeStatic(res, pathname.slice(1));
				if (served) return;
			}

			// ─── Root: single-project redirect or dashboard ─────────────
			const projects = this.getProjects();
			if (projects.length === 1) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				const slug = projects[0]!.slug;
				res.writeHead(302, { Location: `/p/${slug}/` });
				res.end();
				return;
			}

			// 0 or multiple projects — serve Svelte dashboard
			await this.serveStaticFile(res, "index.html");
		} catch (err) {
			log.error("Request error:", err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: {
							code: "INTERNAL_ERROR",
							message: "Internal server error",
						},
					} satisfies ApiError),
				);
			}
		}
	}

	// ─── Auth (public — needed by WS upgrade handlers) ──────────────────

	checkAuth(req: IncomingMessage): boolean {
		// Check cookie
		const cookies = parseCookies(req.headers.cookie ?? "");
		const sessionCookie = cookies["relay_session"];
		if (sessionCookie && this.auth.validateCookie(sessionCookie)) {
			return true;
		}

		// Check X-Relay-Pin header
		const pinHeader = req.headers["x-relay-pin"];
		if (typeof pinHeader === "string") {
			const ip = getClientIp(req);
			const result = this.auth.authenticate(pinHeader, ip);
			return result.ok;
		}

		return false;
	}

	// ─── Private: Auth handler ──────────────────────────────────────────

	private async handleAuth(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const body = await readBody(req);
		let pin: string;

		try {
			const data = JSON.parse(body);
			pin = String(data.pin ?? "");
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: { code: "BAD_REQUEST", message: "Invalid JSON" },
				} satisfies ApiError),
			);
			return;
		}

		const ip = getClientIp(req);
		const result = this.auth.authenticate(pin, ip);

		// TODO(B10): Auth error responses use { ok, locked, retryAfter } / { ok, attemptsLeft }
		// shape, inconsistent with the standard { error: { code, message } } used elsewhere.
		// Unifying requires a breaking API change. Track in a future API versioning pass.
		if (result.ok) {
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Set-Cookie": `relay_session=${result.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
			});
			res.end(JSON.stringify({ ok: true } satisfies AuthResponse));
		} else if (result.locked) {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					ok: false,
					locked: true,
					retryAfter: result.retryAfter ?? 0,
				} satisfies AuthResponse),
			);
		} else {
			const attemptsLeft = this.auth.getRemainingAttempts(ip);
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ ok: false, attemptsLeft } satisfies AuthResponse),
			);
		}
	}

	// ─── Private: Push notification routes ──────────────────────────────
	// Returns true if the route was handled (caller should return), false otherwise.

	private async handlePushRoutes(
		pathname: string,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<boolean> {
		if (pathname === "/api/push/vapid-key" && req.method === "GET") {
			const publicKey = this.pushManager?.getPublicKey();
			if (!publicKey) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: {
							code: "NOT_AVAILABLE",
							message: "Push notifications not available",
						},
					} satisfies ApiError),
				);
			} else {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ publicKey } satisfies VapidKeyResponse));
			}
			return true;
		}

		if (pathname === "/api/push/subscribe" && req.method === "POST") {
			if (!this.pushManager) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: {
							code: "NOT_AVAILABLE",
							message: "Push notifications not available",
						},
					} satisfies ApiError),
				);
				return true;
			}
			const body = await readBody(req);
			try {
				const { subscription } = JSON.parse(body);
				if (!subscription?.endpoint) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								code: "BAD_REQUEST",
								message: "Missing subscription endpoint",
							},
						} satisfies ApiError),
					);
					return true;
				}
				this.pushManager.addSubscription(subscription.endpoint, subscription);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true } satisfies PushOkResponse));
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: { code: "BAD_REQUEST", message: "Invalid JSON" },
					} satisfies ApiError),
				);
			}
			return true;
		}

		if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
			if (!this.pushManager) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: {
							code: "NOT_AVAILABLE",
							message: "Push notifications not available",
						},
					} satisfies ApiError),
				);
				return true;
			}
			const body = await readBody(req);
			try {
				const { endpoint } = JSON.parse(body);
				if (!endpoint) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								code: "BAD_REQUEST",
								message: "Missing endpoint",
							},
						} satisfies ApiError),
					);
					return true;
				}
				this.pushManager.removeSubscription(endpoint);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true } satisfies PushOkResponse));
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: { code: "BAD_REQUEST", message: "Invalid JSON" },
					} satisfies ApiError),
				);
			}
			return true;
		}

		return false;
	}

	// ─── Private: CA certificate download ───────────────────────────────

	private async handleCaDownload(res: ServerResponse): Promise<void> {
		if (!this.caRootPath) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						code: "NOT_FOUND",
						message: "No CA certificate available",
					},
				} satisfies ApiError),
			);
			return;
		}
		try {
			const pem = await readFile(this.caRootPath);
			res.writeHead(200, {
				"Content-Type": "application/x-pem-file",
				"Content-Disposition": 'attachment; filename="opencode-relay-ca.pem"',
				"Content-Length": pem.length,
			});
			res.end(pem);
		} catch (err) {
			log.warn(
				{ path: this.caRootPath, error: err },
				"Failed to read CA certificate file",
			);
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						code: "NOT_FOUND",
						message: "CA certificate file not found",
					},
				} satisfies ApiError),
			);
		}
	}

	// ─── Private: Static file serving ───────────────────────────────────

	/** Delegates to the extracted static-files module. */
	private async serveStaticFile(
		res: ServerResponse,
		filePath: string,
	): Promise<void> {
		return serveStaticFile(this.staticDir, res, filePath);
	}

	/** Delegates to the extracted static-files module. */
	private async tryServeStatic(
		res: ServerResponse,
		filePath: string,
	): Promise<boolean> {
		return tryServeStatic(this.staticDir, res, filePath);
	}
}
