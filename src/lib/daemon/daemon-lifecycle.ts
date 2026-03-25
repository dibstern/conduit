// ─── Daemon Lifecycle (extracted from Daemon) ────────────────────────────────
// Standalone functions for HTTP and IPC server lifecycle management,
// parameterized by a DaemonLifecycleContext so they can be tested and
// composed independently.

import { readFile } from "node:fs/promises";
import {
	createServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
	createServer as createNetServer,
	type Server as NetServer,
	type Socket,
} from "node:net";

import { formatErrorDetail } from "../errors.js";
import { createLogger } from "../logger.js";
import { serveStaticFile, tryServeStatic } from "../server/static-files.js";
import type { SetupInfoResponse } from "../shared-types.js";
import type { DaemonStatus } from "./daemon.js";
import { buildIPCHandlers, type DaemonIPCContext } from "./daemon-ipc.js";
import {
	createCommandRouter,
	parseCommand,
	serializeResponse,
} from "./ipc-protocol.js";
import { removeSocketFile } from "./pid-manager.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 5_000;
const log = createLogger("daemon");

// ─── Context interface ──────────────────────────────────────────────────────
// Mutable context so lifecycle functions can store server references back.

export interface DaemonLifecycleContext {
	port: number;
	host: string;
	httpServer: HttpServer | null;
	/** HTTP-only onboarding server on port+1 (only when TLS is active). */
	onboardingServer: HttpServer | null;
	/**
	 * When protocol detection is active (TLS mode), a net.Server listens on
	 * the port and routes connections. The inner HTTPS server that handles
	 * WebSocket upgrades is stored here. Falls back to httpServer when null.
	 */
	upgradeServer: HttpServer | null;
	ipcServer: NetServer | null;
	ipcClients: Set<Socket>;
	clientCount: number;
	socketPath: string;
	router: {
		handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
	} | null;
	/** When provided, the HTTP server is created as HTTPS with these certs. */
	tls?: { key: Buffer; cert: Buffer };
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

/** Create and start the HTTP(S) server, storing it in ctx.httpServer. */
export function startHttpServer(ctx: DaemonLifecycleContext): Promise<void> {
	return new Promise((resolve, reject) => {
		const handler = (req: IncomingMessage, res: ServerResponse) => {
			// biome-ignore lint/style/noNonNullAssertion: safe — router set before startHttpServer
			ctx.router!.handleRequest(req, res).catch((err) => {
				log.error("Request error:", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "text/plain" });
					res.end("Internal Server Error");
				}
			});
		};

		if (ctx.tls) {
			// ─── TLS mode: protocol detection ─────────────────────────────
			// A net.Server listens on the port. Each connection's first byte
			// is peeked: 0x16 (TLS ClientHello) → HTTPS server, otherwise →
			// plain HTTP redirect to https://.
			const httpsServer = createHttpsServer(
				{ key: ctx.tls.key, cert: ctx.tls.cert },
				handler,
			);
			ctx.upgradeServer = httpsServer;

			// Lightweight HTTP redirect handler for plain-HTTP connections
			const httpRedirect = createServer((req, res) => {
				const host = req.headers.host ?? `localhost:${ctx.port}`;
				const hostBase = host.replace(/:\d+$/, "");
				res.writeHead(301, {
					Location: `https://${hostBase}:${ctx.port}${req.url ?? "/"}`,
				});
				res.end();
			});

			const netServer = createNetServer((socket) => {
				socket.once("readable", () => {
					const buf: Buffer | null = socket.read(1);
					if (buf === null) return;
					socket.unshift(buf);

					if (buf[0] === 0x16) {
						// TLS ClientHello → route to HTTPS
						httpsServer.emit("connection", socket);
					} else {
						// Plain HTTP → route to redirect handler
						httpRedirect.emit("connection", socket);
					}
				});
			});

			// Store the net.Server as httpServer for listen/close/address.
			// The upgrade-capable HTTPS server is in ctx.upgradeServer.
			ctx.httpServer = netServer as unknown as HttpServer;
		} else {
			// ─── Plain HTTP mode ──────────────────────────────────────────
			ctx.httpServer = createServer(handler);
			ctx.upgradeServer = null;
		}

		ctx.httpServer.on("error", (err) => {
			reject(err);
		});

		ctx.httpServer.listen(ctx.port, ctx.host, () => {
			// Resolve actual port (important when port 0 is used for OS-assigned ephemeral port)
			// biome-ignore lint/style/noNonNullAssertion: safe — inside listen callback
			const addr = ctx.httpServer!.address();
			if (addr && typeof addr !== "string") {
				ctx.port = addr.port;
			}
			resolve();
		});
	});
}

