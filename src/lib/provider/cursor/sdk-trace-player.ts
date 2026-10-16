import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { CursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorAgentOptions,
	CursorAuthStatus,
	CursorModel,
	CursorRuntimeProbe,
	CursorSdkPort,
	CursorStoredCredential,
} from "./sdk-port.js";

interface TraceRow {
	kind: string;
	data: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createTraceCursorSdkPort(
	path: string,
	playback: {
		readonly closeDelayMs?: number;
		readonly disposeDelayMs?: number;
		readonly authStatePath?: string;
		readonly loginDelayMs?: number;
		readonly loginUrlDelayMs?: number;
	} = {},
): CursorSdkPort {
	let contents: string | undefined;
	let rows: TraceRow[] = [];
	let sendIndex = 0;
	const agentCwds = new Map<string, string>();
	const cursors = new Map<string, number>();
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
		sendIndex = 0;
		contents = next;
	};
	reload();
	const result = (kind: string): unknown => {
		reload();
		const matches = rows.filter(
			(row) => row.kind === kind || row.kind === `${kind}.error`,
		);
		const index = cursors.get(kind) ?? 0;
		const row = matches[Math.min(index, matches.length - 1)];
		cursors.set(kind, index + 1);
		if (row?.kind.endsWith(".error"))
			throw new CursorSdkFailure({
				operation: kind,
				reason: `Cursor ${kind} failed`,
				...(object(row.data) && row.data["authRequired"] === true
					? { authRequired: true }
					: {}),
			});
		return row?.data;
	};
	const readAuthState = (): Record<string, unknown> | undefined => {
		if (!playback.authStatePath) return undefined;
		try {
			const state: unknown = JSON.parse(
				readFileSync(playback.authStatePath, "utf8"),
			);
			if (object(state)) return state;
		} catch (cause) {
			if (
				cause instanceof Error &&
				"code" in cause &&
				cause.code === "ENOENT"
			) {
				return { status: { status: "logged-out" }, credential: null };
			}
		}
		throw new CursorSdkFailure({
			operation: "auth.replay",
			reason: "Invalid Cursor replay auth state",
		});
	};
	const writeAuthState = (status: unknown, credential: unknown) => {
		if (!playback.authStatePath) return;
		const temporary = `${playback.authStatePath}.${process.pid}.tmp`;
		mkdirSync(dirname(playback.authStatePath), {
			recursive: true,
			mode: 0o700,
		});
		writeFileSync(
			temporary,
			JSON.stringify({
				status,
				credential: object(credential)
					? {
							...credential,
							apiKey:
								typeof credential["apiKey"] === "string" &&
								/^\[REDACTED(?::[a-zA-Z0-9_-]+)?\]$/.test(credential["apiKey"])
									? credential["apiKey"]
									: "[REDACTED]",
						}
					: null,
			}),
			{ mode: 0o600 },
		);
		renameSync(temporary, playback.authStatePath);
	};
	const agent = (id: string, options: CursorAgentOptions): CursorAgent => {
		let closed: Promise<void> | undefined;
		const closeDelayMs = playback.closeDelayMs ?? 0;
		const cwd = agentCwds.get(id);
		if (cwd !== undefined && cwd !== options.cwd) {
			throw new CursorSdkFailure({
				operation: "agent.resume",
				reason: "Cursor agent_not_found: resume cwd changed",
			});
		}
		agentCwds.set(id, options.cwd);
		return {
			id,
			async send(_prompt, _options, onDelta) {
				reload();
				const starts = rows.flatMap((row, index) =>
					row.kind === "send.options" ? [index] : [],
				);
				const startIndex = Math.min(sendIndex++, starts.length - 1);
				const start = starts[startIndex];
				if (start === undefined) {
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor trace contains no captured send",
					});
				}
				const turn = rows.slice(start, starts[startIndex + 1] ?? rows.length);
				const sendError = turn.find((row) => row.kind === "send.error");
				if (sendError) {
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor captured send failed",
						...(object(sendError.data) &&
						sendError.data["authRequired"] === true
							? { authRequired: true }
							: {}),
					});
				}
				const handle = turn.find((row) => row.kind === "run.handle")?.data;
				if (!object(handle) || typeof handle["id"] !== "string") {
					throw new CursorSdkFailure({
						operation: "agent.send",
						reason: "Cursor trace contains no captured run handle",
					});
				}
				const runId = handle["id"];
				const terminal = turn.find((row) => row.kind === "wait.result")?.data;
				const needsCancel =
					object(terminal) && terminal["status"] === "cancelled";
				let cancel: () => void = () => {};
				const cancelled = new Promise<void>((resolve) => {
					cancel = resolve;
				});
				let complete: () => void = () => {};
				const streamed = new Promise<void>((resolve) => {
					complete = resolve;
				});
				return {
					id: runId,
					stream: (async function* () {
						try {
							for (const row of turn) {
								if (needsCancel && row.kind === "wait.result") await cancelled;
								if (row.kind === "delta") onDelta(row.data);
								if (row.kind === "stream") yield row.data;
								if (row.kind === "stream.error") {
									throw new CursorSdkFailure({
										operation: "run.stream",
										reason: "Cursor captured stream failed",
										...(object(row.data) && row.data["authRequired"] === true
											? { authRequired: true }
											: {}),
									});
								}
								if (row.kind === "stream.end") break;
							}
						} finally {
							complete();
						}
					})(),
					async wait() {
						await streamed;
						if (needsCancel) await cancelled;
						const waitError = turn.find(
							(row) =>
								row.kind === "wait.error" || row.kind === "wait.result.error",
						);
						if (waitError) {
							throw new CursorSdkFailure({
								operation: "run.wait",
								reason: "Cursor captured wait failed",
								...(object(waitError.data) &&
								waitError.data["authRequired"] === true
									? { authRequired: true }
									: {}),
							});
						}
						if (
							!object(terminal) ||
							!["finished", "cancelled", "error"].includes(
								String(terminal["status"]),
							)
						) {
							throw new CursorSdkFailure({
								operation: "run.wait",
								reason: "Cursor stream ended without a terminal status",
							});
						}
						return terminal;
					},
					async cancel() {
						cancel();
					},
				};
			},
			close() {
				return (closed ??=
					closeDelayMs > 0 ? setTimeout(closeDelayMs) : Promise.resolve());
			},
		};
	};
	return {
		replay: true,
		async authLogin(options) {
			const url = result("auth.loginUrl");
			if (typeof url !== "string") {
				throw new CursorSdkFailure({
					operation: "auth.login",
					reason: "Cursor trace contains no login URL",
				});
			}
			// Delayed callbacks deliberately outlive cancellation to test the host.
			const callback = setTimeout(playback.loginUrlDelayMs ?? 0).then(() =>
				options.onLoginUrl(url),
			);
			void callback.catch(() => {});
			try {
				await setTimeout(playback.loginDelayMs ?? 0, undefined, {
					signal: options.signal,
				});
				options.signal.throwIfAborted();
			} catch {
				throw new CursorSdkFailure({
					operation: "auth.login",
					reason: "Cursor login cancelled",
				});
			}
			result("auth.login");
			writeAuthState(result("auth.status"), result("credential.store"));
		},
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
			const state = readAuthState();
			const data = state ? state["status"] : result("auth.status");
			if (
				data === undefined ||
				(object(data) &&
					(data["status"] === "logged-out" ||
						(typeof data["apiKeyExpiresAtMs"] === "number" &&
							data["apiKeyExpiresAtMs"] <= Date.now())))
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
		async authLogout() {
			result("auth.logout");
			writeAuthState({ status: "logged-out" }, null);
		},
		async storedCredential(): Promise<CursorStoredCredential | undefined> {
			const state = readAuthState();
			const data = state ? state["credential"] : result("credential.store");
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
			if (
				!Array.isArray(models) ||
				!models.every(
					(model): model is CursorModel =>
						object(model) &&
						typeof model["id"] === "string" &&
						typeof model["displayName"] === "string",
				)
			) {
				throw new CursorSdkFailure({
					operation: "models.list",
					reason: "Invalid Cursor model list trace",
				});
			}
			return models;
		},
		async openStore() {
			let disposed: Promise<void> | undefined;
			const disposeDelayMs = playback.disposeDelayMs ?? 0;
			return {
				dispose() {
					return (disposed ??=
						disposeDelayMs > 0
							? setTimeout(disposeDelayMs)
							: Promise.resolve());
				},
			};
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
