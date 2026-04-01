// ─── REST API Client (Ticket 1.4) ────────────────────────────────────────────
// Typed HTTP client wrapper for OpenCode's REST API.
// All state lives in OpenCode (SQLite). The relay never caches or duplicates.

import { DEFAULT_OPENCODE_URL } from "../constants.js";
import { ENV } from "../env.js";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";
import { createLogger } from "../logger.js";

const log = createLogger("opencode-client");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenCodeClientOptions {
	baseUrl?: string;
	auth?: { username: string; password: string };
	timeout?: number;
	retries?: number;
	retryDelay?: number;
	/** Absolute directory path for per-project scoping via x-opencode-directory header. */
	directory?: string;
}

export interface SessionCreateOptions {
	title?: string;
	agentID?: string;
	providerID?: string;
	modelID?: string;
}

export interface SessionListOptions {
	archived?: boolean;
	roots?: boolean;
	limit?: number;
}

export type SessionStatus =
	| { type: "idle" }
	| { type: "busy" }
	| { type: "retry"; attempt: number; message: string; next: number };

export interface PromptOptions {
	text: string;
	images?: string[];
	agent?: string;
	model?: { providerID: string; modelID: string };
	variant?: string;
}

export interface PermissionReplyOptions {
	id: string;
	decision: "once" | "always" | "reject";
}

export interface QuestionReplyOptions {
	id: string;
	answers: string[][];
}

export interface Agent {
	id: string;
	name: string;
	description?: string;
	/** Agent mode: "primary" (user-facing), "subagent" (task tool), or "all" */
	mode?: string;
	/** Whether the agent is hidden from user selection */
	hidden?: boolean;
}

export interface Provider {
	id: string;
	name: string;
	models?: Array<{
		id: string;
		name: string;
		limit?: { context?: number; output?: number };
		variants?: Record<string, Record<string, unknown>>;
	}>;
}

export interface ProviderListResult {
	providers: Provider[];
	defaults: Record<string, string>;
	connected: string[];
}

export interface PtyCreateOptions {
	command?: string;
	args?: string[];
	cwd?: string;
}

export interface HealthResponse {
	ok: boolean;
	version?: string;
}

export interface SessionDetail {
	id: string;
	slug?: string;
	title?: string;
	version?: string;
	projectID?: string;
	directory?: string;
	parentID?: string;
	time?: {
		created?: number;
		updated?: number;
		compacting?: number;
		archived?: number;
	};
	/** @deprecated Use time.archived instead */
	archived?: boolean;
	agentID?: string;
	providerID?: string;
	modelID?: string;
}

export interface Message {
	id: string;
	role: string;
	sessionID: string;
	parts?: Array<{
		id: string;
		type: string;
		[key: string]: unknown;
	}>;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	time?: { created?: number; completed?: number };
}

/**
 * Normalize an OpenCode message from its API format to the relay's flat format.
 *
 * OpenCode returns messages as `{ info: { id, role, sessionID, ... }, parts: [...] }`.
 * The relay expects `{ id, role, sessionID, parts, ... }` (flat structure).
 * This flattens the `info` wrapper so downstream code can access fields directly.
 */

/** Runtime check that an object has the minimum shape of a Message. */
function hasMessageShape(obj: Record<string, unknown>): boolean {
	return (
		typeof obj["id"] === "string" &&
		typeof obj["role"] === "string" &&
		typeof obj["sessionID"] === "string"
	);
}

function normalizeMessage(raw: unknown): Message | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;

	let candidate: Record<string, unknown>;
	if (obj["info"] && typeof obj["info"] === "object") {
		const info = obj["info"] as Record<string, unknown>;
		candidate = { ...info, parts: obj["parts"] ?? info["parts"] };
	} else {
		candidate = obj;
	}

	if (!hasMessageShape(candidate)) {
		log.warn("Dropping malformed message:", candidate["id"] ?? "unknown");
		return null;
	}
	return candidate as unknown as Message;
}

