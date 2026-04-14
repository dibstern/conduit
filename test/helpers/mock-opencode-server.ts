// ─── Mock OpenCode Server ────────────────────────────────────────────────────
// Replays a recorded OpenCodeRecording as an HTTP + WebSocket server.
// Complement to RecordingProxy: one captures, the other replays.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type {
	OpenCodeInteraction,
	OpenCodeRecording,
} from "../e2e/fixtures/recorded/types.js";

// ─── Internal types ──────────────────────────────────────────────────────────

/** SSE event from a recording. */
interface SseEvent {
	type: string;
	properties: Record<string, unknown>;
	delayMs: number;
}

/** A queued REST response. */
interface QueuedRestResponse {
	status: number;
	responseBody: unknown;
}

/** PTY interaction for replay. */
type PtyInteraction = Extract<
	OpenCodeInteraction,
	{ kind: "pty-open" | "pty-input" | "pty-output" | "pty-close" }
>;

// ─── Path normalization ──────────────────────────────────────────────────────

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID_RE = /^[a-z]{2,4}_[A-Za-z0-9]+$/;

function normalizePath(path: string): string {
	const base = path.split("?")[0] ?? path;
	return base
		.split("/")
		.map((seg) => {
			if (seg === "") return seg;
			if (PREFIXED_ID_RE.test(seg) || UUID_RE.test(seg)) return ":param";
			return seg;
		})
		.join("/");
}

function exactKey(method: string, path: string): string {
	const base = path.split("?")[0] ?? path;
	return `${method.toUpperCase()} ${base}`;
}

function normalizedKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${normalizePath(path)}`;
}

// ─── MockOpenCodeServer ──────────────────────────────────────────────────────

/** Structured log entry for debugging SSE delivery in E2E tests. */
export interface MockDiagnosticEntry {
	ts: number;
	event: string;
	detail?: string | undefined;
}

export class MockOpenCodeServer {
	private readonly recording: OpenCodeRecording;
	private server: Server | undefined;
	private wss: WebSocketServer | undefined;
	private _url = "";

	/** Diagnostic log for debugging E2E SSE delivery issues. */
	readonly diagnostics: MockDiagnosticEntry[] = [];

	// Replay state (rebuilt on reset)
	private exactQueues = new Map<string, QueuedRestResponse[]>();
	private normalizedQueues = new Map<string, QueuedRestResponse[]>();
	private ptyQueues = new Map<string, PtyInteraction[]>();
	private sseClients = new Set<ServerResponse>();
	private keepaliveIntervals = new Set<ReturnType<typeof setInterval>>();

	/** Counter for generating unique PTY IDs when no recording exists. */
	private ptyCounter = 0;

	/** Dynamically created PTY IDs (not from recording). */
	private dynamicPtyIds = new Set<string>();

	/** Sessions injected via POST /session (tracked separately for merging into all GET /session responses). */
	private injectedSessions = new Map<string, Record<string, unknown>>();

	/**
	 * Messages accumulated from SSE events (message.updated + message.part.updated).
	 * Keyed by session ID → message ID → { info, parts }.
	 * Used to serve GET /session/{id}/message after a prompt_async has been processed.
	 */
	private sseMessages = new Map<
		string,
		Map<
			string,
			{ info: Record<string, unknown>; parts: Record<string, unknown>[] }
		>
	>();

	/** Session IDs that have been deleted (filtered from GET /session). */
	private deletedSessionIds = new Set<string>();

	/** Title overrides from PATCH /session/:id. */
	private renamedSessions = new Map<string, string>();

	/**
	 * Session IDs that have had a session.status:idle SSE event emitted.
	 * Used to override GET /session/status responses — once SSE declares
	 * a session idle, the status endpoint must agree (matching real OpenCode
	 * behavior). Without this, the status poller consumes stale "busy"
	 * queue entries and re-injects processing state after SSE already
	 * delivered "done".
	 */
	private sseIdleSessions = new Set<string>();

	/** Counter for generating unique session IDs. */
	private sessionCounter = 0;

	/**
	 * SSE events grouped by prompt boundary. Segment 0 holds events before the
	 * first prompt_async, segment 1 after the first, etc. When a prompt fires,
	 * its segment (and segment 0 for the first prompt) is emitted independently
	 * of REST queue consumption.
	 */
	private sseSegments: SseEvent[][] = [[]];

	/** Number of prompt_async calls processed so far. */
	private promptsFired = 0;

	/**
	 * Session IDs from the recording's prompt_async URLs, in order.
	 * Used to rewrite SSE event session IDs to match the actual session
	 * used by the test, enabling correct per-session routing in the relay.
	 */
	private recordedPromptSessionIds: string[] = [];

	constructor(recording: OpenCodeRecording) {
		this.recording = recording;
		this.buildQueues();
	}

	/** Append a diagnostic entry. */
	private diag(event: string, detail?: string): void {
		this.diagnostics.push({ ts: Date.now(), event, detail });
	}

	/** Base URL of the mock server. Valid after start(). */
	get url(): string {
		return this._url;
	}

	/** Start the mock HTTP + WS server on a random port. */
	async start(): Promise<void> {
		const server = createServer((req, res) => {
			this.handleRequest(req, res).catch(() => {
				if (!res.writableEnded) {
					res.writeHead(500);
					res.end();
				}
			});
		});
		this.server = server;

		const wss = new WebSocketServer({ noServer: true });
		this.wss = wss;
		server.on("upgrade", (req, socket, head) => {
			this.handleUpgrade(req, socket, head, wss);
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const addr = server.address() as AddressInfo;
		this._url = `http://127.0.0.1:${String(addr.port)}`;
	}

	/** Stop the mock server and clean up all resources. */
	async stop(): Promise<void> {
		this.cleanupSseClients();

		if (this.wss) {
			for (const client of this.wss.clients) {
				client.close();
			}
			this.wss.close();
			this.wss = undefined;
		}

		const server = this.server;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			this.server = undefined;
		}
	}

	/** Re-initialize all replay state from the original recording. */
	reset(): void {
		this.cleanupSseClients();
		this.exactQueues.clear();
		this.normalizedQueues.clear();
		this.ptyQueues.clear();
		this.sseSegments = [[]];
		this.promptsFired = 0;
		this.ptyCounter = 0;
		this.dynamicPtyIds.clear();
		this.injectedSessions.clear();
		this.deletedSessionIds.clear();
		this.renamedSessions.clear();
		this.sseIdleSessions.clear();
		this.sseMessages.clear();
		this.sessionCounter = 0;
		this.recordedPromptSessionIds = [];
		this.buildQueues();
	}

	/**
	 * Force-flush all SSE segments without requiring a prompt.
	 * Use in tests that need SSE events without going through prompt_async.
	 */
	flushPendingSse(): void {
		const allEvents = this.sseSegments.flat();
		this.emitEvents(allEvents);
		this.promptsFired = this.sseSegments.length;
	}

	/**
	 * Override the response for a specific exact endpoint.
	 * Replaces the entire queue for that key with a single sticky response
	 * (never consumed — always returns the same response).
	 */
	setExactResponse(
		method: string,
		path: string,
		status: number,
		responseBody: unknown,
	): void {
		const key = `${method} ${path}`;
		this.exactQueues.set(key, [{ status, responseBody }]);
	}

	/**
	 * Replace the message queue for a session with paginated responses.
	 * The first call returns `page1`, subsequent calls return `page2`.
	 * Clears both exact and normalized queues to prevent stale entries
	 * from the recording taking precedence.
	 */
	setMessagePages(sessionId: string, page1: unknown[], page2: unknown[]): void {
		const pages = [
			{ status: 200, responseBody: page1 },
			{ status: 200, responseBody: page2 },
		];
		// Set exact key (matched first by handleRequest)
		const ek = `GET /session/${sessionId}/message`;
		this.exactQueues.set(ek, pages);
		// Also set normalized key as fallback
		const nk = "GET /session/:param/message";
		this.normalizedQueues.set(nk, [...pages]);
	}

	/**
	 * Emit a synthetic SSE event to all connected SSE clients.
	 * Use in tests that need a specific event without depending on
	 * the recording's SSE batch associations.
	 */
	emitTestEvent(
		type = "session.updated",
		properties: Record<string, unknown> = {},
	): void {
		const payload = JSON.stringify({ type, properties });
		const frame = `data: ${payload}\n\n`;
		for (const client of this.sseClients) {
			if (!client.writableEnded) {
				client.write(frame);
			}
		}
	}

	// ─── Session list fallback helpers ────────────────────────────────────
	// These mutate the GET /session queue's fallback entry in place so that
	// the standard queue-based response reflects create/delete/rename ops.

	private getSessionListFallback(): Array<Record<string, unknown>> {
		const queue = this.exactQueues.get("GET /session");
		if (!queue || queue.length === 0) return [];
		const fallback = queue.at(-1);
		if (!fallback || !Array.isArray(fallback.responseBody)) return [];
		return fallback.responseBody as Array<Record<string, unknown>>;
	}

	private injectIntoSessionListFallback(
		session: Record<string, unknown>,
	): void {
		const queue = this.exactQueues.get("GET /session");
		if (!queue || queue.length === 0) return;
		const fallback = queue.at(-1);
		if (!fallback || !Array.isArray(fallback.responseBody)) return;
		(fallback.responseBody as Array<Record<string, unknown>>).push(session);
	}

	private removeFromSessionListFallback(id: string): void {
		const queue = this.exactQueues.get("GET /session");
		if (!queue || queue.length === 0) return;
		const fallback = queue.at(-1);
		if (!fallback || !Array.isArray(fallback.responseBody)) return;
		fallback.responseBody = (
			fallback.responseBody as Array<Record<string, unknown>>
		).filter((s) => s["id"] !== id);
	}

	private renameInSessionListFallback(id: string, title: string): void {
		const list = this.getSessionListFallback();
		const session = list.find((s) => s["id"] === id);
		if (session) session["title"] = title;
	}

	/**
	 * Reset response queues without disconnecting SSE clients.
	 * For multi-test reuse within a shared relay.
	 */
	resetQueues(): void {
		this.exactQueues.clear();
		this.normalizedQueues.clear();
		this.ptyQueues.clear();
		this.promptsFired = 0;
		this.ptyCounter = 0;
		this.dynamicPtyIds.clear();
		this.injectedSessions.clear();
		this.deletedSessionIds.clear();
		this.renamedSessions.clear();
		this.sseIdleSessions.clear();
		this.sseMessages.clear();
		this.sessionCounter = 0;
		this.recordedPromptSessionIds = [];
		this.buildQueues();
	}

	// ─── Queue building ──────────────────────────────────────────────────────

	private buildQueues(): void {
		const { interactions } = this.recording;

		this.sseSegments = [[]];
		this.recordedPromptSessionIds = [];
		let currentSegment = 0;

		for (const ix of interactions) {
			if (ix.kind === "rest") {
				if (ix.method === "POST" && ix.path.includes("/prompt_async")) {
					currentSegment++;
					this.sseSegments[currentSegment] = [];
					// Extract the recording's session ID from the prompt URL
					const match = /\/session\/([^/]+)\/prompt_async/.exec(ix.path);
					if (match?.[1]) {
						this.recordedPromptSessionIds.push(match[1]);
					}
				}

				const queued: QueuedRestResponse = {
					status: ix.status,
					responseBody: ix.responseBody,
				};

				const ek = exactKey(ix.method, ix.path);
				const nk = normalizedKey(ix.method, ix.path);

				this.pushQueue(this.exactQueues, ek, queued);
				if (nk !== ek) {
					this.pushQueue(this.normalizedQueues, nk, { ...queued });
				}
			} else if (ix.kind === "sse") {
				this.sseSegments[currentSegment]?.push({
					type: ix.type,
					properties: ix.properties,
					delayMs: ix.delayMs,
				});
			} else {
				this.pushPty(ix);
			}
		}
	}

	/** Push a response onto a queue map. */
	private pushQueue(
		map: Map<string, QueuedRestResponse[]>,
		key: string,
		entry: QueuedRestResponse,
	): void {
		const existing = map.get(key);
		if (existing) {
			existing.push(entry);
		} else {
			map.set(key, [entry]);
		}
	}

	/** Return a queue from a map that has at least one response, or undefined. */
	private getActiveQueue(
		map: Map<string, QueuedRestResponse[]>,
		key: string,
	): QueuedRestResponse[] | undefined {
		const queue = map.get(key);
		return queue && queue.length > 0 ? queue : undefined;
	}

	private pushPty(ix: PtyInteraction): void {
		const id = ix.ptyId;
		const existing = this.ptyQueues.get(id);
		if (existing) {
			existing.push(ix);
		} else {
			this.ptyQueues.set(id, [ix]);
		}
	}

	// ─── HTTP request handling ───────────────────────────────────────────────

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const path = req.url ?? "/";
		const method = req.method ?? "GET";

		// Log all incoming requests for diagnostics (skip noisy status polls)
		if (!(method === "GET" && path === "/session/status")) {
			this.diag("request", `${method} ${path}`);
		}

		// SSE endpoint
		if (path === "/event" && method === "GET") {
			this.handleSse(res);
			return;
		}

		// Read request body (used by stateful session handlers)
		const rawBody = await this.readBody(req);

		const exact = exactKey(method, path);
		const normalized = normalizedKey(method, path);

		// ── Stateful PTY endpoints ──────────────────────────────────────────
		const basePath = path.split("?")[0] ?? path;

		if (method === "POST" && basePath === "/pty") {
			const id = `pty_mock${String(++this.ptyCounter).padStart(3, "0")}`;
			this.dynamicPtyIds.add(id);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ id }));
			return;
		}

		if (method === "GET" && basePath === "/pty") {
			const list = [...this.dynamicPtyIds].map((id) => ({ id }));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(list));
			return;
		}

		if (method === "DELETE" && /^\/pty\/[^/]+$/.test(basePath)) {
			const id = basePath.split("/").pop() ?? "";
			this.dynamicPtyIds.delete(id);
			res.writeHead(204);
			res.end();
			return;
		}

		if (method === "PUT" && /^\/pty\/[^/]+$/.test(basePath)) {
			// Resize — no-op, just acknowledge
			res.writeHead(204);
			res.end();
			return;
		}

		// ── Synthetic fallbacks for endpoints not in every recording ────────
		// These endpoints are called by relay handlers but may not appear in
		// the recorded interactions. Return empty arrays so the relay doesn't
		// crash with 404 errors during integration tests.
		if (method === "GET" && basePath === "/command") {
			const queue =
				this.getActiveQueue(this.exactQueues, exact) ??
				this.getActiveQueue(this.normalizedQueues, normalized);
			if (!queue) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify([]));
				return;
			}
		}

		if (method === "GET" && basePath === "/file") {
			const queue =
				this.getActiveQueue(this.exactQueues, exact) ??
				this.getActiveQueue(this.normalizedQueues, normalized);
			if (!queue) {
				// Return a minimal project directory listing so integration
				// tests that check for common project files can pass.
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify([
						{ name: "package.json", type: "file" },
						{ name: "tsconfig.json", type: "file" },
						{ name: "src", type: "directory" },
						{ name: "test", type: "directory" },
					]),
				);
				return;
			}
		}

		if (method === "GET" && basePath === "/file/content") {
			const queue =
				this.getActiveQueue(this.exactQueues, exact) ??
				this.getActiveQueue(this.normalizedQueues, normalized);
			if (!queue) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ content: "", binary: false }));
				return;
			}
		}

		// ── Stateful session endpoints ──────────────────────────────────────
		// POST /session: use queue if available, otherwise generate dynamic session.
		// Dynamic sessions are injected into the GET /session queue fallback so
		// subsequent list requests include them without a separate intercept.
		if (method === "POST" && basePath === "/session") {
			let title = "Untitled";
			if (rawBody) {
				try {
					const parsed = JSON.parse(rawBody) as Record<string, unknown>;
					if (typeof parsed["title"] === "string") title = parsed["title"];
				} catch {
					/* ignore */
				}
			}

			// Use queue if entries remain (consume extras, reuse last as fallback);
			// only generate a dynamic session when the queue is completely empty.
			const sessionQueue = this.getActiveQueue(
				this.exactQueues,
				"POST /session",
			);
			if (sessionQueue && sessionQueue.length >= 1) {
				const entry =
					sessionQueue.length > 1
						? (sessionQueue.shift() as QueuedRestResponse)
						: (sessionQueue[0] as QueuedRestResponse);
				// Apply the requested title and ensure the session appears in
				// the GET /session fallback so subsequent list calls include it.
				const body = { ...(entry.responseBody as Record<string, unknown>) };
				if (title !== "Untitled") {
					body["title"] = title;
				}
				const sessionId = body["id"] as string;
				// Track the title so GET /session renames queue-entry responses too
				if (sessionId && title !== "Untitled") {
					this.renamedSessions.set(sessionId, title);
				}
				if (sessionId) {
					// Un-delete if this ID was previously deleted (fallback reuse)
					this.deletedSessionIds.delete(sessionId);
					// Track this session so GET /session always includes it
					this.injectedSessions.set(sessionId, { ...body });
					// Also inject into fallback for consistency
					const fallbackList = this.getSessionListFallback();
					const existing = fallbackList.find((s) => s["id"] === sessionId);
					if (existing) {
						if (title !== "Untitled") existing["title"] = title;
					} else {
						this.injectIntoSessionListFallback({ ...body });
					}
				}
				res.writeHead(entry.status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
				return;
			}

			// Generate dynamic session and inject into GET /session fallback
			const id = `ses_mock${String(++this.sessionCounter).padStart(3, "0")}`;
			const session = { id, title, createdAt: new Date().toISOString() };
			this.injectedSessions.set(id, { ...session });
			this.injectIntoSessionListFallback(session);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(session));
			return;
		}

		// GET /session: let the queue produce the base list, then apply
		// renames and filter deletes so every response reflects mutations.
		if (method === "GET" && basePath === "/session") {
			const sessionQueue =
				this.getActiveQueue(this.exactQueues, exact) ??
				this.getActiveQueue(this.normalizedQueues, normalized);

			if (sessionQueue) {
				const entry =
					sessionQueue.length > 1
						? (sessionQueue.shift() as QueuedRestResponse)
						: (sessionQueue[0] as QueuedRestResponse);
				let list = Array.isArray(entry.responseBody)
					? [...(entry.responseBody as Array<Record<string, unknown>>)]
					: [];

				// Apply renames
				for (const item of list) {
					const id = item["id"] as string;
					const newTitle = this.renamedSessions.get(id);
					if (newTitle !== undefined) item["title"] = newTitle;
				}

				// Merge injected sessions not already in list
				for (const [id, session] of this.injectedSessions) {
					if (!list.some((s) => s["id"] === id)) {
						const renamedTitle = this.renamedSessions.get(id);
						list.push(
							renamedTitle
								? { ...session, title: renamedTitle }
								: { ...session },
						);
					}
				}

				// Filter deletes
				list = list.filter(
					(s) => !this.deletedSessionIds.has(s["id"] as string),
				);

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(list));
				return;
			}
		}

		if (method === "DELETE" && /^\/session\/[^/]+$/.test(basePath)) {
			const id = basePath.split("/").pop() ?? "";
			this.deletedSessionIds.add(id);
			this.injectedSessions.delete(id);
			this.removeFromSessionListFallback(id);
			res.writeHead(204);
			res.end();
			return;
		}

		if (method === "PATCH" && /^\/session\/[^/]+$/.test(basePath)) {
			const id = basePath.split("/").pop() ?? "";
			let title: string | undefined;
			if (rawBody) {
				try {
					const parsed = JSON.parse(rawBody) as Record<string, unknown>;
					if (typeof parsed["title"] === "string") title = parsed["title"];
				} catch {
					/* ignore */
				}
			}
			if (title !== undefined) {
				this.renamedSessions.set(id, title);
				this.renameInSessionListFallback(id, title);
				const injected = this.injectedSessions.get(id);
				if (injected) injected["title"] = title;
			}
			const fallbackList = this.getSessionListFallback();
			const found = fallbackList.find((s) => s["id"] === id);
			const session = found ?? { id, title: title ?? "mock-title" };
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(session));
			return;
		}

		if (method === "GET" && basePath === "/session/search") {
			const queryString = path.split("?")[1] ?? "";
			const params = new URLSearchParams(queryString);
			const query = (
				params.get("q") ??
				params.get("query") ??
				""
			).toLowerCase();

			// Search both fallback list and injected sessions
			const fallbackList = this.getSessionListFallback();
			const allSessions = [...fallbackList];
			for (const [id, session] of this.injectedSessions) {
				if (!allSessions.some((s) => s["id"] === id)) {
					const renamedTitle = this.renamedSessions.get(id);
					allSessions.push(
						renamedTitle ? { ...session, title: renamedTitle } : { ...session },
					);
				}
			}
			const matches = allSessions
				.filter((s) => !this.deletedSessionIds.has(s["id"] as string))
				.filter((s) => {
					const title = String(s["title"] ?? "").toLowerCase();
					return title.includes(query);
				});

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(matches));
			return;
		}

		// ── GET /session/status: filter out SSE-idle sessions ──────────────
		// When SSE has emitted session.status:idle for a session, the status
		// endpoint must agree — the real OpenCode server is consistent. Without
		// this, the status poller consumes stale "busy" queue entries and
		// re-injects processing state after SSE already delivered "done".
		if (method === "GET" && basePath === "/session/status") {
			const statusQueue =
				this.getActiveQueue(this.exactQueues, exact) ??
				this.getActiveQueue(this.normalizedQueues, normalized);
			if (statusQueue) {
				const shifted =
					statusQueue.length > 1 ? statusQueue.shift() : undefined;
				const statusEntry = shifted ?? statusQueue[0];
				if (statusEntry && this.sseIdleSessions.size > 0) {
					const body =
						typeof statusEntry.responseBody === "object" &&
						statusEntry.responseBody !== null
							? { ...(statusEntry.responseBody as Record<string, unknown>) }
							: statusEntry.responseBody;
					// Remove sessions that SSE has confirmed idle
					if (typeof body === "object" && body !== null) {
						for (const sid of this.sseIdleSessions) {
							delete (body as Record<string, unknown>)[sid];
						}
					}
					res.writeHead(statusEntry.status, {
						"Content-Type": "application/json",
					});
					res.end(JSON.stringify(body));
					return;
				}
				if (statusEntry) {
					res.writeHead(statusEntry.status, {
						"Content-Type": "application/json",
					});
					res.end(JSON.stringify(statusEntry.responseBody));
					return;
				}
			}
			// No queue — return empty status
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({}));
			return;
		}

		// ── GET /session/{id}/message: serve SSE-accumulated messages ─────────
		// After a prompt_async has been processed, SSE events accumulate message
		// data in sseMessages. Serve these when the queue would return empty.
		if (method === "GET" && /^\/session\/[^/]+\/message$/.test(basePath)) {
			const segments = basePath.split("/");
			const sessionId = segments[2];
			const sessionMsgs = sessionId
				? this.sseMessages.get(sessionId)
				: undefined;
			if (sessionMsgs && sessionMsgs.size > 0) {
				const messages = [...sessionMsgs.values()].map((m) => ({
					info: m.info,
					parts: m.parts,
				}));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(messages));
				return;
			}
		}

		// Look up exact path first, then fall back to normalized (parameterized).
		// Exact match ensures that requests for a specific session ID get the
		// correct recorded response. Normalized fallback handles session IDs
		// not present in the recording (e.g. init-time fetches for pre-existing
		// sessions the recording didn't explicitly interact with).
		const queue =
			this.getActiveQueue(this.exactQueues, exact) ??
			this.getActiveQueue(this.normalizedQueues, normalized);

		if (!queue) {
			res.writeHead(404);
			res.end(
				JSON.stringify({ error: "no queued response", exact, normalized }),
			);
			return;
		}

		// Dequeue next response, or repeat last if exhausted
		const shifted = queue.length > 1 ? queue.shift() : undefined;
		const entry = shifted ?? queue[0];
		if (!entry) {
			res.writeHead(404);
			res.end(JSON.stringify({ error: "empty queue", exact, normalized }));
			return;
		}

		// Detect prompt_async — emit the corresponding SSE segment.
		// Rewrite session IDs in SSE events so that the relay routes them
		// to the session the test is actually using (not the recording's).
		if (method === "POST" && path.includes("/prompt_async")) {
			this.promptsFired++;
			const sseClientCount = this.sseClients.size;

			// Extract the actual session ID the test is prompting
			const promptMatch = /\/session\/([^/]+)\/prompt_async/.exec(path);
			const actualSessionId = promptMatch?.[1];

			// Determine which recorded session ID to replace:
			// promptsFired=1 → recordedPromptSessionIds[0], etc.
			const recordedSessionId =
				this.recordedPromptSessionIds[this.promptsFired - 1];

			// Build the session ID mapping for rewriting
			const sessionIdMap =
				actualSessionId &&
				recordedSessionId &&
				actualSessionId !== recordedSessionId
					? { from: recordedSessionId, to: actualSessionId }
					: undefined;

			if (this.promptsFired === 1) {
				const combined = [
					...(this.sseSegments[0] ?? []),
					...(this.sseSegments[1] ?? []),
				];
				this.diag(
					"prompt_async",
					`#${this.promptsFired} seg0=${this.sseSegments[0]?.length ?? 0} seg1=${this.sseSegments[1]?.length ?? 0} combined=${combined.length} sseClients=${sseClientCount}${sessionIdMap ? ` rewrite=${sessionIdMap.from.slice(0, 12)}→${sessionIdMap.to.slice(0, 12)}` : ""}`,
				);
				this.emitEvents(combined, sessionIdMap);
			} else {
				const segment = this.sseSegments[this.promptsFired] ?? [];
				this.diag(
					"prompt_async",
					`#${this.promptsFired} segment=${segment.length} sseClients=${sseClientCount}${sessionIdMap ? ` rewrite=${sessionIdMap.from.slice(0, 12)}→${sessionIdMap.to.slice(0, 12)}` : ""}`,
				);
				this.emitEvents(segment, sessionIdMap);
			}
		}

		if (entry.status === 204) {
			res.writeHead(204);
			res.end();
		} else {
			res.writeHead(entry.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(entry.responseBody));
		}
	}

	// ─── SSE handling ────────────────────────────────────────────────────────

	private handleSse(res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		// Flush headers so the client's body reader starts streaming.
		// SSE comments (lines starting with ':') are ignored by clients.
		res.write(": ok\n\n");

		// Keepalive every 15 seconds
		const interval = setInterval(() => {
			if (!res.writableEnded) {
				res.write(": keepalive\n\n");
			}
		}, 15_000);
		this.keepaliveIntervals.add(interval);

		this.sseClients.add(res);
		this.diag("sse_connect", `clients=${this.sseClients.size}`);

		res.on("close", () => {
			this.sseClients.delete(res);
			this.diag("sse_disconnect", `clients=${this.sseClients.size}`);
			clearInterval(interval);
			this.keepaliveIntervals.delete(interval);
		});
	}

	/**
	 * Inject SSE events directly into all connected SSE clients.
	 * For use in tests that need to trigger relay behavior (e.g., done events)
	 * without going through the recorded queue system.
	 */
	public injectSSEEvents(
		events: Array<{ type: string; properties: Record<string, unknown> }>,
	): void {
		const batch: SseEvent[] = events.map((e) => ({
			type: e.type,
			properties: e.properties,
			delayMs: 0,
		}));
		this.emitEvents(batch);
	}

	/**
	 * Rewrite session IDs in SSE event properties.
	 * Only replaces occurrences of `map.from` with `map.to` so that
	 * events for other sessions (e.g. session.created for the NEXT session)
	 * are left untouched.
	 */
	private rewriteSessionIds(
		properties: Record<string, unknown>,
		map: { from: string; to: string },
	): Record<string, unknown> {
		const props = structuredClone(properties);
		// Top-level sessionID (most common: message.part.delta, session.status, etc.)
		if (props["sessionID"] === map.from) {
			props["sessionID"] = map.to;
		}
		// Nested in part (message.part.updated)
		const part = props["part"] as Record<string, unknown> | undefined;
		if (part && part["sessionID"] === map.from) {
			part["sessionID"] = map.to;
		}
		// Nested in info (session.updated, message.updated)
		const info = props["info"] as Record<string, unknown> | undefined;
		if (info) {
			if (info["id"] === map.from) info["id"] = map.to;
			if (info["sessionID"] === map.from) info["sessionID"] = map.to;
		}
		return props;
	}

	private emitEvents(
		events: SseEvent[],
		sessionIdMap?: { from: string; to: string },
	): void {
		if (events.length === 0) return;
		this.diag(
			"emit_start",
			`count=${events.length} types=${[...new Set(events.map((e) => e.type))].join(",")} sseClients=${this.sseClients.size}`,
		);

		void (async () => {
			let emitCount = 0;
			for (const event of events) {
				const delay = Math.min(event.delayMs, 5);
				if (delay > 0) {
					await new Promise<void>((r) => setTimeout(r, delay));
				}

				const properties = sessionIdMap
					? this.rewriteSessionIds(event.properties, sessionIdMap)
					: event.properties;

				const payload = JSON.stringify({
					type: event.type,
					properties,
				});
				const frame = `data: ${payload}\n\n`;

				let delivered = false;
				for (const client of this.sseClients) {
					if (!client.writableEnded) {
						client.write(frame);
						delivered = true;
					}
				}

				// Track session.status:idle events so GET /session/status
				// stays consistent with SSE (prevents stale "busy" queue
				// entries from re-injecting processing state).
				// Only update when the event was actually delivered — if the
				// SSE consumer hasn't connected yet, the status poller's
				// secondary done-delivery path must remain functional.
				if (delivered && event.type === "session.status") {
					const status = properties["status"] as { type?: string } | undefined;
					const sid = properties["sessionID"] as string | undefined;
					if (status?.type === "idle" && sid) {
						this.sseIdleSessions.add(sid);
					} else if (status?.type === "busy" && sid) {
						this.sseIdleSessions.delete(sid);
					}
				}

				// Accumulate messages from SSE events so GET /session/{id}/message
				// returns non-empty data after a prompt_async has been processed.
				this.trackSseMessage(event.type, properties);

				emitCount++;
			}
			this.diag("emit_done", `emitted=${emitCount}/${events.length}`);
		})();
	}

	/**
	 * Track message data from SSE events to build GET /session/{id}/message responses.
	 * Called for every emitted SSE event. Accumulates message.updated (info) and
	 * message.part.updated (parts) into sseMessages per session.
	 */
	private trackSseMessage(
		type: string,
		properties: Record<string, unknown>,
	): void {
		if (type === "message.updated") {
			const info = properties["info"] as Record<string, unknown> | undefined;
			if (!info) return;
			const sessionId = info["sessionID"] as string | undefined;
			const messageId = info["id"] as string | undefined;
			if (!sessionId || !messageId) return;
			let sessionMap = this.sseMessages.get(sessionId);
			if (!sessionMap) {
				sessionMap = new Map();
				this.sseMessages.set(sessionId, sessionMap);
			}
			const existing = sessionMap.get(messageId);
			if (existing) {
				existing.info = { ...info };
			} else {
				sessionMap.set(messageId, { info: { ...info }, parts: [] });
			}
		} else if (type === "message.part.updated") {
			const part = properties["part"] as Record<string, unknown> | undefined;
			if (!part) return;
			const sessionId = part["sessionID"] as string | undefined;
			const messageId = part["messageID"] as string | undefined;
			const partId = part["id"] as string | undefined;
			if (!sessionId || !messageId || !partId) return;
			let sessionMap = this.sseMessages.get(sessionId);
			if (!sessionMap) {
				sessionMap = new Map();
				this.sseMessages.set(sessionId, sessionMap);
			}
			let msg = sessionMap.get(messageId);
			if (!msg) {
				msg = { info: { id: messageId, sessionID: sessionId }, parts: [] };
				sessionMap.set(messageId, msg);
			}
			// Update existing part or append new one
			const existingIdx = msg.parts.findIndex((p) => p["id"] === partId);
			if (existingIdx >= 0) {
				msg.parts[existingIdx] = { ...part };
			} else {
				msg.parts.push({ ...part });
			}
		}
	}

	// ─── PTY WebSocket handling ──────────────────────────────────────────────

	private handleUpgrade(
		req: IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
		wss: WebSocketServer,
	): void {
		const urlPath = req.url ?? "";
		const ptyMatch = /\/pty\/([^/]+)\/connect/.exec(urlPath);

		if (!ptyMatch?.[1]) {
			socket.destroy();
			return;
		}

		const ptyId = ptyMatch[1];
		const queue = this.ptyQueues.get(ptyId);

		if (!queue || queue.length === 0) {
			// No recording data — accept connection in echo mode
			wss.handleUpgrade(req, socket, head, (ws) => {
				// Send an initial prompt so xterm has content
				if (ws.readyState === WebSocket.OPEN) {
					ws.send("$ ");
				}
				ws.on("message", (data: Buffer, isBinary: boolean) => {
					// Echo text frames back as output
					if (!isBinary && ws.readyState === WebSocket.OPEN) {
						ws.send(data.toString());
					}
				});
			});
			return;
		}

		// Find and consume the pty-open interaction
		const openIdx = queue.findIndex((ix) => ix.kind === "pty-open");
		if (openIdx < 0) {
			// Has queue data but no pty-open — fall back to echo mode
			wss.handleUpgrade(req, socket, head, (ws) => {
				ws.on("message", (data: Buffer, isBinary: boolean) => {
					if (!isBinary && ws.readyState === WebSocket.OPEN) {
						ws.send(data.toString());
					}
				});
			});
			return;
		}
		queue.splice(openIdx, 1);

		wss.handleUpgrade(req, socket, head, (ws) => {
			void this.replayPtyOutput(ptyId, ws);

			ws.on("message", (_data, isBinary) => {
				if (isBinary) return;
				const currentQueue = this.ptyQueues.get(ptyId);
				if (!currentQueue) return;
				const nextInput = currentQueue.findIndex(
					(ix) => ix.kind === "pty-input",
				);
				if (nextInput >= 0) {
					currentQueue.splice(nextInput, 1);
				}
			});
		});
	}

	private async replayPtyOutput(ptyId: string, ws: WebSocket): Promise<void> {
		const queue = this.ptyQueues.get(ptyId);
		if (!queue) return;

		while (queue.length > 0) {
			const next = queue[0];
			if (!next) break;

			if (next.kind === "pty-output") {
				queue.shift();
				const delay = Math.min(next.delayMs, 5);
				if (delay > 0) {
					await new Promise<void>((r) => setTimeout(r, delay));
				}
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(next.data);
				}
			} else if (next.kind === "pty-close") {
				queue.shift();
				const delay = Math.min(next.delayMs, 5);
				if (delay > 0) {
					await new Promise<void>((r) => setTimeout(r, delay));
				}
				if (ws.readyState === WebSocket.OPEN) {
					const code =
						next.code === 1005 || next.code === 1006 ? 1000 : next.code;
					ws.close(code, next.reason);
				}
				return;
			} else if (next.kind === "pty-input") {
				// Wait for client to consume this input event
				await new Promise<void>((r) => setTimeout(r, 10));
				if (queue[0] === next) break;
			} else {
				queue.shift();
			}
		}
	}

	// ─── Cleanup helpers ─────────────────────────────────────────────────────

	private cleanupSseClients(): void {
		for (const interval of this.keepaliveIntervals) {
			clearInterval(interval);
		}
		this.keepaliveIntervals.clear();

		for (const client of this.sseClients) {
			if (!client.writableEnded) {
				client.end();
			}
		}
		this.sseClients.clear();
	}

	private readBody(req: IncomingMessage): Promise<string | undefined> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				if (chunks.length === 0) resolve(undefined);
				else resolve(Buffer.concat(chunks).toString());
			});
			req.on("error", () => resolve(undefined));
		});
	}
}
