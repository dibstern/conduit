// ─── HTTP Server (Ticket 2.1) ────────────────────────────────────────────────
// Main HTTP server: serves frontend assets, handles PIN auth, routes projects,
// upgrades WebSocket connections. Delegates all HTTP routing to RequestRouter.

import { existsSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthManager } from "../auth.js";
import { ENV } from "../env.js";
import { RequestRouter } from "./http-router.js";
import type { PushNotificationManager } from "./push.js";

/**
 * Default frontend directory resolved relative to this file.
 * Compiled: dist/src/lib/server/server.js → 3×.. → dist/ → dist/frontend/
 * Dev (tsx): src/lib/server/server.ts → 3×.. → repo root → frontend/ (doesn't exist)
 * Falls back to cwd-based resolution for dev mode.
 */
const _candidate = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"frontend",
);
const DEFAULT_STATIC_DIR = existsSync(_candidate)
	? _candidate
	: join(process.cwd(), "dist", "frontend");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelayServerOptions {
	port?: number;
	host?: string;
	staticDir?: string;
	pin?: string;
	tls?: { key: Buffer; cert: Buffer; caRoot?: string };
	/** Optional push notification manager for push API routes */
	pushManager?: PushNotificationManager;
}

export interface ProjectEntry {
	slug: string;
	directory: string;
	title: string;
	/** Called when this project gets a WebSocket upgrade */
	onUpgrade?: (req: IncomingMessage, socket: unknown, head: Buffer) => void;
	/** Called for API requests under this project */
	onApiRequest?: (
		req: IncomingMessage,
		res: ServerResponse,
		path: string,
	) => void;
	/** Get connected browser client count for this project. */
	getClientCount?: () => number;
	/** Get cached session count for this project. */
	getSessionCount?: () => number;
	/** Check if any session in this project is currently processing. */
	getIsProcessing?: () => boolean;
}

export interface ServerUrls {
	local: string;
	network: string[];
}

// ─── Server ──────────────────────────────────────────────────────────────────

export class RelayServer {
	private server: Server | null = null;
	private readonly port: number;
	private readonly host: string;
	private readonly auth: AuthManager;
	private readonly projects: Map<string, ProjectEntry> = new Map();
	private readonly tls?: { key: Buffer; cert: Buffer; caRoot?: string };
	private readonly protocol: "https" | "http";
	private readonly router: RequestRouter;

	constructor(options: RelayServerOptions = {}) {
		this.port = options.port ?? 2633;
		this.host = options.host ?? ENV.host;
		this.auth = new AuthManager();
		if (options.tls != null) this.tls = options.tls;
		this.protocol = this.tls ? "https" : "http";

		if (options.pin) {
			this.auth.setPin(options.pin);
		}

		const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;

		this.router = new RequestRouter({
			auth: this.auth,
			staticDir,
			getProjects: () =>
				Array.from(this.projects.values()).map((p) => ({
					slug: p.slug,
					directory: p.directory,
					title: p.title,
					clients: p.getClientCount?.() ?? 0,
					sessions: p.getSessionCount?.() ?? 0,
					isProcessing: p.getIsProcessing?.() ?? false,
				})),
			port: this.port,
			isTls: this.protocol === "https",
			...(options.pushManager != null && {
				pushManager: options.pushManager,
			}),
			...(this.tls?.caRoot != null && { caRootPath: this.tls.caRoot }),
			onProjectApiRequest: (slug, req, res, subPath) => {
				const project = this.projects.get(slug);
				if (project?.onApiRequest) {
					project.onApiRequest(req, res, subPath);
					return true;
				}
				return false;
			},
		});
	}

	/** Register a project for slug-based routing */
	addProject(project: ProjectEntry): void {
		this.projects.set(project.slug, project);
	}

	/** Remove a project */
	removeProject(slug: string): boolean {
		return this.projects.delete(slug);
	}

	/** Get all registered projects */
	getProjects(): ProjectEntry[] {
		return Array.from(this.projects.values());
	}

	/** Get the auth manager (for external PIN management) */
	getAuth(): AuthManager {
		return this.auth;
	}

	/** Get the request router (for external checkAuth access) */
	getRouter(): RequestRouter {
		return this.router;
	}

	/** Returns true when the server is configured to use TLS */
	isTls(): boolean {
		return this.protocol === "https";
	}

	/** Start the server */
	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const handler = (req: IncomingMessage, res: ServerResponse) =>
				this.router.handleRequest(req, res);

			this.server = this.tls
				? createHttpsServer({ key: this.tls.key, cert: this.tls.cert }, handler)
				: createServer(handler);

			this.server.on("error", (err) => {
				reject(err);
			});

			this.server.listen(this.port, this.host, () => {
				resolve();
			});
		});
	}

	/** Stop the server */
	async stop(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close(() => {
				this.server = null;
				resolve();
			});
		});
	}

	/** Get the underlying HTTP server (for WebSocket upgrade) */
	getHttpServer(): Server | null {
		return this.server;
	}

	/** Get server URLs */
	getUrls(): ServerUrls {
		const local = `${this.protocol}://localhost:${this.port}`;
		const network: string[] = [];

		const ifaces = networkInterfaces();
		for (const entries of Object.values(ifaces)) {
			if (!entries) continue;
			for (const entry of entries) {
				if (entry.family === "IPv4" && !entry.internal) {
					network.push(`${this.protocol}://${entry.address}:${this.port}`);
				}
			}
		}

		return { local, network };
	}
}
