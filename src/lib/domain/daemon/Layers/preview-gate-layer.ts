/**
 * The Preview Gate (CONTRACT.md 8.7): opens a session's live servers from any device on the
 * tailnet. Each port in Servers gets its own loopback proxy and a `tailscale serve --https=<port>`
 * handler in front of it, so each app keeps its own origin and the listener that took a connection,
 * never a request header, fixes the target. Every request needs conduit's login cookie and re-reads
 * the port's listener against the entry's ServerKey, failing closed to "Server stopped".
 *
 * Consent: the gate runs while the user's Tailscale Serve opt-in (tailscaleServeEnabled) is on. That
 * opt-in is the one consent to conduit editing the Serve config the contract asks for (CONTRACT.md
 * 3009 "Tailscale and the user's consent"); there is no separate preview consent. Without it, or
 * without Tailscale, the pane's Open stays the localhost link with Copy link.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request,
	type Server,
} from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { Clock, Config, Effect, Layer, Ref, Schedule } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { listenerOn } from "../../persistence/Services/port-watcher.js";
import {
	AuthManagerTag,
	parseCookies,
} from "../../server/Layers/auth-middleware.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { SessionActivityTag } from "../Services/session-activity.js";
import { Subprocess } from "../Services/subprocess.js";
import { serveRoots, TailscaleCliTag } from "./tailscale-serve-layer.js";

const PAGE = (title: string, text: string) =>
	`<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><h1>${title}</h1><p>${text}</p>`;
const UNAUTHENTICATED = PAGE(
	"Sign in to conduit",
	"Open conduit on this device and sign in, then open the server again.",
);
const STOPPED = PAGE(
	"Server stopped",
	"This server is no longer running. Start it again from the session.",
);

interface Gate {
	readonly server: Server;
	readonly proxy: string;
	goneAt?: number | undefined;
}
type Owned = readonly { readonly port: number; readonly proxy: string }[];

export const makePreviewGateLive = (configDir: string) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const activity = yield* SessionActivityTag;
			const auth = yield* AuthManagerTag;
			const cli = yield* TailscaleCliTag;
			const subprocess = yield* Subprocess;
			// A server that just left Servers keeps its gate a while, showing "Server stopped".
			const lingerMs = yield* Config.Int("CONDUIT_PREVIEW_GATE_LINGER_MS").pipe(
				Config.withDefault(60_000),
			);
			// Handlers this daemon added, kept on disk so a crashed daemon's are removed at the next
			// start: a handler left pointing at a dead gate would expose whatever binds that port next.
			const ownedPath = join(configDir, "preview-gate.json");
			let stale: Owned = (() => {
				try {
					return JSON.parse(readFileSync(ownedPath, "utf8")) as Owned;
				} catch {
					return [];
				}
			})();
			const gates = new Map<number, Gate>();
			const conflicts = new Set<number>();
			const save = () =>
				writeFileSync(
					ownedPath,
					JSON.stringify([
						...stale,
						...[...gates].map(([port, { proxy }]) => ({ port, proxy })),
					]),
				);

			const entryOf = (port: number) =>
				[...activity.servers.values()]
					.flat()
					.find((server) => server.port === port);
			/**
			 * Whether the request may reach the server on `port`, and the page to show if not. Node's
			 * request callbacks are the boundary, so this is the gate's one run into Effect.
			 */
			const admit = (port: number, headers: IncomingHttpHeaders) =>
				Effect.runPromise(
					Effect.gen(function* () {
						const cookie = parseCookies(headers.cookie)["relay_session"];
						if (
							(yield* auth.hasPin()) &&
							(cookie === undefined || !(yield* auth.validateCookie(cookie)))
						)
							return { status: 401, page: UNAUTHENTICATED } as const;
						const entry = entryOf(port);
						const live =
							entry &&
							(yield* listenerOn(port).pipe(
								Effect.provideService(Subprocess, subprocess),
								Effect.orElseSucceed(() => undefined),
							));
						return live !== undefined &&
							live.pid === entry?.pid &&
							live.startedAt === entry.startedAt
							? undefined
							: ({ status: 503, page: STOPPED } as const);
					}),
				);
			// What the server sees: its own localhost host, and none of conduit's credentials.
			const upstreamHeaders = (port: number, headers: IncomingHttpHeaders) => {
				const { cookie, "x-relay-pin": _pin, ...rest } = headers;
				const kept = (cookie ?? "")
					.split(";")
					.map((part) => part.trim())
					.filter((part) => part !== "" && !part.startsWith("relay_session="))
					.join("; ");
				return {
					...rest,
					host: `localhost:${port}`,
					...(kept !== "" && { cookie: kept }),
				};
			};
			const ownOrigin = (port: number) =>
				new RegExp(
					`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=[/?#]|$)`,
				);
			const refuse = (status: number) =>
				`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 400 ? "Bad Request" : "Service Unavailable"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;

			const open = (port: number) =>
				Effect.callback<Server, Error>((resume) => {
					const server = createServer((req, res) => {
						const send = (status: number, page: string) =>
							res
								.writeHead(status, {
									"content-type": "text/html; charset=utf-8",
									"cache-control": "no-store",
								})
								.end(page);
						// An absolute-form target names another host; only paths reach the server.
						if (!req.url?.startsWith("/")) {
							send(400, "");
							return;
						}
						void admit(port, req.headers).then((refused) => {
							if (refused) {
								send(refused.status, refused.page);
								return;
							}
							// No agent: each request is a new upstream connection, checked above.
							const upstream = request(
								{
									host: "127.0.0.1",
									port,
									method: req.method,
									path: req.url,
									headers: upstreamHeaders(port, req.headers),
									agent: false,
								},
								(answer) => {
									const {
										location,
										"set-cookie": cookies,
										...rest
									} = answer.headers;
									res.writeHead(answer.statusCode ?? 502, {
										...rest,
										// The server's redirect to its own localhost stays on the gate.
										...(location !== undefined && {
											location: location.replace(ownOrigin(port), "") || "/",
										}),
										// The server cannot replace conduit's login cookie.
										...(cookies && {
											"set-cookie": cookies.filter(
												(value) => !/^\s*relay_session=/.test(value),
											),
										}),
									});
									answer.pipe(res);
								},
							);
							upstream.on("error", () => {
								if (!res.headersSent) send(503, STOPPED);
								else res.destroy();
							});
							req.pipe(upstream);
						});
					});
					server.on("upgrade", (req: IncomingMessage, socket: Socket, head) => {
						socket.on("error", () => socket.destroy());
						if (!req.url?.startsWith("/")) {
							socket.end(refuse(400));
							return;
						}
						void admit(port, req.headers).then((refused) => {
							if (refused) {
								socket.end(refuse(refused.status));
								return;
							}
							const upstream = connect(port, "127.0.0.1", () => {
								const lines = Object.entries(
									upstreamHeaders(port, req.headers),
								).flatMap(([name, value]) =>
									(Array.isArray(value) ? value : [value]).map(
										(one) => `${name}: ${one}\r\n`,
									),
								);
								upstream.write(
									`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("")}\r\n`,
								);
								upstream.write(head);
								upstream.pipe(socket).pipe(upstream);
							});
							upstream.on("error", () => socket.destroy());
							socket.on("close", () => upstream.destroy());
						});
					});
					server.once("error", (error) => resume(Effect.fail(error)));
					server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
				});
			const close = (server: Server) =>
				Effect.sync(() => {
					server.close();
					server.closeAllConnections();
				});

			/** Bring Serve and the gates to Servers; Tailscale is read only when something changes. */
			const reconcile = Effect.gen(function* () {
				const config = yield* Ref.get(configRef);
				const now = yield* Clock.currentTimeMillis;
				const enabled = config.tailscaleServeEnabled === true;
				const listed = new Set(
					[...activity.servers.values()].flat().map(({ port }) => port),
				);
				for (const port of conflicts)
					if (!listed.has(port)) conflicts.delete(port);
				for (const [port, gate] of gates)
					gate.goneAt = listed.has(port) ? undefined : (gate.goneAt ?? now);
				const remove = [...gates].filter(
					([, { goneAt }]) =>
						!enabled || (goneAt !== undefined && now - goneAt >= lingerMs),
				);
				const add = enabled
					? [...listed].filter(
							(port) =>
								!gates.has(port) &&
								!conflicts.has(port) &&
								port !== config.port,
						)
					: [];
				// A gate closes before its handler goes, so a handler never outlives what it names.
				for (const [port, gate] of remove) {
					yield* close(gate.server);
					gates.delete(port);
					stale = [...stale, { port, proxy: gate.proxy }];
				}
				if (remove.length > 0) save();
				if (stale.length === 0 && add.length === 0) return;
				const roots = yield* serveRoots;
				if (roots === undefined) return;
				// Only a handler still pointing at the gate's own proxy is the gate's to remove.
				for (const { port, proxy } of stale)
					if (roots.rootOf(port)?.Proxy === proxy)
						yield* cli.exec([
							"serve",
							`--https=${port}`,
							"--set-path=/",
							"off",
						]);
				stale = [];
				for (const port of add) {
					// Someone else's '/' on this port stays theirs; the server is not gated.
					if (roots.rootOf(port) !== undefined) {
						conflicts.add(port);
						continue;
					}
					const server = yield* open(port);
					const address = server.address();
					const proxy = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
					gates.set(port, { server, proxy });
					save();
					yield* cli
						.exec(["serve", "--bg", `--https=${port}`, "--set-path=/", proxy])
						.pipe(
							Effect.tapError(() =>
								Effect.sync(() => gates.delete(port)).pipe(
									Effect.andThen(close(server)),
								),
							),
						);
				}
				save();
			});

			// A failure repeats each pass while Tailscale stays broken; log it once until it changes.
			let failure = "";
			yield* reconcile.pipe(
				Effect.tap(() => Effect.sync(() => (failure = ""))),
				Effect.catch((error) => {
					const message = `Preview Gate: ${error instanceof Error ? error.message : formatErrorDetail(error)}`;
					if (message === failure) return Effect.void;
					failure = message;
					return Effect.logWarning(message);
				}),
				Effect.repeat(Schedule.spaced("1 second")),
				Effect.forkScoped,
			);
			yield* Effect.addFinalizer(() =>
				Effect.forEach(gates.values(), ({ server }) => close(server)),
			);
		}),
	);
