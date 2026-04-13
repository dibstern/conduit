// ─── OpenCodeAPI Adapter (Task 5) ───────────────────────────────────────────
// Unified namespaced API wrapping the @opencode-ai/sdk client and gap endpoints.
// Callers use `api.session.list()` instead of `client.session.list({ ... })`.
//
// Error strategy (Audit v3): SDK uses default throwOnError: false.
// Errors return `{ error, response }` — the private `sdk()` wrapper checks
// result.error and translates to OpenCodeApiError (with response.status)
// or OpenCodeConnectionError (for network failures).
//
// Message shape (Audit v1 fix #2): session.messages() returns SDK shape
// `Array<{ info: Message, parts: Part[] }>`, NOT flat messages.

import type {
	Event as OpenCodeEvent,
	OpencodeClient,
} from "@opencode-ai/sdk/client";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";
import type { GapEndpoints } from "./gap-endpoints.js";
import type { Agent, Message, ProviderListResult } from "./opencode-client.js";
import type { SessionDetail, SessionStatus } from "./sdk-types.js";

/**
 * Simplified result shape for the sdk() wrapper.
 *
 * The SDK's RequestResult type uses complex conditional types based on
 * ThrowOnError and TResponseStyle generic parameters. With the defaults
 * (throwOnError: false, responseStyle: "fields"), results conform to this
 * shape. We use this type alias to avoid `as any` casts throughout.
 */
type SdkResult<T> = Promise<
	{ data: T | undefined; error: unknown } & {
		request: Request;
		response: Response;
	}
>;

export interface OpenCodeAPIOptions {
	sdk: OpencodeClient;
	gapEndpoints: GapEndpoints;
	baseUrl: string;
	authHeaders: Record<string, string>;
}

/**
 * Unified namespaced API adapter for OpenCode.
 *
 * Wraps the @opencode-ai/sdk OpencodeClient and GapEndpoints into a
 * clean, caller-friendly interface. All SDK calls pass through the
 * private `sdk()` helper which handles error translation.
 */
export class OpenCodeAPI {
	private readonly client: OpencodeClient;
	private readonly gaps: GapEndpoints;
	private readonly _baseUrl: string;
	private readonly _authHeaders: Record<string, string>;

	readonly session: SessionNamespace;
	readonly permission: PermissionNamespace;
	readonly question: QuestionNamespace;
	readonly config: ConfigNamespace;
	readonly provider: ProviderNamespace;
	readonly pty: PtyNamespace;
	readonly file: FileNamespace;
	readonly find: FindNamespace;
	readonly app: AppNamespace;
	readonly event: EventNamespace;

	constructor(options: OpenCodeAPIOptions) {
		this.client = options.sdk;
		this.gaps = options.gapEndpoints;
		this._baseUrl = options.baseUrl;
		this._authHeaders = options.authHeaders;

		this.session = new SessionNamespace(this);
		this.permission = new PermissionNamespace(this);
		this.question = new QuestionNamespace(this);
		this.config = new ConfigNamespace(this);
		this.provider = new ProviderNamespace(this);
		this.pty = new PtyNamespace(this);
		this.file = new FileNamespace(this);
		this.find = new FindNamespace(this);
		this.app = new AppNamespace(this);
		this.event = new EventNamespace(this);
	}

	/** Base URL for PTY upstream WebSocket connections */
	getBaseUrl(): string {
		return this._baseUrl;
	}

	/** Auth headers for PTY upstream WebSocket connections */
	getAuthHeaders(): Record<string, string> {
		return this._authHeaders;
	}

