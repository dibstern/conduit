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

import * as Headers from "@effect/platform/Headers";
import { Effect, Either, Schema } from "effect";
import {
	commandToTaggedRequestPayload,
	IpcError,
	IpcInstancesResponseSchema,
	IpcKeepAwakeResponseSchema,
	IpcOpenCodeInstanceSchema,
	IpcProjectsResponseSchema,
	IpcStatusResponseSchema,
	type IpcTaggedRequest,
	IpcTaggedRequestSchema,
} from "../contracts/ipc-requests.js";
import {
	handleRestartWithConfig,
	handleSetKeepAwake,
	handleSetKeepAwakeCommand,
	handleSetPin,
	handleShutdown,
} from "../domain/daemon/Services/ipc-handlers.js";
import { IpcRpcGroup } from "../domain/daemon/Services/ipc-rpc-group.js";
import { formatErrorDetail } from "../errors.js";
import { createLogger } from "../logger.js";
import { serveStaticFile, tryServeStatic } from "../server/static-files.js";
import type { SetupInfoResponse } from "../shared-types.js";
import type { IPCResponse } from "../types.js";
import { buildIPCHandlers, type DaemonIPCContext } from "./daemon-ipc.js";
import {
	parseCommand,
	serializeResponse,
	validateCommand,
} from "./ipc-protocol.js";
import { removeSocketFile } from "./pid-manager.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 5_000;
const log = createLogger("daemon");

const ipcFailure = (response: { readonly error?: string }) =>
	new IpcError({ message: response.error ?? "IPC command failed" });

const invalidSuccess = (command: string) =>
	new IpcError({ message: `${command} returned an invalid success response` });

const decodeProjectsResponse = (response: unknown) =>
	Schema.decodeUnknown(IpcProjectsResponseSchema)(response);

const decodeInstance = (instance: unknown) =>
	Schema.decodeUnknown(IpcOpenCodeInstanceSchema)(instance);

const decodeInstancesResponse = (response: unknown) =>
	Schema.decodeUnknown(IpcInstancesResponseSchema)(response);

const decodeStatus = (response: unknown) =>
	Schema.decodeUnknown(IpcStatusResponseSchema)(response);

const decodeKeepAwake = (response: unknown) =>
	Schema.decodeUnknown(IpcKeepAwakeResponseSchema)(response);