/** Gracefully close the HTTP server. */
export function closeHttpServer(ctx: DaemonLifecycleContext): Promise<void> {
	return new Promise((resolve) => {
		if (!ctx.httpServer) {
			resolve();
			return;
		}

		const timeout = setTimeout(() => {
			resolve();
		}, SHUTDOWN_TIMEOUT_MS);

		ctx.httpServer.close(() => {
			clearTimeout(timeout);
			ctx.httpServer = null;
			resolve();
		});
	});
}

// ─── Onboarding Server (HTTP-only, port+1) ─────────────────────────────────

export interface OnboardingServerDeps {
	caRootPath: string | null;
	/** Pre-converted DER-encoded CA cert for iOS-friendly download. */
	caCertDer: Buffer | null;
	staticDir: string;
}

/**
 * Start an HTTP-only onboarding server on ctx.port + 1.
 * Only call when ctx.tls is present (TLS active).
 *
 * Serves: /ca/download, /setup (index.html), /api/setup-info, SPA static assets.
 * Everything else 302-redirects to the HTTPS main server.
 */
export function startOnboardingServer(
	ctx: DaemonLifecycleContext,
	deps: OnboardingServerDeps,
): Promise<void> {
	// Only start when TLS is active
	if (!ctx.tls) {
		return Promise.resolve();
	}

	// When ctx.port is 0 (OS-assigned), also use 0 for the onboarding server
	// so it gets its own ephemeral port. Otherwise use port+1.
	const listenPort = ctx.port === 0 ? 0 : ctx.port + 1;

	// Resolved after listen — may differ from listenPort when 0 is used.
	let actualPort = listenPort;

	// Pre-read CA cert (if available) so we don't hit disk per request.
	// DER format preferred (passed in from ensureCerts), PEM as fallback.
	const caCertDer = deps.caCertDer;
	let caCertPem: Buffer | null = null;
	const loadCaCert = deps.caRootPath
		? readFile(deps.caRootPath)
				.then((buf) => {
					caCertPem = buf;
				})
				.catch(() => {
					log.warn("Onboarding server: CA cert file not readable");
				})
		: Promise.resolve();

	return loadCaCert.then(
		() =>
			new Promise<void>((resolve, reject) => {
				const server = createServer(async (req, res) => {
					const url = new URL(
						req.url ?? "/",
						`http://${req.headers.host ?? "localhost"}`,
					);
					const pathname = url.pathname;

					try {
						// ─── /ca/download ───────────────────────────────────
						// Serve DER-encoded .cer with application/x-x509-ca-cert
						// for reliable iOS profile installation. Falls back to PEM.
						if (pathname === "/ca/download" && req.method === "GET") {
							if (caCertDer) {
								res.writeHead(200, {
									"Content-Type": "application/x-x509-ca-cert",
									"Content-Disposition":
										'attachment; filename="conduit-ca.cer"',
									"Content-Length": caCertDer.length,
								});
								res.end(caCertDer);
								return;
							}
							if (caCertPem) {
								res.writeHead(200, {
									"Content-Type": "application/x-pem-file",
									"Content-Disposition":
										'attachment; filename="conduit-ca.pem"',
									"Content-Length": caCertPem.length,
								});
								res.end(caCertPem);
								return;
							}
							res.writeHead(404, {
								"Content-Type": "application/json",
							});
							res.end(
								JSON.stringify({
									error: {
										code: "NOT_FOUND",
										message: "No CA certificate available",
									},
								}),
							);
							return;
						}

						// ─── /setup ─────────────────────────────────────────
						if (pathname === "/setup" && req.method === "GET") {
							await serveStaticFile(deps.staticDir, res, "index.html");
							return;
						}

						// ─── /api/setup-info ────────────────────────────────
						if (pathname === "/api/setup-info" && req.method === "GET") {
							const lanMode = url.searchParams.get("mode") === "lan";
							const host = req.headers.host ?? `localhost:${actualPort}`;
							const hostBase = host.replace(/:\d+$/, "");
							// httpsUrl uses the MAIN port, httpUrl uses the ONBOARDING port
							const httpsUrl = `https://${hostBase}:${ctx.port}`;
							const httpUrl = `http://${hostBase}:${actualPort}`;
							res.writeHead(200, {
								"Content-Type": "application/json",
							});
							res.end(
								JSON.stringify({
									httpsUrl,
									httpUrl,
									hasCert: true,
									lanMode,
								} satisfies SetupInfoResponse),
							);
							return;
						}

						// ─── Static assets (JS, CSS, etc. for SPA) ─────────
						const filePath = pathname.startsWith("/")
							? pathname.slice(1)
							: pathname;
						if (
							filePath &&
							(await tryServeStatic(deps.staticDir, res, filePath))
						) {
							return;
						}

						// ─── Catch-all: 302 redirect to HTTPS /setup ───────
						const redirectHost = req.headers.host ?? `localhost:${actualPort}`;
						const redirectHostBase = redirectHost.replace(/:\d+$/, "");
						res.writeHead(302, {
							Location: `https://${redirectHostBase}:${ctx.port}/setup`,
						});
						res.end();
					} catch (err) {
						log.error("Onboarding server request error:", err);
						if (!res.headersSent) {
							res.writeHead(500, {
								"Content-Type": "text/plain",
							});
							res.end("Internal Server Error");
						}
					}
				});

				server.on("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE") {
						log.warn(
							`Onboarding server: port ${listenPort} already in use — skipping`,
						);
						server.close();
						resolve();
						return;
					}
					reject(err);
				});

				server.listen(listenPort, ctx.host, () => {
					// Resolve actual port (important when listenPort is 0)
					const addr = server.address();
					if (addr && typeof addr !== "string") {
						actualPort = addr.port;
					}
					ctx.onboardingServer = server;
					log.info(
						`Onboarding HTTP server listening on ${ctx.host}:${actualPort}`,
					);
					resolve();
				});
			}),
	);
}

