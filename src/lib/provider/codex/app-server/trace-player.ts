import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";
import {
	type Cause,
	Deferred,
	Effect,
	Queue,
	type Scope,
	Semaphore,
	Stream,
} from "effect";
import type { AppServerTraceHeader, AppServerTraceRow } from "./trace.js";
import {
	type AppServerExit,
	AppServerExited,
	AppServerIoError,
	type AppServerTransport,
	type AppServerTransportError,
} from "./transport.js";

export interface AppServerTraceMismatch {
	readonly expected: string;
	readonly actual: string;
	readonly at: number;
}

export interface AppServerTraceReport {
	readonly scenario: string;
	readonly consumed: number;
	readonly total: number;
	readonly mismatches: readonly AppServerTraceMismatch[];
	readonly unconsumed: readonly AppServerTraceRow[];
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function id(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

function signal(value: unknown): value is NodeJS.Signals | null {
	return (
		value === null || (typeof value === "string" && value in constants.signals)
	);
}

function header(value: unknown): value is AppServerTraceHeader {
	return (
		object(value) &&
		typeof value["scenario"] === "string" &&
		typeof value["codexVersion"] === "string" &&
		typeof value["recordedAt"] === "string"
	);
}

function row(value: unknown): value is AppServerTraceRow {
	if (
		!object(value) ||
		typeof value["at"] !== "number" ||
		!Number.isFinite(value["at"]) ||
		value["at"] < 0
	)
		return false;
	if (value["dir"] === "out" || value["dir"] === "in")
		return "message" in value;
	return (
		value["dir"] === "exit" &&
		(value["code"] === null || Number.isInteger(value["code"])) &&
		signal(value["signal"])
	);
}

function describe(message: unknown): string {
	if (!object(message)) return JSON.stringify(message) ?? String(message);
	if (typeof message["method"] === "string") return message["method"];
	if (id(message["id"])) return `response id=${message["id"]}`;
	return JSON.stringify(message);
}

export function createTraceAppServerTransport(
	path: string,
	options: { readonly reportPath?: string } = {},
): Effect.Effect<AppServerTransport, AppServerIoError, Scope.Scope> {
	return Effect.gen(function* () {
		const invalid = (cause: string) =>
			Effect.fail(new AppServerIoError({ operation: "trace.read", cause }));
		const [metadata, ...values] = yield* Effect.try({
			try: () =>
				readFileSync(path, "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line): unknown => JSON.parse(line)),
			catch: (cause) =>
				new AppServerIoError({ operation: "trace.read", cause }),
		});
		if (!header(metadata))
			return yield* invalid("Invalid app-server trace header");
		const rows: AppServerTraceRow[] = [];
		for (const [index, value] of values.entries()) {
			if (!row(value))
				return yield* invalid(`Invalid app-server trace row ${index + 2}`);
			if (rows.at(-1)?.dir === "exit")
				return yield* invalid("App-server trace exit must be the final row");
			rows.push(value);
		}
		const trace = { metadata, rows };
		const queue = yield* Queue.unbounded<
			{ readonly message: unknown; readonly at: number },
			AppServerTransportError | Cause.Done
		>();
		const exited = yield* Deferred.make<AppServerExit>();
		const outbound = yield* Semaphore.make(1);
		const requestIds = new Map<string | number, string | number>();
		const serverIds = new Map<string | number, string | number>();
		const clientMessageIds = new Map<string, string>();
		const mismatches: AppServerTraceMismatch[] = [];
		// Tests advance a logical timestamp to inspect a turn before more frames
		// arrive. Ordinary fixture replay remains immediate.
		const gatePath = process.env["CONDUIT_CODEX_APP_SERVER_TRACE_GATE"];
		let cursor = 0;
		let exitValue: AppServerExit | undefined;
		let closed = false;
		const finish = (value: AppServerExit) =>
			Effect.gen(function* () {
				if (exitValue) return;
				exitValue = value;
				yield* Deferred.succeed(exited, value);
				yield* Queue.fail(queue, new AppServerExited(value));
			});
		const emitFollowing = Effect.gen(function* () {
			while (cursor < trace.rows.length) {
				const next = trace.rows[cursor];
				if (!next || next.dir === "out") return;
				cursor += 1;
				if (next.dir === "exit") {
					yield* finish({
						code: next.code,
						signal: next.signal,
						stderrTail: "",
					});
					return;
				}
				let message = next.message;
				if (object(message) && id(message["id"])) {
					if (typeof message["method"] === "string") {
						// Server request IDs use their own namespace from client IDs.
						serverIds.set(message["id"], message["id"]);
					} else {
						const live = requestIds.get(message["id"]);
						if (live !== undefined) message = { ...message, id: live };
					}
				}
				if (
					object(message) &&
					(message["method"] === "item/started" ||
						message["method"] === "item/completed")
				) {
					const params = message["params"];
					const item = object(params) ? params["item"] : undefined;
					if (
						object(params) &&
						object(item) &&
						item["type"] === "userMessage" &&
						typeof item["clientId"] === "string"
					) {
						const live = clientMessageIds.get(item["clientId"]);
						if (live !== undefined)
							message = {
								...message,
								params: { ...params, item: { ...item, clientId: live } },
							};
					}
				}
				yield* Queue.offer(queue, { message, at: next.at });
			}
		});
		const close = outbound.withPermits(1)(
			Effect.gen(function* () {
				if (closed) return;
				closed = true;
				yield* emitFollowing;
				yield* finish({ code: 0, signal: null, stderrTail: "" });
				yield* Effect.sync(() => {
					const reportPath =
						options.reportPath ??
						process.env["CONDUIT_CODEX_APP_SERVER_TRACE_REPORT"];
					if (!reportPath) return;
					const report: AppServerTraceReport = {
						scenario: trace.metadata.scenario,
						consumed: cursor,
						total: trace.rows.length,
						mismatches,
						unconsumed: trace.rows.slice(cursor, cursor + 5),
					};
					try {
						mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
						appendFileSync(reportPath, `${JSON.stringify(report)}\n`, {
							mode: 0o600,
						});
					} catch {
						// A replay report is diagnostic and cannot change close's outcome.
					}
				});
			}),
		);
		yield* Effect.addFinalizer(() => close);
		yield* emitFollowing;
		return {
			send: (message) =>
				outbound.withPermits(1)(
					Effect.gen(function* () {
						if (exitValue) return yield* new AppServerExited(exitValue);
						const expected = trace.rows[cursor];
						const expectedMessage =
							expected?.dir === "out" ? expected.message : undefined;
						const method = object(expectedMessage)
							? expectedMessage["method"]
							: undefined;
						const boundaryKeys =
							method === "thread/fork"
								? ["threadId", "lastTurnId"]
								: method === "thread/revert"
									? ["threadId", "beforeTurnId"]
									: [];
						const expectedParams = object(expectedMessage)
							? expectedMessage["params"]
							: undefined;
						const actualParams = object(message)
							? message["params"]
							: undefined;
						const matches =
							object(expectedMessage) &&
							object(message) &&
							(typeof expectedMessage["method"] === "string"
								? expectedMessage["method"] === message["method"]
								: typeof message["method"] !== "string" &&
									id(expectedMessage["id"]) &&
									message["id"] ===
										(serverIds.get(expectedMessage["id"]) ??
											expectedMessage["id"])) &&
							boundaryKeys.every(
								(key) =>
									object(expectedParams) &&
									object(actualParams) &&
									expectedParams[key] === actualParams[key],
							);
						if (!matches) {
							const expectedName = expected
								? expected.dir === "out"
									? describe(expected.message)
									: expected.dir
								: "end of trace";
							const actualName = describe(message);
							mismatches.push({
								expected: expectedName,
								actual: actualName,
								at: cursor,
							});
							yield* Queue.offer(queue, {
								at: 0,
								message: {
									jsonrpc: "2.0",
									id:
										object(message) && id(message["id"]) ? message["id"] : null,
									error: {
										code: -32099,
										message: `Trace expected ${expectedName}; received ${actualName}`,
									},
								},
							});
							return;
						}
						if (
							object(expectedMessage) &&
							object(message) &&
							typeof message["method"] === "string" &&
							id(expectedMessage["id"]) &&
							id(message["id"])
						)
							requestIds.set(expectedMessage["id"], message["id"]);
						if (
							object(expectedMessage) &&
							object(message) &&
							(message["method"] === "turn/start" ||
								message["method"] === "turn/steer")
						) {
							const expectedParams = expectedMessage["params"];
							const liveParams = message["params"];
							if (
								object(expectedParams) &&
								object(liveParams) &&
								typeof expectedParams["clientUserMessageId"] === "string" &&
								typeof liveParams["clientUserMessageId"] === "string"
							)
								clientMessageIds.set(
									expectedParams["clientUserMessageId"],
									liveParams["clientUserMessageId"],
								);
						}
						cursor += 1;
						yield* emitFollowing;
					}),
				),
			messages: Stream.fromQueue(queue).pipe(
				Stream.mapEffect((row) =>
					Effect.gen(function* () {
						while (
							gatePath &&
							row.at > Number(readFileSync(gatePath, "utf8"))
						) {
							yield* Effect.sleep("10 millis");
						}
						return row.message;
					}),
				),
			),
			exit: Deferred.await(exited),
			close,
		};
	});
}
