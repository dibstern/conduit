// Daemon Lifecycle (extracted from Daemon)
// Standalone functions for HTTP server lifecycle management,
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
import { createServer as createNetServer, type Socket } from "node:net";
import { createLogger } from "../logger.js";
import { serveStaticFile, tryServeStatic } from "../server/static-files.js";
import type { SetupInfoResponse } from "../shared-types.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;
const log = createLogger("daemon");

// Mutable context so lifecycle functions can store server references back.

export interface DaemonLifecycleContext {
	httpServer: HttpServer | null;
	/** HTTP-only onboarding server on port+1 (only when TLS is active). */
	onboardingServer: HttpServer | null;
	/**
	 * When protocol detection is active (TLS mode), a net.Server listens on
	 * the port and routes connections. The inner HTTPS server that handles
	 * WebSocket upgrades is stored here. Falls back to httpServer when null.
	 */
	upgradeServer: HttpServer | null;
	clientCount: number;
	socketPath: string;
	router: {
		handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
	} | null;
}

export interface HttpServerStartConfig {
	port: number;
	host: string;
	tls?: { key: Buffer; cert: Buffer };
}

/** Create and start the HTTP(S) server, storing it in ctx.httpServer. */
export function startHttpServer(
	ctx: DaemonLifecycleContext,
	config: HttpServerStartConfig,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let actualPort = config.port;
		const handler = (req: IncomingMessage, res: ServerResponse) => {
			const router = ctx.router;
			if (!router) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
				return;
			}
			router.handleRequest(req, res).catch((err) => {
				log.error("Request error:", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "text/plain" });
					res.end("Internal Server Error");
				}
			});
		};

		if (config.tls) {
			// A net.Server listens on the port. Each connection's first byte
			// is peeked: 0x16 (TLS ClientHello) → HTTPS server, otherwise →
			// plain HTTP redirect to https://.
			const httpsServer = createHttpsServer(
				{ key: config.tls.key, cert: config.tls.cert },
				handler,
			);
			ctx.upgradeServer = httpsServer;

			// Lightweight HTTP redirect handler for plain-HTTP connections
			const httpRedirect = createServer((req, res) => {
				const host = req.headers.host ?? `localhost:${actualPort}`;
				const hostBase = host.replace(/:\d+$/, "");
				res.writeHead(301, {
					Location: `https://${hostBase}:${actualPort}${req.url ?? "/"}`,
				});
				res.end();
			});

			// net.Server has no closeAllConnections, and the HTTPS server's own
			// closeAllConnections cannot reach the raw sockets handed to it, so an
			// idle keep-alive connection would hold close() open until the client
			// hung up (or SHUTDOWN_TIMEOUT_MS). Track the raw sockets and destroy
			// them ourselves.
			const rawSockets = new Set<Socket>();
			const netServer = createNetServer((socket) => {
				rawSockets.add(socket);
				socket.once("close", () => rawSockets.delete(socket));
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
			ctx.httpServer = Object.assign(netServer, {
				closeAllConnections: () => {
					for (const socket of rawSockets) socket.destroy();
				},
			}) as unknown as HttpServer;
		} else {
			ctx.httpServer = createServer(handler);
			ctx.upgradeServer = null;
		}

		const httpServer = ctx.httpServer;
		if (!httpServer) return;
		httpServer.on("error", (err) => {
			reject(err);
		});

		httpServer.listen(config.port, config.host, () => {
			// Resolve actual port (important when port 0 is used for OS-assigned ephemeral port)
			const addr = httpServer.address();
			if (addr && typeof addr !== "string") {
				actualPort = addr.port;
			}
			resolve(actualPort);
		});
	});
}

function closeServerHandle(server: HttpServer): Promise<void> {
	return new Promise((resolve) => {
		try {
			server.closeIdleConnections?.();
			server.closeAllConnections?.();
		} catch {
			// Best-effort drain before close.
		}

		if (!server.listening) {
			resolve();
			return;
		}

		const timeout = setTimeout(() => {
			resolve();
		}, SHUTDOWN_TIMEOUT_MS);

		try {
			server.close(() => {
				clearTimeout(timeout);
				resolve();
			});
		} catch {
			clearTimeout(timeout);
			resolve();
		}
	});
}

/** Gracefully close the HTTP server. */
export function closeHttpServer(ctx: DaemonLifecycleContext): Promise<void> {
	return new Promise((resolve) => {
		const httpServer = ctx.httpServer;
		const upgradeServer = ctx.upgradeServer;
		if (!httpServer && !upgradeServer) {
			resolve();
			return;
		}

		const closes = [
			httpServer ? closeServerHandle(httpServer) : Promise.resolve(),
			upgradeServer && upgradeServer !== httpServer
				? closeServerHandle(upgradeServer)
				: Promise.resolve(),
		];
		Promise.all(closes).then(() => {
			ctx.httpServer = null;
			ctx.upgradeServer = null;
			resolve();
		});
	});
}

// Onboarding Server (HTTP-only, port+1)

export interface OnboardingServerDeps {
	caRootPath: string | null;
	/** Pre-converted DER-encoded CA cert for iOS-friendly download. */
	caCertDer: Buffer | null;
	staticDir: string;
}

export interface OnboardingServerStartConfig {
	/** Main HTTPS port used in redirect/setup URLs. */
	httpsPort: number;
	/** Onboarding listen port, usually httpsPort + 1, or 0 for OS assignment. */
	listenPort: number;
	host: string;
}

/**
 * Start an HTTP-only onboarding server.
 *
 * Serves: /ca/download, /setup (index.html), /api/setup-info, SPA static assets.
 * Everything else 302-redirects to the HTTPS main server.
 */
export function startOnboardingServer(
	ctx: DaemonLifecycleContext,
	deps: OnboardingServerDeps,
	config: OnboardingServerStartConfig,
): Promise<void> {
	// Resolved after listen — may differ from listenPort when 0 is used.
	let actualPort = config.listenPort;

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

						if (pathname === "/setup" && req.method === "GET") {
							await serveStaticFile(deps.staticDir, res, "index.html");
							return;
						}

						if (pathname === "/api/setup-info" && req.method === "GET") {
							const lanMode = url.searchParams.get("mode") === "lan";
							const host = req.headers.host ?? `localhost:${actualPort}`;
							const hostBase = host.replace(/:\d+$/, "");
							// httpsUrl uses the MAIN port, httpUrl uses the ONBOARDING port
							const httpsUrl = `https://${hostBase}:${config.httpsPort}`;
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
									publicUrl: null,
								} satisfies SetupInfoResponse),
							);
							return;
						}

						// Static assets (JS, CSS, etc. for SPA)
						const filePath = pathname.startsWith("/")
							? pathname.slice(1)
							: pathname;
						if (
							filePath &&
							(await tryServeStatic(deps.staticDir, res, filePath))
						) {
							return;
						}

						const redirectHost = req.headers.host ?? `localhost:${actualPort}`;
						const redirectHostBase = redirectHost.replace(/:\d+$/, "");
						res.writeHead(302, {
							Location: `https://${redirectHostBase}:${config.httpsPort}/setup`,
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
							`Onboarding server: port ${config.listenPort} already in use — skipping`,
						);
						server.close();
						resolve();
						return;
					}
					reject(err);
				});

				server.listen(config.listenPort, config.host, () => {
					// Resolve actual port (important when listenPort is 0)
					const addr = server.address();
					if (addr && typeof addr !== "string") {
						actualPort = addr.port;
					}
					ctx.onboardingServer = server;
					log.info(
						`Onboarding HTTP server listening on ${config.host}:${actualPort}`,
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
