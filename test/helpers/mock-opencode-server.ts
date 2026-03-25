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

/** A queued REST response with an optional SSE batch to emit after sending. */
interface QueuedRestResponse {
	status: number;
	responseBody: unknown;
	sseBatch: SseEvent[];
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

export class MockOpenCodeServer {
	private readonly recording: OpenCodeRecording;
	private server: Server | undefined;
	private wss: WebSocketServer | undefined;
	private _url = "";

	// Replay state (rebuilt on reset)
	private exactQueues = new Map<string, QueuedRestResponse[]>();
	private normalizedQueues = new Map<string, QueuedRestResponse[]>();
	private ptyQueues = new Map<string, PtyInteraction[]>();
	private sseClients = new Set<ServerResponse>();
	private keepaliveIntervals = new Set<ReturnType<typeof setInterval>>();

	/**
	 * When set, GET /session/status returns this response instead of the
	 * queued entry. Set when an SSE batch containing session.idle fires,
	 * ensuring subsequent status polls see idle state regardless of what
	 * the queue contains. Cleared on reset() for multi-test reuse.
	 */
	private statusOverride: QueuedRestResponse | undefined;

	/** Counter for generating unique PTY IDs when no recording exists. */
	private ptyCounter = 0;

	/** Dynamically created PTY IDs (not from recording). */
	private dynamicPtyIds = new Set<string>();

	/** Sessions injected via POST /session (tracked separately for merging into all GET /session responses). */
	private injectedSessions = new Map<string, Record<string, unknown>>();

	/** Session IDs that have been deleted (filtered from GET /session). */
	private deletedSessionIds = new Set<string>();

	/** Title overrides from PATCH /session/:id. */
	private renamedSessions = new Map<string, string>();

	/** Counter for generating unique session IDs. */
	private sessionCounter = 0;

	/**
	 * Whether the prompt has been sent (POST prompt_async consumed).
	 * SSE batches are buffered until the prompt fires, preventing init-time
	 * REST consumption from emitting SSE events before the browser client
	 * is viewing the target session.
	 */
	private promptFired = false;

	/** SSE batches queued before the prompt was sent. */
	private pendingSseBatches: SseEvent[][] = [];

	constructor(recording: OpenCodeRecording) {
		this.recording = recording;
		this.targetSessionId = this.findTargetSessionId();
		this.buildQueues();
	}

	/** The session ID used in prompt_async calls in the recording, if any. */
	readonly targetSessionId: string | undefined;

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
		this.statusOverride = undefined;
		this.promptFired = false;
		this.pendingSseBatches = [];
		this.ptyCounter = 0;
		this.dynamicPtyIds.clear();
		this.injectedSessions.clear();
		this.deletedSessionIds.clear();
		this.renamedSessions.clear();
		this.sessionCounter = 0;
		this.buildQueues();
	}

