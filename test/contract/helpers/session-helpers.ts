// Create and clean up test sessions for contract tests.

import { expect, vi } from "vitest";
import {
	apiDelete,
	apiGet,
	apiPost,
	authHeaders,
	OPENCODE_BASE_URL,
} from "./server-connection.js";

export interface TestSession {
	id: string;
	slug?: string;
	title?: string;
	projectID?: string;
	directory?: string;
	version?: string;
	time?: { created?: number; updated?: number };
}

/**
 * Create a test session with a recognizable title for cleanup.
 */
export async function createTestSession(
	title = `contract-test-${Date.now()}`,
): Promise<TestSession> {
	return apiPost<TestSession>("/session", { title });
}

/**
 * Delete a test session, ignoring errors (best-effort cleanup).
 */
export async function deleteTestSession(sessionId: string): Promise<void> {
	try {
		await apiDelete(`/session/${sessionId}`);
	} catch {
		// Ignore — cleanup is best effort
	}
}

/**
 * Get messages for a session.
 */
export async function getSessionMessages(
	sessionId: string,
): Promise<unknown[]> {
	const res = await apiGet<unknown>(`/session/${sessionId}/message`);
	if (Array.isArray(res)) return res;
	if (typeof res === "object" && res !== null) {
		return Object.values(res as Record<string, unknown>);
	}
	return [];
}

/**
 * Send a prompt to a session asynchronously.
 */
export async function sendPrompt(
	sessionId: string,
	text: string,
): Promise<void> {
	await apiPost(`/session/${sessionId}/prompt_async`, {
		// Ephemeral contract instances run with isolated XDG dirs and no
		// credentials, so the prompt has to name a model the server can serve
		// unauthenticated. Since 1.18.x a prompt with no model is dropped
		// silently — the turn simply never runs, which surfaces downstream as
		// "zero tool events" rather than as an error.
		//
		// The free roster churns with the binary: 1.18.32 retired
		// `mimo-v2.5-free`, which failed exactly that way. Re-check with
		// `opencode models` on an isolated XDG home when bumping OpenCode.
		model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
		parts: [{ type: "text", text }],
	});
}

/**
 * Wait for a session to become idle (polling).
 * Returns true if idle within timeout, false otherwise.
 */
export async function waitForIdle(
	_sessionId: string,
	timeoutMs = 60_000,
	pollMs = 500,
): Promise<boolean> {
	try {
		await vi.waitFor(
			async () => {
				const status = await apiGet<{ status?: { type?: string } }>(
					"/session/status",
				);
				expect(status?.status?.type).toBe("idle");
			},
			{ timeout: timeoutMs, interval: pollMs },
		);
		return true;
	} catch {
		return false;
	}
}

export interface SSEEvent {
	type: string;
	properties: Record<string, unknown>;
	receivedAt: number;
}

interface SSEOptions {
	maxEvents?: number;
	timeoutMs?: number;
	until?: (event: SSEEvent) => boolean;
	onEvent?: (event: SSEEvent, wire: unknown) => void;
}

