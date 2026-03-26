// ─── Session Helpers ───────────────────────────────────────────────────────
// Create and clean up test sessions for contract tests.

import {
	apiDelete,
	apiGet,
	apiPost,
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
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const status = await apiGet<{ status?: { type?: string } }>(
				"/session/status",
			);
			if (status?.status?.type === "idle") return true;
		} catch {
			// Ignore — server might be busy
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

/**
 * Collect SSE events for a given duration or until a predicate is met.
 */
export async function collectSSEEvents(
	path: string,
	opts: {
		maxEvents?: number;
		timeoutMs?: number;
		until?: (event: {
			type: string;
			properties: Record<string, unknown>;
		}) => boolean;
	} = {},
): Promise<Array<{ type: string; properties: Record<string, unknown> }>> {
	const { maxEvents = 100, timeoutMs = 30_000, until } = opts;
	const events: Array<{ type: string; properties: Record<string, unknown> }> =
		[];

	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(`${new URL(path, OPENCODE_BASE_URL).href}`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});

		if (!res.ok || !res.body) return events;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (events.length < maxEvents) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					try {
						const parsed = JSON.parse(line.slice(6)) as {
							type: string;
							properties: Record<string, unknown>;
						};
						events.push(parsed);
						if (until?.(parsed)) {
							controller.abort();
							return events;
						}
					} catch {
						// Skip malformed data
					}
				}
			}
		}
	} catch {
		// AbortError expected
	} finally {
		clearTimeout(deadline);
		controller.abort();
	}

	return events;
}