function normalizeMessages(raw: unknown): Message[] {
	if (Array.isArray(raw))
		return raw.map(normalizeMessage).filter((m): m is Message => m !== null);
	if (typeof raw === "object" && raw !== null) {
		return Object.values(raw as Record<string, unknown>)
			.map(normalizeMessage)
			.filter((m): m is Message => m !== null);
	}
	return [];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class OpenCodeClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly timeout: number;
	private readonly retries: number;
	private readonly retryDelay: number;

	constructor(options: OpenCodeClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_OPENCODE_URL).replace(
			/\/+$/,
			"",
		);
		this.timeout = options.timeout ?? 10_000;
		this.retries = options.retries ?? 2;
		this.retryDelay = options.retryDelay ?? 1000;

		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};

		// HTTP Basic Auth from options or env vars
		const password = options.auth?.password ?? ENV.opencodePassword;
		const username = options.auth?.username ?? ENV.opencodeUsername;
		if (password) {
			const encoded = Buffer.from(`${username}:${password}`).toString("base64");
			this.headers["Authorization"] = `Basic ${encoded}`;
		}

		// Per-project directory scoping
		if (options.directory) {
			this.headers["x-opencode-directory"] = options.directory;
		}
	}

	// ─── System ──────────────────────────────────────────────────────────────

	async getHealth(): Promise<HealthResponse> {
		// Use /path endpoint as a health check — / returns the web UI HTML
		const _res = await this.get("/path");
		return { ok: true } as HealthResponse;
	}

	async getPath(): Promise<{ cwd: string }> {
		return this.get("/path") as Promise<{ cwd: string }>;
	}

	async getVcs(): Promise<{ branch?: string; dirty?: boolean }> {
		return this.get("/vcs") as Promise<{ branch?: string; dirty?: boolean }>;
	}

	// ─── Sessions ────────────────────────────────────────────────────────────

	async listSessions(options?: SessionListOptions): Promise<SessionDetail[]> {
		const params = new URLSearchParams();
		if (options?.archived !== undefined)
			params.set("archived", String(options.archived));
		if (options?.roots !== undefined)
			params.set("roots", String(options.roots));
		if (options?.limit !== undefined)
			params.set("limit", String(options.limit));
		const query = params.toString();
		const path = `/session${query ? `?${query}` : ""}`;
		const res = await this.get(path);
		// OpenCode returns sessions as an object keyed by ID or as an array
		if (Array.isArray(res)) return res;
		if (typeof res === "object" && res !== null) {
			return Object.values(res as Record<string, SessionDetail>);
		}
		return [];
	}

	async getSession(sessionId: string): Promise<SessionDetail> {
		return this.get(`/session/${sessionId}`) as Promise<SessionDetail>;
	}

	async createSession(options?: SessionCreateOptions): Promise<SessionDetail> {
		return this.post("/session", options ?? {}) as Promise<SessionDetail>;
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.delete(`/session/${sessionId}`);
	}

	async updateSession(
		sessionId: string,
		updates: { title?: string; archived?: boolean },
	): Promise<SessionDetail> {
		return this.patch(
			`/session/${sessionId}`,
			updates,
		) as Promise<SessionDetail>;
	}

	/** Get the current status of all sessions */
	async getSessionStatuses(): Promise<Record<string, SessionStatus>> {
		const res = await this.get("/session/status");
		if (typeof res === "object" && res !== null && !Array.isArray(res)) {
			return res as Record<string, SessionStatus>;
		}
		return {};
	}

	// ─── Messages ────────────────────────────────────────────────────────────

	async getMessages(sessionId: string): Promise<Message[]> {
		const res = await this.get(`/session/${sessionId}/message`);
		return normalizeMessages(res);
	}

	async getMessage(sessionId: string, messageId: string): Promise<Message> {
		const res = await this.get(`/session/${sessionId}/message/${messageId}`);
		const msg = normalizeMessage(res);
		if (!msg) {
			throw new OpenCodeApiError(
				`GET /session/${sessionId}/message/${messageId} returned malformed message`,
				{
					endpoint: `/session/${sessionId}/message/${messageId}`,
					responseStatus: 200,
				},
			);
		}
		return msg;
	}

	/** Get a page of messages with optional limit and before cursor */
	async getMessagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<Message[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.before) params.set("before", options.before);
		const query = params.toString();
		const path = `/session/${sessionId}/message${query ? `?${query}` : ""}`;
		const res = await this.get(path);
		return normalizeMessages(res);
	}

	/** Send a message asynchronously — response comes via SSE, not this call */
	async sendMessageAsync(
		sessionId: string,
		prompt: PromptOptions,
	): Promise<void> {
		// OpenCode requires `parts` array, not flat `text` field
		const parts: Array<Record<string, unknown>> = [];
		if (prompt.text) {
			parts.push({ type: "text", text: prompt.text });
		}
		if (prompt.images) {
			for (const img of prompt.images) {
				parts.push({ type: "file", url: img, mime: "image/png" });
			}
		}
		const body: Record<string, unknown> = { parts };
		if (prompt.agent) body["agent"] = prompt.agent;
		if (prompt.model) body["model"] = prompt.model;
		if (prompt.variant) body["variant"] = prompt.variant;
		log.debug("prompt_async body:", JSON.stringify(body));
		await this.post(`/session/${sessionId}/prompt_async`, body);
	}

	async abortSession(sessionId: string): Promise<void> {
		await this.post(`/session/${sessionId}/abort`, {});
	}

	// ─── Permissions ─────────────────────────────────────────────────────────

	async listPendingPermissions(): Promise<
		Array<{ id: string; permission: string; [key: string]: unknown }>
	> {
		const res = await this.get("/permission");
		return Array.isArray(res) ? res : [];
	}

	async replyPermission(options: PermissionReplyOptions): Promise<void> {
		await this.post(`/permission/${options.id}/reply`, {
			reply: options.decision,
		});
	}

	// ─── Questions ───────────────────────────────────────────────────────────

	async listPendingQuestions(): Promise<
		Array<{ id: string; [key: string]: unknown }>
	> {
		const res = await this.get("/question");
		return Array.isArray(res) ? res : [];
	}

	async replyQuestion(options: QuestionReplyOptions): Promise<void> {
		await this.post(`/question/${options.id}/reply`, {
			answers: options.answers,
		});
	}

	async rejectQuestion(id: string): Promise<void> {
		await this.post(`/question/${id}/reject`, {});
	}

	// ─── Discovery ───────────────────────────────────────────────────────────

	async listAgents(): Promise<Agent[]> {
		const res = await this.get("/agent");
		return Array.isArray(res) ? res : [];
	}

	async listProviders(): Promise<ProviderListResult> {
		const res = (await this.get("/provider")) as Record<string, unknown>;
		// OpenCode returns { all: Provider[], default: Record<string, string>, connected: string[] }
		const all = Array.isArray(res)
			? res
			: Array.isArray(res?.["all"])
				? res["all"]
				: [];
		// Convert models from Record<string, Model> (keyed object) to array
		// Preserve the `variants` field from each model (used for thinking levels)
		type RawModel = {
			id: string;
			name: string;
			limit?: { context?: number; output?: number };
			variants?: Record<string, Record<string, unknown>>;
		};
		const providers = (all as Provider[]).map((p) => ({
			...p,
			models: Array.isArray(p.models)
				? p.models
				: p.models && typeof p.models === "object"
					? Object.values(p.models as Record<string, RawModel>)
					: [],
		}));

		const defaults =
			res?.["default"] && typeof res["default"] === "object"
				? (res["default"] as Record<string, string>)
				: {};

		const connected = Array.isArray(res?.["connected"])
			? (res["connected"] as string[])
			: [];

		return { providers, defaults, connected };
	}

	async listCommands(
		directory?: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/command?directory=${encodeURIComponent(directory)}`
			: "/command";
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	async listSkills(
		directory?: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/skill?directory=${encodeURIComponent(directory)}`
			: "/skill";
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	// ─── Project ─────────────────────────────────────────────────────────────

	async getCurrentProject(): Promise<{
		id: string;
		name?: string;
		path?: string;
		worktree?: string;
	}> {
		return this.get("/project/current") as Promise<{
			id: string;
			name?: string;
			path?: string;
			worktree?: string;
		}>;
	}

	async listProjects(): Promise<
		Array<{ id: string; name?: string; path?: string; worktree?: string }>
	> {
		const res = await this.get("/project");
		return Array.isArray(res) ? res : [];
	}

	// ─── Session Advanced ────────────────────────────────────────────────────

	async forkSession(
		sessionId: string,
		options: { messageID?: string; title?: string },
	): Promise<SessionDetail> {
		return this.post(
			`/session/${sessionId}/fork`,
			options,
		) as Promise<SessionDetail>;
	}

	async revertSession(sessionId: string, messageId: string): Promise<void> {
		await this.post(`/session/${sessionId}/revert`, { messageID: messageId });
	}

	async unrevertSession(sessionId: string): Promise<void> {
		await this.post(`/session/${sessionId}/unrevert`, {});
	}

	async shareSession(sessionId: string): Promise<{ url: string }> {
		return this.post(`/session/${sessionId}/share`, {}) as Promise<{
			url: string;
		}>;
	}

	async summarizeSession(sessionId: string): Promise<void> {
		await this.post(`/session/${sessionId}/summarize`, {});
	}

	async getSessionDiff(
		sessionId: string,
		messageId: string,
	): Promise<{ diffs: Array<{ path: string; diff: string }> }> {
		return this.get(
			`/session/${sessionId}/diff?messageID=${messageId}`,
		) as Promise<{
			diffs: Array<{ path: string; diff: string }>;
		}>;
	}

	// ─── PTY ─────────────────────────────────────────────────────────────────

	async listPtys(): Promise<Array<{ id: string; [key: string]: unknown }>> {
		const res = await this.get("/pty");
		return Array.isArray(res) ? res : [];
	}

	async createPty(options?: PtyCreateOptions): Promise<{ id: string }> {
		return this.post("/pty", options ?? {}) as Promise<{ id: string }>;
	}

	async deletePty(ptyId: string): Promise<void> {
		await this.delete(`/pty/${ptyId}`);
	}

	async resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
		await this.put(`/pty/${ptyId}`, { size: { cols, rows } });
	}

	// ─── Files & Search ──────────────────────────────────────────────────────

	async findText(
		pattern: string,
	): Promise<Array<{ path: string; line: number; text: string }>> {
		const res = await this.get(`/find?pattern=${encodeURIComponent(pattern)}`);
		return Array.isArray(res) ? res : [];
	}

	async findFiles(query: string): Promise<string[]> {
		const res = await this.get(`/find/file?query=${encodeURIComponent(query)}`);
		return Array.isArray(res) ? res : [];
	}

	async findSymbols(
		query: string,
	): Promise<Array<{ name: string; path: string; kind: string }>> {
		const res = await this.get(
			`/find/symbol?query=${encodeURIComponent(query)}`,
		);
		return Array.isArray(res) ? res : [];
	}

	// ─── Files ──────────────────────────────────────────────────────────────

	async listDirectory(
		path?: string,
	): Promise<Array<{ name: string; type: string; size?: number }>> {
		// OpenCode requires `path` query param — default to "." for project root
		const dirPath = path || ".";
		const res = await this.get(`/file?path=${encodeURIComponent(dirPath)}`);
		return Array.isArray(res) ? res : [];
	}

	async getFileContent(
		path: string,
	): Promise<{ content: string; binary?: boolean }> {
		return this.get(
			`/file/content?path=${encodeURIComponent(path)}`,
		) as Promise<{ content: string; binary?: boolean }>;
	}

	async getFileStatus(): Promise<Array<{ path: string; status: string }>> {
		const res = await this.get("/file/status");
		return Array.isArray(res) ? res : [];
	}

	// ─── Config ──────────────────────────────────────────────────────────────

	async getConfig(): Promise<Record<string, unknown>> {
		return this.get("/config") as Promise<Record<string, unknown>>;
	}

	async updateConfig(
		config: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.patch("/config", config) as Promise<Record<string, unknown>>;
	}

	// ─── Internal HTTP methods ─────────────────────────────────────────────

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const url = `${this.baseUrl}${path}`;

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= this.retries; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), this.timeout);

				const init: RequestInit = {
					method,
					headers: this.headers,
					signal: controller.signal,
				};

				if (body !== undefined && method !== "GET" && method !== "DELETE") {
					init.body = JSON.stringify(body);
				}

				const res = await fetch(url, init);
				clearTimeout(timer);

				if (!res.ok) {
					let responseBody: unknown;
					try {
						responseBody = await res.json();
					} catch {
						responseBody = await res.text().catch(() => "[body unreadable]");
					}
					throw new OpenCodeApiError(
						`${method} ${path} failed with ${res.status}`,
						{
							endpoint: path,
							responseStatus: res.status,
							responseBody,
						},
					);
				}

				// 204 No Content
				if (res.status === 204) return undefined;

				const contentType = res.headers.get("content-type") ?? "";
				if (contentType.includes("application/json")) {
					return await res.json();
				}
				return await res.text();
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				// Don't retry on 4xx client errors
				if (err instanceof OpenCodeApiError && err.responseStatus < 500) {
					throw err;
				}

				// Retry on network/5xx errors
				if (attempt < this.retries) {
					await new Promise((r) =>
						setTimeout(r, this.retryDelay * (attempt + 1)),
					);
				}
			}
		}

		throw new OpenCodeConnectionError(
			`Failed to reach OpenCode at ${url} after ${this.retries + 1} attempts`,
			{ ...(lastError != null && { cause: lastError }) },
		);
	}

	private get(path: string): Promise<unknown> {
		return this.request("GET", path);
	}

	private post(path: string, body: unknown): Promise<unknown> {
		return this.request("POST", path, body);
	}

	private put(path: string, body: unknown): Promise<unknown> {
		return this.request("PUT", path, body);
	}

	private patch(path: string, body: unknown): Promise<unknown> {
		return this.request("PATCH", path, body);
	}

	private delete(path: string): Promise<unknown> {
		return this.request("DELETE", path);
	}

	/** Expose the base URL for SSE consumer */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/** Expose auth headers for SSE consumer and PTY upstream connections */
	getAuthHeaders(): Record<string, string> {
		const result: Record<string, string> = {};
		if (this.headers["Authorization"]) {
			result["Authorization"] = this.headers["Authorization"];
		}
		if (this.headers["x-opencode-directory"]) {
			result["x-opencode-directory"] = this.headers["x-opencode-directory"];
		}
		return result;
	}
}