/** Native subscription readiness means the first event has been parsed. */
export function startSSECollection(path: string, opts: SSEOptions = {}) {
	const { maxEvents = 100, timeoutMs, until, onEvent } = opts;
	const events: SSEEvent[] = [];
	const evidence: {
		path: string;
		startedAt: number;
		readyAt?: number;
		endedAt?: number;
		httpStatus?: number;
		stopReason:
			| "running"
			| "stopped"
			| "predicate"
			| "timeout"
			| "limit"
			| "eof"
			| "error";
		error?: string;
		receivedBytes: number;
		retainedBytes: number;
		raw: { receivedAt: number; base64: string }[];
	} = {
		path,
		startedAt: Date.now(),
		stopReason: "running",
		receivedBytes: 0,
		retainedBytes: 0,
		raw: [],
	};
	let resolveReady: () => void = () => {};
	let rejectReady: (error: Error) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const controller = new AbortController();
	const stop = () => {
		if (evidence.stopReason === "running") evidence.stopReason = "stopped";
		controller.abort();
	};
	const deadline =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					evidence.stopReason = "timeout";
					controller.abort();
				}, timeoutMs);
	const done = (async () => {
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const res = await fetch(new URL(path, OPENCODE_BASE_URL), {
				signal: controller.signal,
				headers: { Accept: "text/event-stream", ...authHeaders() },
			});
			evidence.httpStatus = res.status;
			if (
				!res.ok ||
				!res.body ||
				!res.headers.get("content-type")?.includes("text/event-stream")
			) {
				throw new Error(
					`SSE ${path} failed: ${res.status}, ${res.headers.get("content-type")}`,
				);
			}
			reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (events.length < maxEvents) {
				const { done, value } = await reader.read();
				if (done) {
					if (buffer.trim()) throw new Error("Incomplete SSE data at EOF");
					evidence.stopReason = "eof";
					break;
				}
				const receivedAt = Date.now();
				evidence.receivedBytes += value.byteLength;
				const retained = value.subarray(
					0,
					Math.max(0, 1048576 - evidence.retainedBytes),
				);
				if (retained.length)
					evidence.raw.push({
						receivedAt,
						base64: Buffer.from(retained).toString("base64"),
					});
				evidence.retainedBytes += retained.length;
				if (evidence.receivedBytes > 16 * 1048576)
					throw new Error("SSE byte limit exceeded");
				buffer += decoder.decode(value, { stream: true });
				if (Buffer.byteLength(buffer) > 1048576)
					throw new Error("SSE frame limit exceeded");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.startsWith("data:")) continue;
					const wire: unknown = JSON.parse(line.slice(5).trimStart());
					if (typeof wire !== "object" || wire === null)
						throw new Error("Invalid SSE object");
					const record = wire as Record<string, unknown>;
					const payload = (record["payload"] ?? record) as Record<
						string,
						unknown
					>;
					const properties = payload["properties"] ?? {};
					if (
						typeof payload["type"] !== "string" ||
						typeof properties !== "object" ||
						properties === null ||
						Array.isArray(properties)
					) {
						throw new Error("Invalid native SSE event");
					}
					const event = {
						type: payload["type"],
						properties: properties as Record<string, unknown>,
						receivedAt,
					};
					events.push(event);
					onEvent?.(event, wire);
					if (evidence.readyAt === undefined) {
						evidence.readyAt = receivedAt;
						resolveReady();
					}
					if (until?.(event)) {
						evidence.stopReason = "predicate";
						return events;
					}
					if (events.length >= maxEvents) break;
				}
			}
			if (events.length >= maxEvents) evidence.stopReason = "limit";
			return events;
		} catch (error) {
			if (
				!controller.signal.aborted ||
				(evidence.stopReason !== "stopped" && evidence.stopReason !== "timeout")
			) {
				evidence.stopReason = "error";
				evidence.error = String(error).slice(0, 2048);
				throw error;
			}
			return events;
		} finally {
			clearTimeout(deadline);
			controller.abort();
			reader?.releaseLock();
			evidence.endedAt = Date.now();
			if (evidence.readyAt === undefined)
				rejectReady(
					new Error(
						evidence.error ??
							`SSE ended before readiness: ${evidence.stopReason}`,
					),
				);
		}
	})();
	// The owner awaits the original promises. These handlers only prevent an
	// early pump failure becoming unhandled while its prompt is still pending.
	void ready.catch(() => {});
	void done.catch(() => {});
	return { events, evidence, ready, done, stop };
}

/** Preserve the existing Promise-of-events API and its default deadline. */
export async function collectSSEEvents(
	path: string,
	opts: SSEOptions = {},
): Promise<SSEEvent[]> {
	const collection = startSSECollection(path, {
		...opts,
		timeoutMs: opts.timeoutMs ?? 30_000,
	});
	await collection.ready;
	return collection.done;
}
