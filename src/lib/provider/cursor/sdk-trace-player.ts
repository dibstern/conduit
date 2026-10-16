import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Either, Schema } from "effect";
import { CursorSdkFailure, cursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorAgentOptions,
	CursorAuthStatus,
	CursorModel,
	CursorPersistedRun,
	CursorRuntimeProbe,
	CursorSdkPort,
	CursorStore,
	CursorStoredCredential,
} from "./sdk-port.js";

interface TraceRow {
	kind: string;
	data: unknown;
}

interface TraceAgentState {
	readonly id: string;
	readonly cwd: string;
	readonly sendIndex: number;
	readonly activeRun?: CursorPersistedRun;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runStatus(value: unknown): value is CursorPersistedRun["status"] {
	return (
		value === "queued" ||
		value === "running" ||
		value === "finished" ||
		value === "error" ||
		value === "cancelled" ||
		value === "expired"
	);
}

function persistedRun(value: unknown): CursorPersistedRun | undefined {
	if (
		!object(value) ||
		typeof value["runId"] !== "string" ||
		!runStatus(value["status"])
	)
		return undefined;
	return {
		runId: value["runId"],
		status: value["status"],
		...(typeof value["requestId"] === "string" || value["requestId"] === null
			? { requestId: value["requestId"] }
			: {}),
		...(typeof value["startedAt"] === "number" || value["startedAt"] === null
			? { startedAt: value["startedAt"] }
			: {}),
	};
}

const decodeModels = Schema.decodeUnknownEither(
	Schema.Array(
		Schema.Struct({
			id: Schema.String,
			displayName: Schema.String,
			parameters: Schema.optional(
				Schema.Array(
					Schema.Struct({
						id: Schema.String,
						displayName: Schema.optional(Schema.String),
						values: Schema.Array(
							Schema.Struct({
								value: Schema.String,
								displayName: Schema.optional(Schema.String),
							}),
						),
					}),
				),
			),
			variants: Schema.optional(
				Schema.Array(
					Schema.Struct({
						params: Schema.Array(
							Schema.Struct({ id: Schema.String, value: Schema.String }),
						),
						displayName: Schema.String,
						isDefault: Schema.optional(Schema.Boolean),
					}),
				),
			),
		}),
	),
);

export function createTraceCursorSdkPort(
	path: string,
	playback: {
		readonly closeDelayMs?: number;
		readonly disposeDelayMs?: number;
		readonly sendGate?: string;
		readonly streamGate?: string;
		readonly deltaDelayMs?: number;
		readonly waitDelayMs?: number;
		readonly cancelTerminalDelayMs?: number;
		readonly cancelNeverSettles?: boolean;
	} = {},
): CursorSdkPort {
	let contents: string | undefined;
	let rows: TraceRow[] = [];
	const stores = new WeakMap<CursorStore, string>();
	const statePath = (storePath: string) => join(storePath, "trace-state.json");
	const readState = (storePath: string): TraceAgentState | undefined => {
		const file = statePath(storePath);
		if (!existsSync(file)) return undefined;
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (
			!object(value) ||
			typeof value["id"] !== "string" ||
			typeof value["cwd"] !== "string" ||
			typeof value["sendIndex"] !== "number"
		)
			throw new CursorSdkFailure({
				operation: "trace.state",
				reason: "Invalid persisted Cursor replay state",
			});
		const activeRun = persistedRun(value["activeRun"]);
		return {
			id: value["id"],
			cwd: value["cwd"],
			sendIndex: value["sendIndex"],
			...(activeRun ? { activeRun } : {}),
		};
	};
	const writeState = (storePath: string, state: TraceAgentState) => {
		mkdirSync(storePath, { recursive: true, mode: 0o700 });
		const file = statePath(storePath);
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(state), {
			mode: 0o600,
			flush: true,
		});
		renameSync(temporary, file);
	};
	const gate = async (file: string | undefined) => {
		while (file && existsSync(file)) await setTimeout(20);
	};
	const cursors = new Map<string, number>();
	const activeRuns = new Map<string, string>();
	const reload = () => {
		let next: string;
		try {
			next = readFileSync(path, "utf8");
		} catch {
			throw new CursorSdkFailure({
				operation: "trace.read",
				reason: "Cursor SDK trace could not be read",
			});
		}
		if (next === contents) return;
		let values: unknown[];
		try {
			values = next
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown);
		} catch {
			throw new CursorSdkFailure({
				operation: "trace.decode",
				reason: "Invalid Cursor SDK trace JSON",
			});
		}
		const header = values.shift();
		if (
			!object(header) ||
			header["sdkVersion"] !== "1.0.37" ||
			typeof header["scenario"] !== "string" ||
			!(
				typeof header["model"] === "string" ||
				(object(header["model"]) && typeof header["model"]["id"] === "string")
			) ||
			typeof header["recordedAt"] !== "string"
		) {
			throw new CursorSdkFailure({
				operation: "trace.decode",
				reason: "Invalid Cursor SDK trace header",
			});
		}
		rows = values.filter(
			(value): value is TraceRow =>
				object(value) && typeof value["kind"] === "string",
		);
		cursors.clear();
		contents = next;
	};
	reload();
	const result = (kind: string): unknown => {
		reload();
		const matches = rows.filter(
			(row) =>
				row.kind === kind ||
				row.kind === `${kind}.error` ||
				(kind === "created" && row.kind === "create.error") ||
				(kind === "resumed" && row.kind === "resume.error"),
		);
		const index = cursors.get(kind) ?? 0;
		const row = matches[Math.min(index, matches.length - 1)];
		cursors.set(kind, index + 1);
		if (row?.kind.endsWith(".error")) throw cursorSdkFailure(kind, row.data);
		return row?.data;
	};
	const agent = (id: string, options: CursorAgentOptions): CursorAgent => {
		let closed: Promise<void> | undefined;
		const closeDelayMs = playback.closeDelayMs ?? 0;
		const prior = readState(options.storePath);
		if (prior && (prior.id !== id || prior.cwd !== options.cwd)) {
			throw new CursorSdkFailure({
				operation: "agent.resume",
				reason: "Cursor agent_not_found: resume cwd changed",
			});
		}
		if (!prior) {
			const queued = rows.find(
				(row) => row.kind === "store.runs.before_send",
			)?.data;
			const active = Array.isArray(queued)
				? queued.map(persistedRun).find((run) => run !== undefined)
				: undefined;
			writeState(options.storePath, {
				id,
				cwd: options.cwd,
				sendIndex: 0,
				...(active ? { activeRun: active } : {}),
			});
		}
		return {
			id,
			async send(_prompt, sendOptions, onDelta) {
				if (activeRuns.has(id)) {
					throw cursorSdkFailure("agent.send", {
						name: "AgentBusyError",
						message: "Cursor agent already has a live run",
						code: "agent_busy",
						isRetryable: false,
					});
				}
				reload();
				const state = readState(options.storePath);
				if (!state)
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor replay agent was deleted",
					});
				if (state.activeRun?.status === "running" && !sendOptions.local?.force)
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor agent is busy",
					});
				const starts = rows.flatMap((row, index) =>
					row.kind === "send.options" ? [index] : [],
				);
				let startIndex = Math.min(state.sendIndex, starts.length - 1);
				// A captured busy send has no handle. A forced recovery follows it.
				if (sendOptions.local?.force) {
					while (
						startIndex < starts.length - 1 &&
						!rows
							.slice(starts[startIndex], starts[startIndex + 1])
							.some((row) => row.kind === "run.handle")
					)
						startIndex++;
				}
				const start = starts[startIndex];
				if (start === undefined) {
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor trace contains no captured send",
					});
				}
				const turn = rows.slice(start, starts[startIndex + 1] ?? rows.length);
				const sendError = turn.find((row) => row.kind === "send.error");
				if (sendError) throw cursorSdkFailure("agent.send", sendError.data);
				const handle = turn.find((row) => row.kind === "run.handle")?.data;
				if (!object(handle) || typeof handle["id"] !== "string") {
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor trace contains no captured run handle",
					});
				}
				const runId = handle["id"];
				const terminal = turn.find((row) => row.kind === "wait.result")?.data;
				const captured = turn.find(
					(row) => row.kind === "store.run.after_crash",
				)?.data;
				const activeRun = persistedRun(captured) ?? {
					runId,
					status: "running" as const,
					...(object(terminal) && typeof terminal["requestId"] === "string"
						? { requestId: terminal["requestId"] }
						: {}),
				};
				writeState(options.storePath, {
					...state,
					sendIndex: startIndex + 1,
					activeRun,
				});
				await gate(playback.sendGate);
				const needsCancel =
					object(terminal) && terminal["status"] === "cancelled";
				const delayedCancel = needsCancel && startIndex === 0;
				let cancel: () => void = () => {};
				const cancelled = new Promise<void>((resolve) => {
					cancel = resolve;
				});
				let complete: () => void = () => {};
				const streamed = new Promise<void>((resolve) => {
					complete = resolve;
				});
				activeRuns.set(id, runId);
				const waiting = (async () => {
					if (needsCancel) {
						await cancelled;
						if (delayedCancel && playback.cancelNeverSettles)
							await new Promise<never>(() => {});
						if (delayedCancel && (playback.cancelTerminalDelayMs ?? 0) > 0)
							await setTimeout(playback.cancelTerminalDelayMs);
					} else await streamed;
					const waitError = turn.find(
						(row) =>
							row.kind === "wait.error" || row.kind === "wait.result.error",
					);
					if (waitError) throw cursorSdkFailure("run.wait", waitError.data);
					if (
						!object(terminal) ||
						!["finished", "cancelled", "error"].includes(
							String(terminal["status"]),
						)
					) {
						const streamError = turn.find((row) => row.kind === "stream.error");
						if (streamError)
							throw cursorSdkFailure("run.stream", streamError.data);
						throw new CursorSdkFailure({
							operation: "run.wait",
							reason: "Cursor stream ended without a terminal status",
						});
					}
					return terminal;
				})().finally(() => {
					if (activeRuns.get(id) === runId) activeRuns.delete(id);
				});
				void waiting.catch(() => {});
				return {
					id: runId,
					stream: (async function* () {
						let held = false;
						try {
							for (const row of turn) {
								if (
									needsCancel &&
									(row.kind === "wait.result" ||
										(row.kind === "stream" &&
											object(row.data) &&
											row.data["type"] === "status" &&
											row.data["status"] !== "RUNNING"))
								)
									await waiting;
								if (row.kind === "delta") {
									if (playback.deltaDelayMs)
										await setTimeout(playback.deltaDelayMs);
									onDelta(row.data);
									if (!held) {
										held = true;
										await gate(playback.streamGate);
									}
								}
								if (row.kind === "stream") yield row.data;
								if (row.kind === "stream.error") {
									throw cursorSdkFailure("run.stream", row.data);
								}
								if (row.kind === "stream.end") break;
							}
						} finally {
							complete();
						}
					})(),
					async wait() {
						await streamed;
						if (playback.waitDelayMs) await setTimeout(playback.waitDelayMs);
						let status: CursorPersistedRun["status"] = "error";
						try {
							const result = await waiting;
							if (runStatus(result["status"])) status = result["status"];
							return result;
						} finally {
							const latest = readState(options.storePath);
							if (latest)
								writeState(options.storePath, {
									...latest,
									activeRun: { ...activeRun, status },
								});
						}
					},
					async cancel() {
						cancel();
					},
				};
			},
			async getUsage() {
				return result("usage");
			},
			close() {
				return (closed ??=
					closeDelayMs > 0 ? setTimeout(closeDelayMs) : Promise.resolve());
			},
		};
	};
	return {
		replay: true,
		async probeRuntime(): Promise<CursorRuntimeProbe> {
			const data = result("runtime.probe");
			// Spike captures predate the discovery probe; their SDK was loaded.
			if (data === undefined) return { available: true };
			if (!object(data) || typeof data["available"] !== "boolean") {
				throw new CursorSdkFailure({
					operation: "runtime.probe",
					reason: "Invalid Cursor runtime probe trace",
				});
			}
			return {
				available: data["available"],
				...(typeof data["reason"] === "string"
					? { reason: data["reason"] }
					: {}),
			};
		},
		async authStatus(): Promise<CursorAuthStatus> {
			const data = result("auth.status");
			if (
				data === undefined ||
				(object(data) && data["status"] === "logged-out")
			) {
				return { status: "logged-out" };
			}
			if (
				!object(data) ||
				data["status"] !== "logged-in" ||
				typeof data["backendUrl"] !== "string"
			) {
				throw new CursorSdkFailure({
					operation: "auth.status",
					reason: "Invalid Cursor auth status trace",
				});
			}
			return {
				status: "logged-in",
				backendUrl: data["backendUrl"],
				...(typeof data["email"] === "string" ? { email: data["email"] } : {}),
				...(typeof data["apiKeyExpiresAtMs"] === "number"
					? { apiKeyExpiresAtMs: data["apiKeyExpiresAtMs"] }
					: {}),
			};
		},
		async storedCredential(): Promise<CursorStoredCredential | undefined> {
			const data = result("credential.store");
			if (data === undefined || data === null) return undefined;
			if (!object(data) || typeof data["apiKey"] !== "string") {
				throw new CursorSdkFailure({
					operation: "credential.store",
					reason: "Invalid Cursor credential store trace",
				});
			}
			return {
				apiKey: /^\[REDACTED(?::[a-zA-Z0-9_-]+)?\]$/.test(data["apiKey"])
					? data["apiKey"]
					: "[REDACTED]",
				backendUrl:
					typeof data["backendUrl"] === "string"
						? data["backendUrl"]
						: "https://api2.cursor.sh",
				createdAtMs:
					typeof data["createdAtMs"] === "number" ? data["createdAtMs"] : 0,
				...(typeof data["apiKeyExpiresAtMs"] === "number"
					? { apiKeyExpiresAtMs: data["apiKeyExpiresAtMs"] }
					: {}),
			};
		},
		async modelsList(): Promise<readonly CursorModel[]> {
			const data = result("models.list");
			const models = object(data) ? data["models"] : data;
			const decoded = decodeModels(models);
			if (Either.isLeft(decoded)) {
				throw new CursorSdkFailure({
					operation: "models.list",
					reason: "Invalid Cursor model list trace",
				});
			}
			return decoded.right;
		},
		async openStore(storePath) {
			let disposed: Promise<void> | undefined;
			const disposeDelayMs = playback.disposeDelayMs ?? 0;
			const store: CursorStore = {
				dispose() {
					return (disposed ??=
						disposeDelayMs > 0
							? setTimeout(disposeDelayMs)
							: Promise.resolve());
				},
			};
			stores.set(store, storePath);
			return store;
		},
		async getActiveRun(agentId, store) {
			const storePath = stores.get(store);
			const state = storePath ? readState(storePath) : undefined;
			return state?.id === agentId ? state.activeRun : undefined;
		},
		async deleteAgent(agentId, _cwd, store) {
			const storePath = stores.get(store);
			if (!storePath)
				throw new CursorSdkFailure({
					operation: "agent.delete",
					reason: "Cursor requires an open conduit-owned store",
				});
			const state = readState(storePath);
			if (state?.id === agentId) {
				unlinkSync(statePath(storePath));
			}
		},
		async primeSandbox() {
			result("sandbox.prime");
		},
		async createAgent(options) {
			const created = result("created");
			if (!object(created) || typeof created["agentId"] !== "string") {
				throw new CursorSdkFailure({
					operation: "agent.create",
					reason: "Cursor trace contains no captured agent",
				});
			}
			return agent(created["agentId"], options);
		},
		async resumeAgent(id, options) {
			return agent(id, options);
		},
	};
}
