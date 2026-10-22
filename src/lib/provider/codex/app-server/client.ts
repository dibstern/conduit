import {
	type Cause,
	Data,
	Deferred,
	Effect,
	Queue,
	Schema,
	Stream,
} from "effect";
import { renderCause } from "../../../effect/failure-classification.js";
import { CODEX_MIN_VERSION, InitializeResponseSchema } from "./protocol.js";
import {
	AppServerExited,
	type AppServerTransport,
	type AppServerTransportError,
} from "./transport.js";

export { CODEX_MIN_VERSION } from "./protocol.js";

export class AppServerRpcError extends Data.TaggedError("AppServerRpcError")<{
	readonly code: number;
	readonly message: string;
	readonly data: unknown;
}> {}

export class CodexVersionUnsupported extends Data.TaggedError(
	"CodexVersionUnsupported",
)<{
	readonly found: string;
	readonly minimum: string;
}> {}

export interface AppServerNotification {
	readonly method: string;
	readonly params: unknown;
}

/** The server already settled this callback; do not send a second response. */
export const SERVER_REQUEST_RESOLVED = Symbol("serverRequest/resolved");

export interface AppServerClientOptions {
	readonly clientInfo: {
		readonly name: string;
		readonly title?: string | null;
		readonly version: string;
	};
	readonly onServerRequest?: (
		method: string,
		params: unknown,
		id: string | number,
	) => Effect.Effect<unknown, unknown> | undefined;
}

export interface AppServerClient {
	readonly serverVersion: string;
	readonly notifications: Stream.Stream<
		AppServerNotification,
		AppServerTransportError
	>;
	readonly request: <A, I, R, RE>(
		method: string,
		params: unknown,
		schema: Schema.Codec<A, I, R, RE>,
	) => Effect.Effect<
		A,
		AppServerTransportError | AppServerRpcError | Schema.SchemaError,
		R
	>;
}