	/**
	 * Execute an SDK call and translate errors.
	 *
	 * The SDK's default throwOnError: false means successful calls return
	 * `{ data, error: undefined }` and failures return `{ data: undefined, error }`.
	 * Network errors (TypeError: fetch failed, etc.) throw directly.
	 *
	 * This helper:
	 * 1. Catches thrown errors → OpenCodeConnectionError
	 * 2. Checks result.error → OpenCodeApiError
	 * 3. Returns result.data on success
	 */
	async sdk<T>(
		fn: () => Promise<{
			data: T | undefined;
			error: unknown;
			response: { status: number; url?: string } | Response;
		}>,
		label: string,
	): Promise<T> {
		let result: {
			data: T | undefined;
			error: unknown;
			response: { status: number; url?: string } | Response;
		};

		try {
			result = await fn();
		} catch (err) {
			// Network-level failure (fetch failed, DNS error, timeout, etc.)
			const cause = err instanceof Error ? err : new Error(String(err));
			throw new OpenCodeConnectionError(
				`OpenCode unreachable during ${label}: ${cause.message}`,
				{ cause },
			);
		}

		if (result.error !== undefined) {
			const status =
				result.response && "status" in result.response
					? result.response.status
					: 500;
			const url =
				result.response && "url" in result.response
					? String(result.response.url)
					: label;
			throw new OpenCodeApiError(`API error during ${label}`, {
				endpoint: url,
				responseStatus: status,
				responseBody: result.error,
			});
		}

		return result.data as T;
	}

	/** Access internal SDK client (for namespaces) */
	get _sdk(): OpencodeClient {
		return this.client;
	}

	/** Access internal gap endpoints (for namespaces) */
	get _gaps(): GapEndpoints {
		return this.gaps;
	}
}

// ─── Helper to cast SDK RequestResult to SdkResult ──────────────────────────
// The SDK's RequestResult uses complex conditional types; this helper performs
// a single cast point so namespace methods stay clean.

function call<T>(promise: Promise<unknown>): SdkResult<T> {
	return promise as SdkResult<T>;
}

// ─── Session Namespace ───────────────────────────────────────────────────────

class SessionNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async list(options?: {
		roots?: boolean;
		limit?: number;
	}): Promise<SessionDetail[]> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.list({
						...(options != null
							? {
									query: {
										...(options.roots !== undefined
											? { roots: String(options.roots) }
											: {}),
										...(options.limit !== undefined
											? { limit: String(options.limit) }
											: {}),
									} as Record<string, string>,
								}
							: {}),
					}),
				),
			"session.list",
		);
	}

	async get(id: string): Promise<SessionDetail> {
		return this.api.sdk(
			() => call(this.api._sdk.session.get({ path: { id } })),
			"session.get",
		);
	}

	async create(options?: {
		title?: string;
		parentID?: string;
	}): Promise<SessionDetail> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.create(
						options != null ? { body: options } : {},
					),
				),
			"session.create",
		);
	}

	async delete(id: string): Promise<void> {
		return this.api.sdk(
			() => call(this.api._sdk.session.delete({ path: { id } })),
			"session.delete",
		);
	}

	async update(id: string, options: { title?: string }): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.update({
						path: { id },
						body: options,
					}),
				),
			"session.update",
		);
	}

	/** Get statuses for all sessions. Returns `Record<string, SessionStatus>`. */
	async statuses(): Promise<Record<string, SessionStatus>> {
		return this.api.sdk(
			() => call(this.api._sdk.session.status()),
			"session.statuses",
		);
	}

	/**
	 * List messages for a session.
	 *
	 * Returns SDK shape: `Array<{ info: Message, parts: Part[] }>`.
	 * This is NOT flat messages — each element contains the message info
	 * and its associated parts.
	 */
	async messages(
		sessionId: string,
		options?: { limit?: number },
	): Promise<Message[]> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.messages({
						path: { id: sessionId },
						...(options?.limit != null
							? { query: { limit: options.limit } }
							: {}),
					}),
				),
			"session.messages",
		);
	}

	/**
	 * Paginated message retrieval (gap endpoint).
	 * Returns messages before the given cursor.
	 */
	async messagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<Message[]> {
		return this.api._gaps.getMessagesPage(sessionId, options) as Promise<
			Message[]
		>;
	}

	/** Get a single message with its parts. */
	async message(sessionId: string, messageId: string): Promise<Message> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.message({
						path: { id: sessionId, messageID: messageId },
					}),
				),
			"session.message",
		);
	}

	/**
	 * Send a prompt to a session (fire-and-forget via promptAsync).
	 * Builds TextPartInput from text string for convenience.
	 */
	async prompt(
		sessionId: string,
		options: {
			text: string;
			model?: { providerID: string; modelID: string };
			agent?: string;
		},
	): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.promptAsync({
						path: { id: sessionId },
						body: {
							parts: [{ type: "text" as const, text: options.text }],
							...(options.model != null ? { model: options.model } : {}),
							...(options.agent != null ? { agent: options.agent } : {}),
						},
					}),
				),
			"session.prompt",
		);
	}

	async abort(sessionId: string): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.abort({
						path: { id: sessionId },
					}),
				),
			"session.abort",
		);
	}

	async fork(
		sessionId: string,
		options?: { messageID?: string },
	): Promise<SessionDetail> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.fork({
						path: { id: sessionId },
						...(options != null ? { body: options } : {}),
					}),
				),
			"session.fork",
		);
	}

	async revert(
		sessionId: string,
		options: { messageID: string; partID?: string },
	): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.revert({
						path: { id: sessionId },
						body: options,
					}),
				),
			"session.revert",
		);
	}

	async unrevert(sessionId: string): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.unrevert({
						path: { id: sessionId },
					}),
				),
			"session.unrevert",
		);
	}

	async share(sessionId: string): Promise<{ url: string }> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.share({
						path: { id: sessionId },
					}),
				),
			"session.share",
		);
	}

	async summarize(
		sessionId: string,
		options?: { providerID: string; modelID: string },
	): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.summarize({
						path: { id: sessionId },
						...(options != null ? { body: options } : {}),
					}),
				),
			"session.summarize",
		);
	}

	async diff(
		sessionId: string,
		options?: { messageID?: string },
	): Promise<{ diffs: Array<{ path: string; diff: string }> }> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.diff({
						path: { id: sessionId },
						...(options?.messageID != null
							? { query: { messageID: options.messageID } }
							: {}),
					}),
				),
			"session.diff",
		);
	}

	async children(sessionId: string): Promise<SessionDetail[]> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.session.children({
						path: { id: sessionId },
					}),
				),
			"session.children",
		);
	}
}

