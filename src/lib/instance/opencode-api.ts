// Unified namespaced API wrapping the @opencode-ai/sdk/v2 client.
// Callers use `api.session.list()` instead of `client.session.list({ ... })`.
//
// Error strategy (Audit v3): SDK uses default throwOnError: false.
// Errors return `{ error, response }` — the private `sdk()` wrapper checks
// result.error and translates to OpenCodeApiError (with response.status)
// or OpenCodeConnectionError (for network failures), then decodes result.data
// against the callsite's response schema.
//
// Message shape: session.messages() normalizes SDK's nested `{ info, parts }`
// shape into flat `{ ...info, parts }` messages for relay callers.

import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
	ConfigUpdateData,
	Event as OpenCodeEvent,
} from "@opencode-ai/sdk/v2/types";
import {
	decodeOpenCodeAgentListResponse,
	decodeOpenCodeBooleanResponse,
	decodeOpenCodeCommandListResponse,
	decodeOpenCodeConfigResponse,
	decodeOpenCodeCurrentProjectResponse,
	decodeOpenCodeDiffResponse,
	decodeOpenCodeFileEntryListResponse,
	decodeOpenCodeFileReadResponse,
	decodeOpenCodeFileStatusListResponse,
	decodeOpenCodeFindFilesResponse,
	decodeOpenCodeFindSymbolsResponse,
	decodeOpenCodeFindTextResponse,
	decodeOpenCodeMessageListResponse,
	decodeOpenCodeMessageWithPartsResponse,
	decodeOpenCodePathResponse,
	decodeOpenCodePendingPermissionListResponse,
	decodeOpenCodePendingQuestionListResponse,
	decodeOpenCodeProjectListResponse,
	decodeOpenCodeProviderListResponse,
	decodeOpenCodePtyListResponse,
	decodeOpenCodePtyResponse,
	decodeOpenCodeQuestionActionResponse,
	decodeOpenCodeQuestionReplyBody,
	decodeOpenCodeSessionDetailResponse,
	decodeOpenCodeSessionListResponse,
	decodeOpenCodeSessionResponse,
	decodeOpenCodeSessionStatusMap,
	decodeOpenCodeShareResponse,
	decodeOpenCodeSkillListResponse,
	decodeOpenCodeUndefinedResponse,
	decodeOpenCodeVcsResponse,
	type OpenCodeMessageWithParts,
	type OpenCodePendingPermission,
} from "../contracts/providers/opencode-sdk.js";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";
import type {
	Agent,
	Message,
	PermissionRuleset,
	Provider,
	ProviderListResult,
	SessionDetail,
	SessionStatus,
} from "./sdk-types.js";

type DecodeResponse<T> = (raw: unknown) => T;

const decodeSessionDetailResponse: DecodeResponse<SessionDetail> = (raw) =>
	decodeOpenCodeSessionDetailResponse(raw) as SessionDetail;
const decodeSessionListResponse: DecodeResponse<SessionDetail[]> = (raw) =>
	decodeOpenCodeSessionListResponse(raw).map(
		(session) => session as SessionDetail,
	);

export interface OpenCodeAPIOptions {
	sdk: OpencodeClient;
	baseUrl: string;
	authHeaders: Record<string, string>;
}

/**
 * Unified namespaced API adapter for OpenCode.
 *
 * Wraps the @opencode-ai/sdk/v2 OpencodeClient into a
 * clean, caller-friendly interface. All SDK calls pass through the
 * private `sdk()` helper which handles error translation.
 */