function makeRpcHandlerLayer(handlers: ReturnType<typeof buildIPCHandlers>) {
	return IpcRpcGroup.toLayer({
		AddProject: (request) =>
			Effect.tryPromise({
				try: () => handlers.addProject(request.directory),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) => {
					if (!response.ok) return Effect.fail(ipcFailure(response));
					if (
						typeof response.slug !== "string" ||
						typeof response.directory !== "string"
					) {
						return Effect.fail(invalidSuccess("AddProject"));
					}
					return Effect.succeed({
						ok: true as const,
						slug: response.slug,
						directory: response.directory,
					});
				}),
			),
		RemoveProject: (request) =>
			Effect.tryPromise({
				try: () => handlers.removeProject(request.slug),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		ListProjects: () =>
			Effect.tryPromise({
				try: () => handlers.listProjects(),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? decodeProjectsResponse(response).pipe(
								Effect.mapError(() => invalidSuccess("ListProjects")),
							)
						: Effect.fail(ipcFailure(response)),
				),
			),
		SetProjectTitle: (request) =>
			Effect.tryPromise({
				try: () => handlers.setProjectTitle(request.slug, request.title),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		GetStatus: () =>
			Effect.tryPromise({
				try: () => handlers.getStatus(),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) => {
					if (!response.ok) return Effect.fail(ipcFailure(response));
					return decodeStatus(response).pipe(
						Effect.mapError(() => invalidSuccess("GetStatus")),
					);
				}),
			),
		SetPin: (request) =>
			handleSetPin({
				cmd: "set_pin",
				pin: request.pin,
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		SetKeepAwake: (request) =>
			handleSetKeepAwake({
				cmd: "set_keep_awake",
				enabled: request.enabled,
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? decodeKeepAwake(response).pipe(
								Effect.mapError(() => invalidSuccess("SetKeepAwake")),
							)
						: Effect.fail(ipcFailure(response)),
				),
			),
		SetKeepAwakeCommand: (request) =>
			handleSetKeepAwakeCommand({
				cmd: "set_keep_awake_command",
				command: request.command,
				args: [...request.args],
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		Shutdown: () =>
			handleShutdown({ cmd: "shutdown" }).pipe(
				Effect.zipRight(
					Effect.tryPromise({
						try: () => handlers.shutdown(),
						catch: (error) =>
							new IpcError({ message: formatErrorDetail(error) }),
					}).pipe(
						Effect.flatMap((shutdownResponse) =>
							shutdownResponse.ok
								? Effect.void
								: Effect.fail(ipcFailure(shutdownResponse)),
						),
						Effect.orDie,
					),
				),
				Effect.map(() => ({ ok: true as const })),
			),
		SetAgent: (request) =>
			Effect.tryPromise({
				try: () => handlers.setAgent(request.slug, request.agent),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		SetModel: (request) =>
			Effect.tryPromise({
				try: () =>
					handlers.setModel(request.slug, request.provider, request.model),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		RestartWithConfig: (request) =>
			handleRestartWithConfig({
				cmd: "restart_with_config",
				...(request.config !== undefined ? { config: request.config } : {}),
			}).pipe(
				Effect.flatMap((response) => {
					if (!response.ok) return Effect.fail(ipcFailure(response));
					return Effect.tryPromise({
						try: () => handlers.restartWithConfig(),
						catch: (error) =>
							new IpcError({ message: formatErrorDetail(error) }),
					}).pipe(
						Effect.flatMap((shutdownResponse) =>
							shutdownResponse.ok
								? Effect.succeed({ ok: true as const })
								: Effect.fail(ipcFailure(shutdownResponse)),
						),
					);
				}),
			),
		InstanceList: () =>
			Effect.tryPromise({
				try: () => handlers.instanceList(),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? decodeInstancesResponse(response).pipe(
								Effect.mapError(() => invalidSuccess("InstanceList")),
							)
						: Effect.fail(ipcFailure(response)),
				),
			),
		InstanceAdd: (request) =>
			Effect.tryPromise({
				try: () =>
					handlers.instanceAdd(
						request.name,
						request.port,
						request.managed,
						request.env,
						request.url,
					),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) => {
					if (!response.ok) return Effect.fail(ipcFailure(response));
					return decodeInstance(response.instance).pipe(
						Effect.map((instance) => ({
							ok: true as const,
							instance,
						})),
						Effect.mapError(() => invalidSuccess("InstanceAdd")),
					);
				}),
			),
		InstanceRemove: (request) =>
			Effect.tryPromise({
				try: () => handlers.instanceRemove(request.id),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		InstanceStart: (request) =>
			Effect.tryPromise({
				try: () => handlers.instanceStart(request.id),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		InstanceStop: (request) =>
			Effect.tryPromise({
				try: () => handlers.instanceStop(request.id),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) =>
					response.ok
						? Effect.succeed({ ok: true as const })
						: Effect.fail(ipcFailure(response)),
				),
			),
		InstanceUpdate: (request) =>
			Effect.tryPromise({
				try: () =>
					handlers.instanceUpdate(
						request.id,
						request.name,
						request.env,
						request.port,
					),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) => {
					if (!response.ok) return Effect.fail(ipcFailure(response));
					return decodeInstance(response.instance).pipe(
						Effect.map((instance) => ({
							ok: true as const,
							instance,
						})),
						Effect.mapError(() => invalidSuccess("InstanceUpdate")),
					);
				}),
			),
		InstanceStatus: (request) =>
			Effect.tryPromise({
				try: () => handlers.instanceStatus(request.id),
				catch: (error) => new IpcError({ message: formatErrorDetail(error) }),
			}).pipe(
				Effect.flatMap((response) => {
					if (!response.ok) return Effect.fail(ipcFailure(response));
					return decodeInstance(response.instance).pipe(
						Effect.map((instance) => ({
							ok: true as const,
							instance,
						})),
						Effect.mapError(() => invalidSuccess("InstanceStatus")),
					);
				}),
			),
	});
}

function decodeTaggedRequest(line: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return Either.left(new Error("Invalid JSON"));
	}
	return Schema.decodeUnknownEither(IpcTaggedRequestSchema)(parsed);
}

function isTaggedPayload(value: unknown): value is { _tag: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"_tag" in value &&
		typeof value._tag === "string"
	);
}

export const dispatchTaggedRequestEffect = (
	request: IpcTaggedRequest,
	rpcLayer: ReturnType<typeof makeRpcHandlerLayer>,
) =>
	Effect.gen(function* () {
		const handler = yield* IpcRpcGroup.accessHandler(request._tag);
		return yield* handler(request, Headers.empty);
	}).pipe(
		Effect.provide(rpcLayer),
		Effect.catchAll((error) =>
			Effect.succeed({
				ok: false,
				error: formatErrorDetail(error),
			}),
		),
	);

export type TaggedIpcDispatcher = (
	request: IpcTaggedRequest,
	rpcLayer: ReturnType<typeof makeRpcHandlerLayer>,
) => Promise<IPCResponse>;

// ─── Context interface ──────────────────────────────────────────────────────
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
	ipcServer: NetServer | null;
	ipcClients: Set<Socket>;
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

// ─── HTTP Server ────────────────────────────────────────────────────────────

/** Create and start the HTTP(S) server, storing it in ctx.httpServer. */
export function startHttpServer(
	ctx: DaemonLifecycleContext,
	config: HttpServerStartConfig,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let actualPort = config.port;
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

		if (config.tls) {
			// ─── TLS mode: protocol detection ─────────────────────────────
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

		ctx.httpServer.listen(config.port, config.host, () => {
			// Resolve actual port (important when port 0 is used for OS-assigned ephemeral port)
			// biome-ignore lint/style/noNonNullAssertion: safe — inside listen callback
			const addr = ctx.httpServer!.address();
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

// ─── Onboarding Server (HTTP-only, port+1) ─────────────────────────────────

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

// ─── IPC Server ─────────────────────────────────────────────────────────────

/** Create and start the IPC (Unix socket) server with command routing. */
export function startIPCServer(
	ctx: DaemonLifecycleContext,
	ipcContext: DaemonIPCContext,
	dispatchTaggedRequest: TaggedIpcDispatcher,
): Promise<void> {
	return new Promise((resolve, reject) => {
		// Remove stale socket file if it exists
		removeSocketFile(ctx.socketPath);

		const handlers = buildIPCHandlers(ipcContext);
		const rpcLayer = makeRpcHandlerLayer(handlers);

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

					let parsedLine: unknown;
					try {
						parsedLine = JSON.parse(line);
					} catch {
						parsedLine = null;
					}

					if (isTaggedPayload(parsedLine)) {
						const ipcT0 = Date.now();
						const decoded = decodeTaggedRequest(line);
						const response = Either.isRight(decoded)
							? await dispatchTaggedRequest(decoded.right, rpcLayer)
							: {
									ok: false,
									error: formatErrorDetail(decoded.left),
								};
						const ipcMs = Date.now() - ipcT0;
						if (ipcMs > 100) {
							log.warn(`[ipc] ${parsedLine._tag} took ${ipcMs}ms`);
						} else {
							log.debug(`[ipc] ${parsedLine._tag} ${ipcMs}ms`);
						}
						socket.write(serializeResponse(response));
						continue;
					}

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
						log.warn(
							"DEPRECATED: cmd-format IPC will be removed in the next release. Update your CLI.",
						);
						const validationError = validateCommand(
							cmd as Record<string, unknown> & { cmd: string },
						);
						let response: IPCResponse;
						if (validationError) {
							response = validationError;
						} else {
							const decoded = Schema.decodeUnknownEither(
								IpcTaggedRequestSchema,
							)(commandToTaggedRequestPayload(cmd));
							response = Either.isRight(decoded)
								? await dispatchTaggedRequest(decoded.right, rpcLayer)
								: {
										ok: false,
										error: formatErrorDetail(decoded.left),
									};
						}
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