// ─── Permission Namespace ────────────────────────────────────────────────────

class PermissionNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/** List pending permissions (gap endpoint). */
	async list(): Promise<
		Array<{ [key: string]: unknown; id: string; permission: string }>
	> {
		return this.api._gaps.listPendingPermissions() as Promise<
			Array<{ [key: string]: unknown; id: string; permission: string }>
		>;
	}

	/**
	 * Reply to a permission request (SDK).
	 * @param sessionId - Session ID
	 * @param permissionId - Permission ID
	 * @param response - "once" | "always" | "reject"
	 */
	async reply(
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.postSessionIdPermissionsPermissionId({
						path: { id: sessionId, permissionID: permissionId },
						body: { response },
					}),
				),
			"permission.reply",
		);
	}
}

// ─── Question Namespace ──────────────────────────────────────────────────────

class QuestionNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/** List pending questions (gap endpoint). */
	async list(): Promise<Array<{ [key: string]: unknown; id: string }>> {
		return this.api._gaps.listPendingQuestions() as Promise<
			Array<{ [key: string]: unknown; id: string }>
		>;
	}

	/** Reply to a question (gap endpoint). */
	async reply(id: string, answers: string[][]) {
		return this.api._gaps.replyQuestion(id, answers);
	}

	/** Reject a question (gap endpoint). */
	async reject(id: string) {
		return this.api._gaps.rejectQuestion(id);
	}
}

// ─── Config Namespace ────────────────────────────────────────────────────────

class ConfigNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async get(): Promise<Record<string, unknown>> {
		return this.api.sdk(() => call(this.api._sdk.config.get()), "config.get");
	}

	async update(body: Record<string, unknown>): Promise<void> {
		return this.api.sdk(
			() =>
				// biome-ignore lint/suspicious/noExplicitAny: Config body type is complex; callers pass partial config objects
				call(this.api._sdk.config.update({ body: body as any })),
			"config.update",
		);
	}
}

// ─── Provider Namespace ──────────────────────────────────────────────────────

class ProviderNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/**
	 * List all providers with models.
	 *
	 * Returns SDK shape from `provider.list()`:
	 * `{ all: Array<{id, name, models: Record<string, Model>, ...}>, default: Record, connected: string[] }`
	 *
	 * Note: Models within each provider are a Record<string, Model> from the raw
	 * endpoint. Callers that need a flat array should normalize themselves, as
	 * the config.providers() endpoint already returns a different shape.
	 */
	async list(): Promise<ProviderListResult> {
		return this.api.sdk(
			() => call(this.api._sdk.provider.list()),
			"provider.list",
		);
	}
}