export class OpenCodeAPI {
	private readonly client: OpencodeClient;
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
	 * Network errors may throw or arrive without a response in v2.
	 *
	 * This helper:
	 * 1. Catches thrown errors → OpenCodeConnectionError
	 * 2. Checks result.error → OpenCodeApiError
	 * 3. Decodes result.data against the callsite schema before returning
	 */
	async sdk<T>(
		label: string,
		decodeResponse: DecodeResponse<T>,
		fn: () => Promise<{
			data?: unknown;
			error?: unknown;
			response?: { status: number; url?: string } | undefined;
		}>,
	): Promise<T> {
		let result: {
			data?: unknown;
			error?: unknown;
			response?: { status: number; url?: string } | undefined;
		};

		try {
			result = await fn();
		} catch (err) {
			if (err instanceof OpenCodeApiError) throw err;
			// Network-level failure (fetch failed, DNS error, timeout, etc.)
			const cause = err instanceof Error ? err : new Error(String(err));
			throw new OpenCodeConnectionError({
				message: `OpenCode unreachable during ${label}: ${cause.message}`,
				cause,
			});
		}

		if (result.error !== undefined) {
			if (result.error instanceof OpenCodeApiError) throw result.error;
			// v2 returns network failures as error results without a response.
			if (!result.response) {
				const cause =
					result.error instanceof Error
						? result.error
						: new Error(String(result.error));
				throw new OpenCodeConnectionError({
					message: `OpenCode unreachable during ${label}: ${cause.message}`,
					cause,
				});
			}
			const status =
				result.response && "status" in result.response
					? result.response.status
					: 500;
			const url =
				result.response && "url" in result.response
					? String(result.response.url)
					: label;
			throw new OpenCodeApiError({
				message: `API error during ${label}`,
				endpoint: url,
				responseStatus: status,
				responseBody: result.error,
			});
		}

		try {
			const data: unknown =
				typeof result.data === "string"
					? result.data === ""
						? undefined
						: JSON.parse(result.data)
					: result.data;
			return decodeResponse(data);
		} catch (err) {
			const cause = err instanceof Error ? err : new Error(String(err));
			const status =
				result.response && "status" in result.response
					? result.response.status
					: 500;
			const url =
				result.response && "url" in result.response
					? String(result.response.url)
					: label;
			const parseDetails = cause.message.slice(0, 2000);
			throw new OpenCodeApiError({
				message: `Malformed OpenCode response during ${label}`,
				endpoint: url,
				responseStatus: status,
				responseBody: { parseDetails },
				cause,
				context: { label, parseDetails },
			});
		}
	}

	/** Access internal SDK client (for namespaces) */
	get _sdk(): OpencodeClient {
		return this.client;
	}
}

// Response schemas validate the SDK's nested message envelope before flattening.
function flattenMessage(message: OpenCodeMessageWithParts): Message {
	return { ...message.info, parts: [...message.parts] } as Message;
}

function flattenMessages(data: readonly OpenCodeMessageWithParts[]): Message[] {
	return data.map(flattenMessage);
}

class SessionNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async list(options?: {
		roots?: boolean;
		limit?: number;
	}): Promise<SessionDetail[]> {
		return this.api.sdk("session.list", decodeSessionListResponse, () =>
			this.api._sdk.session.list(options),
		);
	}

	async get(id: string): Promise<SessionDetail> {
		return this.api.sdk("session.get", decodeSessionDetailResponse, () =>
			this.api._sdk.session.get({ sessionID: id }),
		);
	}

	async create(options?: {
		title?: string;
		parentID?: string;
	}): Promise<SessionDetail> {
		return this.api.sdk("session.create", decodeSessionDetailResponse, () =>
			this.api._sdk.session.create(options),
		);
	}

	async delete(id: string): Promise<void> {
		await this.api.sdk("session.delete", decodeOpenCodeBooleanResponse, () =>
			this.api._sdk.session.delete({ sessionID: id }),
		);
	}

	async update(
		id: string,
		options: { title?: string; permission?: PermissionRuleset },
	): Promise<void> {
		await this.api.sdk("session.update", decodeOpenCodeSessionResponse, () =>
			this.api._sdk.session.update({ sessionID: id, ...options }),
		);
	}

	async statuses(directory?: string): Promise<Record<string, SessionStatus>> {
		return this.api.sdk(
			"session.statuses",
			decodeOpenCodeSessionStatusMap,
			() =>
				this.api._sdk.session.status(
					directory === undefined ? undefined : { directory },
				),
		);
	}

	/** Flatten the SDK's validated `{ info, parts }` message envelopes. */
	async messages(
		sessionId: string,
		options?: { limit?: number; signal?: AbortSignal },
	): Promise<Message[]> {
		const data = await this.api.sdk(
			"session.messages",
			decodeOpenCodeMessageListResponse,
			() =>
				this.api._sdk.session.messages(
					{
						sessionID: sessionId,
						...(options?.limit != null ? { limit: options.limit } : {}),
					},
					options?.signal ? { signal: options.signal } : undefined,
				),
		);
		return flattenMessages(data);
	}

	/** Cursor paging uses the same endpoint and parameters as the former gap. */
	async messagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<Message[]> {
		const data = await this.api.sdk(
			"session.messagesPage",
			decodeOpenCodeMessageListResponse,
			() =>
				this.api._sdk.session.messages(
					{
						sessionID: sessionId,
						...(options?.limit ? { limit: options.limit } : {}),
						...(options?.before ? { before: options.before } : {}),
					},
					{
						// Gap calls were unscoped, even when the SDK had a default directory.
						headers: { "x-opencode-directory": null },
					},
				),
		);
		return flattenMessages(data);
	}

	async message(sessionId: string, messageId: string): Promise<Message> {
		const data = await this.api.sdk(
			"session.message",
			decodeOpenCodeMessageWithPartsResponse,
			() =>
				this.api._sdk.session.message({
					sessionID: sessionId,
					messageID: messageId,
				}),
		);
		return flattenMessage(data);
	}

	async prompt(
		sessionId: string,
		options: {
			text: string;
			system?: string;
			model?: { providerID: string; modelID: string };
			agent?: string;
		},
	): Promise<void> {
		await this.api.sdk("session.prompt", decodeOpenCodeUndefinedResponse, () =>
			this.api._sdk.session.promptAsync({
				sessionID: sessionId,
				parts: [{ type: "text", text: options.text }],
				...(options.system !== undefined ? { system: options.system } : {}),
				...(options.model != null ? { model: options.model } : {}),
				...(options.agent != null ? { agent: options.agent } : {}),
			}),
		);
	}

	async abort(sessionId: string): Promise<void> {
		await this.api.sdk("session.abort", decodeOpenCodeBooleanResponse, () =>
			this.api._sdk.session.abort({ sessionID: sessionId }),
		);
	}

	/** Relocate the native session; request directory headers do not override it. */
	async moveWorkspace(sessionId: string, directory: string): Promise<void> {
		await this.api.sdk(
			"session.moveWorkspace",
			decodeOpenCodeUndefinedResponse,
			() =>
				this.api._sdk.experimental.controlPlane.moveSession({
					sessionID: sessionId,
					destination: { directory },
					moveChanges: false,
				}),
		);
	}

	async fork(
		sessionId: string,
		options?: { messageID?: string },
	): Promise<SessionDetail> {
		return this.api.sdk("session.fork", decodeSessionDetailResponse, () =>
			this.api._sdk.session.fork({ sessionID: sessionId, ...options }),
		);
	}

	async revert(
		sessionId: string,
		options: { messageID: string; partID?: string },
	): Promise<void> {
		await this.api.sdk("session.revert", decodeOpenCodeSessionResponse, () =>
			this.api._sdk.session.revert({ sessionID: sessionId, ...options }),
		);
	}

	async unrevert(sessionId: string): Promise<void> {
		await this.api.sdk("session.unrevert", decodeOpenCodeSessionResponse, () =>
			this.api._sdk.session.unrevert({ sessionID: sessionId }),
		);
	}

	async share(sessionId: string): Promise<{ url: string }> {
		return this.api.sdk("session.share", decodeOpenCodeShareResponse, () =>
			this.api._sdk.session.share({ sessionID: sessionId }),
		);
	}

	async summarize(
		sessionId: string,
		options?: { providerID: string; modelID: string },
	): Promise<void> {
		await this.api.sdk("session.summarize", decodeOpenCodeBooleanResponse, () =>
			this.api._sdk.session.summarize({ sessionID: sessionId, ...options }),
		);
	}

	async diff(
		sessionId: string,
		options?: { messageID?: string },
	): Promise<{
		readonly diffs: ReadonlyArray<{
			readonly path: string;
			readonly diff: string;
		}>;
	}> {
		return this.api.sdk("session.diff", decodeOpenCodeDiffResponse, () =>
			this.api._sdk.session.diff({ sessionID: sessionId, ...options }),
		);
	}

	async children(sessionId: string): Promise<SessionDetail[]> {
		return this.api.sdk("session.children", decodeSessionListResponse, () =>
			this.api._sdk.session.children({ sessionID: sessionId }),
		);
	}
}

class PermissionNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/** OpenCode scopes pending permissions by directory; unscoped lists are empty. */
	async list(directory?: string): Promise<OpenCodePendingPermission[]> {
		const permissions = await this.api.sdk(
			"permission.list",
			decodeOpenCodePendingPermissionListResponse,
			() =>
				directory === undefined
					? this.api._sdk.permission.list(undefined, {
							headers: { "x-opencode-directory": null },
						})
					: this.api._sdk.permission.list({ directory }),
		);
		return [...permissions];
	}

	/** Keep the existing session-scoped endpoint and response body. */
	async reply(
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<void> {
		await this.api.sdk("permission.reply", decodeOpenCodeBooleanResponse, () =>
			this.api._sdk.permission.respond({
				sessionID: sessionId,
				permissionID: permissionId,
				response,
			}),
		);
	}
}

class QuestionNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/** OpenCode scopes pending questions by directory; unscoped lists are empty. */
	async list(
		directory?: string,
	): Promise<Array<{ [key: string]: unknown; id: string }>> {
		const questions = await this.api.sdk(
			"question.list",
			decodeOpenCodePendingQuestionListResponse,
			() =>
				directory === undefined
					? this.api._sdk.question.list(undefined, {
							headers: { "x-opencode-directory": null },
						})
					: this.api._sdk.question.list({ directory }),
		);
		return [...questions];
	}

	async reply(id: string, answers: string[][]): Promise<void> {
		try {
			decodeOpenCodeQuestionReplyBody({ answers });
		} catch (err) {
			const cause = err instanceof Error ? err : new Error(String(err));
			const path = `/question/${id}/reply`;
			const parseDetails = cause.message.slice(0, 2000);
			throw new OpenCodeApiError({
				message: `Malformed OpenCode request during POST ${path}`,
				endpoint: path,
				responseStatus: 400,
				responseBody: { parseDetails },
				cause,
				context: { method: "POST", path, parseDetails },
			});
		}
		await this.api.sdk(
			"question.reply",
			decodeOpenCodeQuestionActionResponse,
			() =>
				this.api._sdk.question.reply(
					{ requestID: id, answers },
					{ headers: { "x-opencode-directory": null } },
				),
		);
	}

	async reject(id: string): Promise<void> {
		await this.api.sdk(
			"question.reject",
			decodeOpenCodeQuestionActionResponse,
			() =>
				this.api._sdk.question.reject(
					{ requestID: id },
					{ headers: { "x-opencode-directory": null } },
				),
		);
	}
}

class ConfigNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async get(): Promise<Record<string, unknown>> {
		return this.api.sdk("config.get", decodeOpenCodeConfigResponse, () =>
			this.api._sdk.config.get(),
		);
	}

	async update(body: Record<string, unknown>): Promise<void> {
		await this.api.sdk("config.update", decodeOpenCodeConfigResponse, () =>
			this.api._sdk.config.update({
				config: body as NonNullable<ConfigUpdateData["body"]>,
			}),
		);
	}
}

class ProviderNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/**
	 * List all providers with models.
	 *
	 * The SDK returns `{ all, default, connected }` with models as Record<string, Model>.
	 * This method normalizes to `ProviderListResult`:
	 * - `all` → `providers` (rename)
	 * - `default` → `defaults` (rename)
	 * - `models: Record<string, Model>` → `models: Array<Model>` (convert)
	 */
	async list(): Promise<ProviderListResult> {
		const data = await this.api.sdk(
			"provider.list",
			decodeOpenCodeProviderListResponse,
			() => this.api._sdk.provider.list(),
		);
		// Normalize SDK shape → ProviderListResult
		const providers: Provider[] = data.all.map((p) => ({
			...p,
			models: Object.values(p.models).map((model) => {
				const { limit, variants, ...rest } = model;
				return {
					...rest,
					limit: { ...limit },
					...(variants != null ? { variants: { ...variants } } : {}),
				};
			}),
		}));
		return {
			providers,
			defaults: { ...data.default },
			connected: [...data.connected],
		};
	}
}

class PtyNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async list(): Promise<
		ReadonlyArray<{ readonly id: string; readonly [key: string]: unknown }>
	> {
		return this.api.sdk("pty.list", decodeOpenCodePtyListResponse, () =>
			this.api._sdk.pty.list(),
		);
	}

	async create(options?: {
		command?: string;
		args?: string[];
		cwd?: string;
		title?: string;
		env?: Record<string, string>;
	}): Promise<{ id: string; [key: string]: unknown }> {
		return this.api.sdk("pty.create", decodeOpenCodePtyResponse, () =>
			this.api._sdk.pty.create(options),
		);
	}

	async delete(id: string): Promise<void> {
		await this.api.sdk("pty.delete", decodeOpenCodeBooleanResponse, () =>
			this.api._sdk.pty.remove({ ptyID: id }),
		);
	}

	/** Resize a PTY session. Maps to sdk.pty.update() with size body. */
	async resize(id: string, rows: number, cols: number): Promise<void> {
		await this.api.sdk("pty.resize", decodeOpenCodePtyResponse, () =>
			this.api._sdk.pty.update({
				ptyID: id,
				size: { rows, cols },
			}),
		);
	}
}

class FileNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async list(
		path: string,
		options?: { signal?: AbortSignal },
	): Promise<Array<{ name: string; type: string; size?: number }>> {
		const entries = await this.api.sdk(
			"file.list",
			decodeOpenCodeFileEntryListResponse,
			() =>
				this.api._sdk.file.list(
					{
						path,
					},
					options?.signal ? { signal: options.signal } : undefined,
				),
		);
		return entries.map((entry) => ({
			name: entry.name,
			type: entry.type,
		}));
	}

	async read(
		path: string,
		options?: { signal?: AbortSignal },
	): Promise<{ content: string; binary?: boolean }> {
		const file = await this.api.sdk(
			"file.read",
			decodeOpenCodeFileReadResponse,
			() =>
				this.api._sdk.file.read(
					{
						path,
					},
					options?.signal ? { signal: options.signal } : undefined,
				),
		);
		return {
			content: file.content,
			...(file.type === "binary" ? { binary: true } : {}),
		};
	}

	async status(): Promise<
		ReadonlyArray<{
			readonly path: string;
			readonly added: number;
			readonly removed: number;
			readonly status: "added" | "deleted" | "modified";
		}>
	> {
		return this.api.sdk(
			"file.status",
			decodeOpenCodeFileStatusListResponse,
			() => this.api._sdk.file.status(),
		);
	}
}

class FindNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async text(pattern: string): Promise<readonly unknown[]> {
		return this.api.sdk("find.text", decodeOpenCodeFindTextResponse, () =>
			this.api._sdk.find.text({ pattern }),
		);
	}

	async files(
		query: string,
		options?: { dirs?: boolean },
	): Promise<readonly unknown[]> {
		let dirs: "true" | "false" | undefined;
		if (options?.dirs != null) dirs = options.dirs ? "true" : "false";
		return this.api.sdk("find.files", decodeOpenCodeFindFilesResponse, () =>
			this.api._sdk.find.files({
				query,
				...(dirs === undefined ? {} : { dirs }),
			}),
		);
	}

	async symbols(query: string): Promise<readonly unknown[]> {
		return this.api.sdk("find.symbols", decodeOpenCodeFindSymbolsResponse, () =>
			this.api._sdk.find.symbols({ query }),
		);
	}
}

class AppNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	async agents(): Promise<Agent[]> {
		const agents = await this.api.sdk(
			"app.agents",
			decodeOpenCodeAgentListResponse,
			() => this.api._sdk.app.agents(),
		);
		return agents.map((agent) => ({
			id: agent.name,
			name: agent.name,
			...(agent.description != null ? { description: agent.description } : {}),
			...(agent.mode != null ? { mode: agent.mode } : {}),
			...(agent.hidden != null ? { hidden: agent.hidden } : {}),
		}));
	}

	async commands(): Promise<
		ReadonlyArray<{
			readonly name: string;
			readonly description?: string | undefined;
			readonly source?: "command" | "mcp" | "skill" | undefined;
		}>
	> {
		return this.api.sdk("app.commands", decodeOpenCodeCommandListResponse, () =>
			this.api._sdk.command.list(),
		);
	}

	/** List skills through the compatibility /skill endpoint. */
	async skills(directory?: string) {
		return this.api.sdk("app.skills", decodeOpenCodeSkillListResponse, () =>
			this.api._sdk.app.skills(directory ? { directory } : undefined, {
				headers: { "x-opencode-directory": null },
			}),
		);
	}

	async path(): Promise<{ cwd: string }> {
		const path = await this.api.sdk(
			"app.path",
			decodeOpenCodePathResponse,
			() => this.api._sdk.path.get(),
		);
		return { cwd: path.directory };
	}

	async vcs(): Promise<{
		readonly branch?: string | undefined;
		readonly dirty?: boolean | undefined;
	}> {
		return this.api.sdk("app.vcs", decodeOpenCodeVcsResponse, () =>
			this.api._sdk.vcs.get(),
		);
	}

	async projects(): Promise<
		ReadonlyArray<{
			readonly id?: string;
			readonly name?: string;
			readonly path?: string;
			readonly worktree?: string;
		}>
	> {
		return this.api.sdk("app.projects", decodeOpenCodeProjectListResponse, () =>
			this.api._sdk.project.list(),
		);
	}

	async currentProject(): Promise<{
		id?: string;
		name?: string;
		path?: string;
	}> {
		return this.api.sdk(
			"app.currentProject",
			decodeOpenCodeCurrentProjectResponse,
			() => this.api._sdk.project.current(),
		);
	}
}

class EventNamespace {
	constructor(private readonly api: OpenCodeAPI) {}

	/**
	 * Subscribe to SSE events from OpenCode.
	 * Returns `{ stream: AsyncGenerator<Event> }`.
	 *
	 * @param options.signal - AbortSignal to cancel the SSE connection.
	 *   When aborted, the SDK's internal ReadableStream reader is cancelled
	 *   and the async generator terminates.
	 * @param options.sseMaxRetryAttempts - Cap on the SDK's internal SSE retry
	 *   loop. SSEStream passes 1 so conduit owns reconnection; without it the
	 *   SDK retries forever and transport errors never surface.
	 * @param options.onSseError - Fired when the SSE transport errors, letting
	 *   the caller distinguish error-exit from clean EOF.
	 */
	async subscribe(options?: {
		signal?: AbortSignal;
		sseMaxRetryAttempts?: number;
		onSseError?: (error: unknown) => void;
	}): Promise<{
		stream: AsyncGenerator<OpenCodeEvent, void, unknown>;
	}> {
		return this.api._sdk.event.subscribe(undefined, {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.sseMaxRetryAttempts !== undefined
				? { sseMaxRetryAttempts: options.sseMaxRetryAttempts }
				: {}),
			...(options?.onSseError ? { onSseError: options.onSseError } : {}),
		});
	}
}