interface ServerRequest extends AppServerNotification {
	readonly id: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportedVersion(version: string): boolean {
	const found = version.split(/[.-]/).slice(0, 3).map(Number);
	const minimum = CODEX_MIN_VERSION.split(".").map(Number);
	for (let i = 0; i < minimum.length; i++) {
		if ((found[i] ?? 0) > (minimum[i] ?? 0)) return true;
		if ((found[i] ?? 0) < (minimum[i] ?? 0)) return false;
	}
	return !version.includes("-");
}

export const connectAppServer = (
	transport: AppServerTransport,
	options: AppServerClientOptions,
) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const notifications = yield* Queue.unbounded<
			AppServerNotification,
			AppServerTransportError
		>();
		const requests = yield* Queue.unbounded<ServerRequest, Cause.Done>();
		const pending = new Map<
			number,
			Deferred.Deferred<unknown, AppServerTransportError | AppServerRpcError>
		>();
		let nextId = 1;
		let terminal: AppServerTransportError | undefined;
		const stop = (failure: AppServerTransportError) =>
			Effect.gen(function* () {
				if (terminal) return;
				terminal = failure;
				for (const deferred of pending.values())
					yield* Deferred.fail(deferred, failure);
				pending.clear();
				yield* Queue.fail(notifications, failure);
				yield* Queue.end(requests);
			});
		const respond = (
			id: string | number,
			error: { code: number; message: string; data?: unknown },
		) => transport.send({ jsonrpc: "2.0", id, error });
		const handle = (request: ServerRequest) =>
			Effect.suspend(() => {
				const handler = options.onServerRequest?.(
					request.method,
					request.params,
					request.id,
				);
				if (handler === undefined)
					return respond(request.id, {
						code: -32601,
						message: `Method not found: ${request.method}`,
					});
				return handler.pipe(
					Effect.matchCauseEffect({
						onFailure: (cause) =>
							respond(request.id, {
								code: -32603,
								message: "Server request handler failed",
								data: renderCause(cause),
							}),
						onSuccess: (result) =>
							result === SERVER_REQUEST_RESOLVED
								? Effect.void
								: transport.send({
										jsonrpc: "2.0",
										id: request.id,
										result: result ?? null,
									}),
					}),
				);
			}).pipe(
				// Also contain exceptions thrown while selecting or constructing the handler.
				Effect.catchCause((cause) =>
					respond(request.id, {
						code: -32603,
						message: "Server request handler failed",
						data: renderCause(cause),
					}),
				),
				Effect.ignore,
			);
		yield* Stream.fromQueue(requests).pipe(
			Stream.mapEffect(handle, { concurrency: 32, unordered: true }),
			Stream.runDrain,
			Effect.forkIn(scope),
		);
		const receive = (message: unknown) =>
			Effect.gen(function* () {
				if (!isRecord(message)) return;
				const id = message["id"];
				const method = message["method"];
				if (typeof method === "string") {
					if (
						typeof id === "string" ||
						(typeof id === "number" && Number.isInteger(id))
					) {
						yield* Queue.offer(requests, {
							id,
							method,
							params: message["params"],
						});
					} else if (!("id" in message)) {
						yield* Queue.offer(notifications, {
							method,
							params: message["params"],
						});
					}
					return;
				}
				if (typeof id !== "number") return;
				const deferred = pending.get(id);
				if (!deferred) return;
				const error = message["error"];
				if (
					isRecord(error) &&
					typeof error["code"] === "number" &&
					typeof error["message"] === "string"
				) {
					yield* Deferred.fail(
						deferred,
						new AppServerRpcError({
							code: error["code"],
							message: error["message"],
							data: error["data"],
						}),
					);
				} else if ("result" in message) {
					yield* Deferred.succeed(deferred, message["result"]);
				} else {
					yield* Effect.logWarning("codex.decode_failed", {
						method: "response",
						id,
					});
				}
			});
		yield* Stream.runForEach(transport.messages, receive).pipe(
			Effect.matchEffect({
				onFailure: stop,
				onSuccess: () =>
					transport.exit.pipe(
						Effect.flatMap((exit) => stop(new AppServerExited(exit))),
					),
			}),
			Effect.forkIn(scope),
		);
		yield* Effect.addFinalizer(() =>
			stop(
				new AppServerExited({
					code: null,
					signal: null,
					stderrTail: "Client scope closed",
				}),
			),
		);
		const request: AppServerClient["request"] = (method, params, schema) =>
			Effect.gen(function* () {
				if (terminal) return yield* Effect.fail(terminal);
				const id = nextId++;
				const response = yield* Deferred.make<
					unknown,
					AppServerTransportError | AppServerRpcError
				>();
				pending.set(id, response);
				return yield* transport
					.send({ jsonrpc: "2.0", id, method, params })
					.pipe(
						Effect.andThen(Deferred.await(response)),
						Effect.flatMap(Schema.decodeUnknownEffect(schema)),
						Effect.ensuring(Effect.sync(() => pending.delete(id))),
					);
			});
		const initialized = yield* request(
			"initialize",
			{
				clientInfo: {
					...options.clientInfo,
					title: options.clientInfo.title ?? null,
				},
				capabilities: { experimentalApi: true },
			},
			InitializeResponseSchema,
		);
		const serverVersion =
			/^[^/\s]+\/(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?=\s|$)/i.exec(
				initialized.userAgent,
			)?.[1];
		if (!serverVersion || !supportedVersion(serverVersion))
			return yield* Effect.fail(
				new CodexVersionUnsupported({
					found: serverVersion ?? initialized.userAgent,
					minimum: CODEX_MIN_VERSION,
				}),
			);
		yield* transport.send({ jsonrpc: "2.0", method: "initialized" });
		return {
			request,
			notifications: Stream.fromQueue(notifications),
			serverVersion,
		} satisfies AppServerClient;
	}).pipe(Effect.onError(() => transport.close));