/** Gracefully close the onboarding server. */
export function closeOnboardingServer(
	ctx: DaemonLifecycleContext,
): Promise<void> {
	return new Promise((resolve) => {
		if (!ctx.onboardingServer) {
			resolve();
			return;
		}

		const timeout = setTimeout(() => {
			resolve();
		}, SHUTDOWN_TIMEOUT_MS);

		ctx.onboardingServer.close(() => {
			clearTimeout(timeout);
			ctx.onboardingServer = null;
			resolve();
		});
	});
}

// ─── IPC Server ─────────────────────────────────────────────────────────────

/** Create and start the IPC (Unix socket) server with command routing. */
export function startIPCServer(
	ctx: DaemonLifecycleContext,
	ipcContext: DaemonIPCContext,
	getStatus: () => DaemonStatus,
): Promise<void> {
	return new Promise((resolve, reject) => {
		// Remove stale socket file if it exists
		removeSocketFile(ctx.socketPath);

		const handlers = buildIPCHandlers(ipcContext, getStatus);
		const router = createCommandRouter(handlers);

		ctx.ipcServer = createNetServer((socket: Socket) => {
			ctx.ipcClients.add(socket);
			ctx.clientCount++;

			let buffer = "";
			let cleaned = false;

			const cleanup = () => {
				if (cleaned) return;
				cleaned = true;
				ctx.ipcClients.delete(socket);
				ctx.clientCount--;
			};

			socket.on("data", async (chunk: Buffer) => {
				buffer += chunk.toString("utf-8");

				// Process complete lines (JSON-lines protocol)
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);

					if (line.length === 0) continue;

					const cmd = parseCommand(line);
					if (!cmd) {
						const errResponse = serializeResponse({
							ok: false,
							error: "Invalid JSON",
						});
						socket.write(errResponse);
						continue;
					}

					const ipcT0 = Date.now();
					try {
						const response = await router(cmd);
						const ipcMs = Date.now() - ipcT0;
						if (ipcMs > 100) {
							log.warn(`[ipc] ${cmd.cmd} took ${ipcMs}ms`);
						} else {
							log.debug(`[ipc] ${cmd.cmd} ${ipcMs}ms`);
						}
						socket.write(serializeResponse(response));
					} catch (err) {
						const ipcMs = Date.now() - ipcT0;
						log.warn(
							`[ipc] ${cmd.cmd} failed after ${ipcMs}ms: ${formatErrorDetail(err)}`,
						);
						socket.write(
							serializeResponse({
								ok: false,
								error: formatErrorDetail(err),
							}),
						);
					}
				}
			});

			socket.on("close", () => {
				cleanup();
			});

			socket.on("error", () => {
				cleanup();
			});
		});

		ctx.ipcServer.on("error", (err) => {
			reject(err);
		});

		ctx.ipcServer.listen(ctx.socketPath, () => {
			resolve();
		});
	});
}

/** Close the IPC server. */
export function closeIPCServer(ctx: DaemonLifecycleContext): Promise<void> {
	return new Promise((resolve) => {
		if (!ctx.ipcServer) {
			resolve();
			return;
		}

		ctx.ipcServer.close(() => {
			ctx.ipcServer = null;
			resolve();
		});
	});
}