// ─── PTY Namespace ───────────────────────────────────────────────────────────

class PtyNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async list(): Promise<Array<{ id: string; [key: string]: unknown }>> {
		return this.api.sdk(() => call(this.api._sdk.pty.list()), "pty.list");
	}

	async create(options?: {
		command?: string;
		args?: string[];
		cwd?: string;
		title?: string;
		env?: Record<string, string>;
	}): Promise<{ id: string; [key: string]: unknown }> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.pty.create(options != null ? { body: options } : {}),
				),
			"pty.create",
		);
	}

	async delete(id: string): Promise<void> {
		return this.api.sdk(
			() => call(this.api._sdk.pty.remove({ path: { id } })),
			"pty.delete",
		);
	}

	/** Resize a PTY session. Maps to sdk.pty.update() with size body. */
	async resize(id: string, rows: number, cols: number): Promise<void> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.pty.update({
						path: { id },
						body: { size: { rows, cols } },
					}),
				),
			"pty.resize",
		);
	}
}

// ─── File Namespace ──────────────────────────────────────────────────────────

class FileNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async list(
		path: string,
	): Promise<Array<{ name: string; type: string; size?: number }>> {
		return this.api.sdk(
			() => call(this.api._sdk.file.list({ query: { path } })),
			"file.list",
		);
	}

	async read(path: string): Promise<{ content: string; binary?: boolean }> {
		return this.api.sdk(
			() => call(this.api._sdk.file.read({ query: { path } })),
			"file.read",
		);
	}

	async status(): Promise<Record<string, unknown>> {
		return this.api.sdk(() => call(this.api._sdk.file.status()), "file.status");
	}
}

// ─── Find Namespace ──────────────────────────────────────────────────────────

class FindNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async text(pattern: string): Promise<unknown[]> {
		return this.api.sdk(
			() => call(this.api._sdk.find.text({ query: { pattern } })),
			"find.text",
		);
	}

	async files(query: string, options?: { dirs?: boolean }): Promise<unknown[]> {
		return this.api.sdk(
			() =>
				call(
					this.api._sdk.find.files({
						query: {
							query,
							...(options?.dirs != null
								? { dirs: options.dirs ? "true" : "false" }
								: {}),
						},
					}),
				),
			"find.files",
		);
	}

	async symbols(query: string): Promise<unknown[]> {
		return this.api.sdk(
			() => call(this.api._sdk.find.symbols({ query: { query } })),
			"find.symbols",
		);
	}
}

// ─── App Namespace ───────────────────────────────────────────────────────────

class AppNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async agents(): Promise<Agent[]> {
		return this.api.sdk(() => call(this.api._sdk.app.agents()), "app.agents");
	}

	async commands(): Promise<Array<{ name: string; description?: string }>> {
		return this.api.sdk(
			() => call(this.api._sdk.command.list()),
			"app.commands",
		);
	}

	/** List skills (gap endpoint). */
	async skills(directory?: string) {
		return this.api._gaps.listSkills(directory);
	}

	async path(): Promise<{ cwd: string }> {
		return this.api.sdk(() => call(this.api._sdk.path.get()), "app.path");
	}

	async vcs(): Promise<{ branch?: string; dirty?: boolean }> {
		return this.api.sdk(() => call(this.api._sdk.vcs.get()), "app.vcs");
	}

	async projects(): Promise<
		Array<{ id?: string; name?: string; path?: string; worktree?: string }>
	> {
		return this.api.sdk(
			() => call(this.api._sdk.project.list()),
			"app.projects",
		);
	}

	async currentProject(): Promise<{
		id?: string;
		name?: string;
		path?: string;
	}> {
		return this.api.sdk(
			() => call(this.api._sdk.project.current()),
			"app.currentProject",
		);
	}
}

// ─── Event Namespace ─────────────────────────────────────────────────────────

class EventNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/**
	 * Subscribe to SSE events from OpenCode.
	 * Returns `{ stream: AsyncGenerator<Event> }`.
	 */
	async subscribe(): Promise<{
		stream: AsyncGenerator<OpenCodeEvent, void, unknown>;
	}> {
		return this.api._sdk.event.subscribe() as Promise<{
			stream: AsyncGenerator<OpenCodeEvent, void, unknown>;
		}>;
	}
}