	/**
	 * Force-flush any pending SSE batches without requiring a prompt.
	 * Use in tests that need SSE events from REST activity alone.
	 */
	flushPendingSse(): void {
		this.promptFired = true;
		for (const batch of this.pendingSseBatches) {
			this.emitSseBatch(batch);
		}
		this.pendingSseBatches = [];
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
		this.exactQueues.set(key, [{ status, responseBody, sseBatch: [] }]);
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
	 *
	 * Preserves `statusOverride` so that background status pollers
	 * continue to see the correct idle/busy state between tests.
	 * The override is cleared naturally when the next prompt_async fires.
	 */
	resetQueues(): void {
		this.exactQueues.clear();
		this.normalizedQueues.clear();
		this.ptyQueues.clear();
		// Keep promptFired=true if SSE clients are connected — the relay is
		// already viewing a session, so SSE batches should emit immediately.
		if (this.sseClients.size === 0) {
			this.promptFired = false;
		}
		this.pendingSseBatches = [];
		this.ptyCounter = 0;
		this.dynamicPtyIds.clear();
		this.injectedSessions.clear();
		this.deletedSessionIds.clear();
		this.renamedSessions.clear();
		this.sessionCounter = 0;
		this.buildQueues();
	}

	// ─── Queue building ──────────────────────────────────────────────────────

	private buildQueues(): void {
		const { interactions } = this.recording;

		interface RestEntry {
			exactKey: string;
			normalizedKey: string;
			status: number;
			responseBody: unknown;
		}

		const restEntries: RestEntry[] = [];
		const sseBatches: SseEvent[][] = [];

		let currentSseBatch: SseEvent[] = [];
		let lastRestIndex = -1;

		for (const ix of interactions) {
			if (ix.kind === "rest") {
				// Attach pending SSE batch to the PREVIOUS REST entry
				if (lastRestIndex >= 0 && currentSseBatch.length > 0) {
					sseBatches[lastRestIndex] = currentSseBatch;
					currentSseBatch = [];
				}

				lastRestIndex = restEntries.length;
				restEntries.push({
					exactKey: exactKey(ix.method, ix.path),
					normalizedKey: normalizedKey(ix.method, ix.path),
					status: ix.status,
					responseBody: ix.responseBody,
				});
				sseBatches[lastRestIndex] = [];
			} else if (ix.kind === "sse") {
				currentSseBatch.push({
					type: ix.type,
					properties: ix.properties,
					delayMs: ix.delayMs,
				});
			} else {
				// PTY interactions
				this.pushPty(ix);
			}
		}

		// Attach any trailing SSE events to the last REST entry
		if (lastRestIndex >= 0 && currentSseBatch.length > 0) {
			sseBatches[lastRestIndex] = currentSseBatch;
		}

		// Build REST queues keyed by exact path (primary) and normalized path (fallback).
		// Exact keys (e.g. "GET /session/ses_abc123/message") ensure the mock serves
		// the right response when the relay requests a specific session ID.
		// Normalized keys (e.g. "GET /session/:param/message") serve as fallbacks for
		// session IDs not present in the recording (e.g. during init when the relay
		// fetches messages for sessions it discovers in the session list).
		for (let i = 0; i < restEntries.length; i++) {
			const entry = restEntries[i];
			if (!entry) continue;
			const batch = sseBatches[i] ?? [];
			const queued: QueuedRestResponse = {
				status: entry.status,
				responseBody: entry.responseBody,
				sseBatch: batch,
			};

			// Primary: exact path
			this.pushQueue(this.exactQueues, entry.exactKey, queued);

			// Fallback: normalized path (separate copy to avoid shared-shift issues)
			if (entry.normalizedKey !== entry.exactKey) {
				this.pushQueue(this.normalizedQueues, entry.normalizedKey, {
					...queued,
					sseBatch: [...batch],
				});
			}
		}

		// Inject fallback responses for essential init endpoints that may be
		// missing from recordings captured after the initial health check.
		this.ensureFallback("GET /path", 200, {
			home: "/tmp",
			state: "/tmp/.local/state/opencode",
			config: "/tmp/config/opencode",
			worktree: process.cwd(),
			directory: process.cwd(),
		});

		// Commands and file-listing endpoints are used by discovery tests but
		// are rarely present in recordings.  Provide sensible defaults so the
		// relay can serve command_list / file_list without a 404.
		this.ensureFallback("GET /command", 200, [
			{ name: "help", description: "Show available commands" },
			{ name: "compact", description: "Compact conversation history" },
		]);
		this.ensureFallback("GET /file", 200, [
			{ name: "package.json", type: "file" },
			{ name: "src", type: "directory" },
			{ name: "test", type: "directory" },
		]);

		// Ensure the relay selects the recording's target session at init
		this.promoteTargetSession();

		// Override normalized message fallback with empty arrays.
		// During init the relay fetches messages for ALL sessions in the list.
		// Non-target sessions hit the normalized fallback. Without this override,
		// they'd get the target session's messages (complete with timestamps),
		// which can make the sort pick the wrong session as default.
		const msgNormKey = "GET /session/:param/message";
		this.normalizedQueues.set(msgNormKey, [
			{ status: 200, responseBody: [], sseBatch: [] },
		]);
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

	/** Add a fallback response for an endpoint if it's not already in either queue. */
	private ensureFallback(
		key: string,
		status: number,
		responseBody: unknown,
	): void {
		if (this.exactQueues.has(key) || this.normalizedQueues.has(key)) return;
		this.exactQueues.set(key, [{ status, responseBody, sseBatch: [] }]);
	}

	/** Return a queue from a map that has at least one response, or undefined. */
	private getActiveQueue(
		map: Map<string, QueuedRestResponse[]>,
		key: string,
	): QueuedRestResponse[] | undefined {
		const queue = map.get(key);
		return queue && queue.length > 0 ? queue : undefined;
	}

	/**
	 * Find the session ID used in prompt_async calls in the recording.
	 * This is the "target" session that the relay should view when replaying.
	 */
	private findTargetSessionId(): string | undefined {
		for (const ix of this.recording.interactions) {
			if (ix.kind === "rest" && ix.method === "POST") {
				const match = /\/session\/([^/]+)\/prompt_async/.exec(ix.path);
				if (match?.[1]) return match[1];
			}
		}
		return undefined;
	}

	/**
	 * Promote the target session to the top of GET /session list responses.
	 * This ensures the relay selects the recording's session during init,
	 * matching the session ID in SSE events and prompt_async calls.
	 */
	private promoteTargetSession(): void {
		const targetId = this.targetSessionId;
		if (!targetId) return;

		// Find the POST /session response that created the target session
		let targetSession: Record<string, unknown> | undefined;
		for (const ix of this.recording.interactions) {
			if (
				ix.kind === "rest" &&
				ix.method === "POST" &&
				ix.path === "/session"
			) {
				const body = ix.responseBody as Record<string, unknown> | undefined;
				if (body && typeof body === "object" && body["id"] === targetId) {
					targetSession = body;
					break;
				}
			}
		}
		if (!targetSession) return;

		// Patch all GET /session responses to include the target session at the top
		for (const [key, queue] of this.exactQueues) {
			if (key !== "GET /session") continue;
			for (const entry of queue) {
				if (!Array.isArray(entry.responseBody)) continue;
				const list = entry.responseBody as Array<Record<string, unknown>>;
				// Only add if not already present
				if (!list.some((s) => s["id"] === targetId)) {
					list.unshift(targetSession);
				}
			}
		}
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

		// SSE endpoint
		if (path === "/event" && method === "GET") {
			this.handleSse(res);
			return;
		}

		// Read request body (used by stateful session handlers)
		const rawBody = await this.readBody(req);

		const exact = exactKey(method, path);
		const normalized = normalizedKey(method, path);

		// If session.idle has fired, return the idle override for status polls
		// instead of consuming from the queue. This ensures the relay's status
		// poller sees idle state immediately, avoiding a race where the queue
		// still has stale "busy" entries or the message poller re-injects busy.
		if (this.statusOverride && exact === "GET /session/status") {
			const override = this.statusOverride;
			res.writeHead(override.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(override.responseBody));
			return;
		}

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
				if (entry.sseBatch.length > 0) {
					if (this.promptFired) {
						this.emitSseBatch(entry.sseBatch);
					} else {
						this.pendingSseBatches.push(entry.sseBatch);
					}
				}
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

				if (entry.sseBatch.length > 0) {
					if (this.promptFired) {
						this.emitSseBatch(entry.sseBatch);
					} else {
						this.pendingSseBatches.push(entry.sseBatch);
					}
				}
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

		// Detect prompt_async — marks the boundary between init and active replay.
		// Flush any pending SSE batches that were buffered during init.
		// Clear the statusOverride so the status queue is used again (the next
		// turn's busy status needs to come from the queue, not the stale idle
		// override from the previous turn's session.idle).
		if (method === "POST" && path.includes("/prompt_async")) {
			this.promptFired = true;
			this.statusOverride = undefined;
			for (const batch of this.pendingSseBatches) {
				this.emitSseBatch(batch);
			}
			this.pendingSseBatches = [];
		}

		if (entry.status === 204) {
			res.writeHead(204);
			res.end();
		} else {
			res.writeHead(entry.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(entry.responseBody));
		}

		// Emit associated SSE batch to all connected clients.
		// Before the prompt fires, buffer batches instead of emitting them —
		// REST entries consumed during relay init would fire SSE events before
		// the browser client is viewing the target session, causing them to be
		// dropped by the relay's session-scoped routing.
		if (entry.sseBatch.length > 0) {
			if (this.promptFired) {
				this.emitSseBatch(entry.sseBatch);
			} else {
				this.pendingSseBatches.push(entry.sseBatch);
			}
		}
	}

	// ─── SSE handling ────────────────────────────────────────────────────────

	private handleSse(res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		// Immediately emit server.connected
		res.write('data: {"type":"server.connected","properties":{}}\n\n');

		// Keepalive every 15 seconds
		const interval = setInterval(() => {
			if (!res.writableEnded) {
				res.write(": keepalive\n\n");
			}
		}, 15_000);
		this.keepaliveIntervals.add(interval);

		this.sseClients.add(res);

		res.on("close", () => {
			this.sseClients.delete(res);
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
		this.emitSseBatch(batch);
	}

	private emitSseBatch(batch: SseEvent[]): void {
		// Check if this batch contains a session.idle event. If so, override
		// the status queue to return idle (empty object) for all subsequent
		// GET /session/status calls. This prevents the relay's status poller
		// from seeing stale "busy" entries that the queue hasn't consumed yet.
		const hasIdle = batch.some((e) => e.type === "session.idle");
		if (hasIdle) {
			this.statusOverride = { status: 200, responseBody: {}, sseBatch: [] };
		}

		void (async () => {
			for (const event of batch) {
				const delay = Math.min(event.delayMs, 5);
				if (delay > 0) {
					await new Promise<void>((r) => setTimeout(r, delay));
				}

				const payload = JSON.stringify({
					type: event.type,
					properties: event.properties,
				});
				const frame = `data: ${payload}\n\n`;

				for (const client of this.sseClients) {
					if (!client.writableEnded) {
						client.write(frame);
					}
				}
			}
		})();
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
