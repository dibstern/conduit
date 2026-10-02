import { randomUUID } from "node:crypto";
import type {
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "../../src/lib/provider/claude/types.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";

export type ProcessMark =
	| { kind: "receipt"; prompt: string; at: string }
	| {
			kind: "enqueue";
			prompt: string;
			at: string;
			queryId: string;
			promptIndex: number;
	  }
	| { kind: "emit"; prompt: string; text: string; at: string }
	| { kind: "approval"; prompt: string; behavior: "allow" | "deny" }
	| {
			kind:
				| "initialization-ready"
				| "initialization-failed"
				| "query-closed"
				| "system-init";
			queryId: string;
			at: string;
	  }
	| {
			kind: "query";
			queryId: string;
			at: string;
			sessionId: string;
			pid: number;
			options: {
				model?: string;
				effort?: Options["effort"];
				permissionMode?: Options["permissionMode"];
				settings?: { disableAllHooks?: boolean };
			};
			env: Readonly<Record<string, string | undefined>>;
	  }
	| {
			kind: "runner-started";
			pid: number;
			sessionId: string;
			socketPath: string;
			buildId: string;
			protocolVersion: number;
	  }
	| { kind: "runner-command"; commandId: string; type: string };

export function responseChunks(prompt: string): string[] {
	return [`Echo(${prompt}): `, `stream(${prompt}) `, `done(${prompt}).`];
}

function mark(message: ProcessMark): void {
	const send = () => {
		if (process.connected)
			process.send?.({ channel: "conduit-process-test", ...message });
	};
	const delay =
		message.kind === "enqueue"
			? Number(process.env["CONDUIT_TEST_ENQUEUE_MARK_DELAY_MS"] ?? 0)
			: 0;
	if (delay > 0) setTimeout(send, delay);
	else send();
}

function stream(sessionId: string, event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		session_id: sessionId,
		uuid: randomUUID(),
		parent_tool_use_id: null,
		event,
	} as unknown as SDKMessage;
}

let initializationAttempts = 0;

function query(params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}): Query {
	const sessionId = params.options?.resume ?? randomUUID();
	const queryId = randomUUID();
	let closed = false;
	let promptIndex = 0;
	let initializationFinished = false;
	let rejectInitialization: (error: Error) => void = () => {};
	const fails =
		++initializationAttempts <=
		Number(process.env["CONDUIT_TEST_QUERY_INITIALIZATION_FAILURES"] ?? 0);
	const delayMs = Number(
		process.env["CONDUIT_TEST_QUERY_INITIALIZATION_DELAY_MS"] ?? 0,
	);
	let initializationTimer: ReturnType<typeof setTimeout> | undefined;
	const settings = params.options?.settings;
	mark({
		kind: "query",
		queryId,
		at: process.hrtime.bigint().toString(),
		sessionId,
		pid: process.pid,
		options: {
			...(params.options?.model ? { model: params.options.model } : {}),
			...(params.options?.effort ? { effort: params.options.effort } : {}),
			...(params.options?.permissionMode
				? { permissionMode: params.options.permissionMode }
				: {}),
			...(settings &&
			typeof settings === "object" &&
			typeof settings.disableAllHooks === "boolean"
				? { settings: { disableAllHooks: settings.disableAllHooks } }
				: {}),
		},
		env: Object.fromEntries(
			[
				"CONDUIT_ENV_PROOF",
				"PATH",
				"CLAUDE_CONFIG_DIR",
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_MODEL",
				"CLAUDE_AGENT_SDK_CLIENT_APP",
				"ENABLE_CLAUDEAI_MCP_SERVERS",
			].map((key) => [key, params.options?.env?.[key]]),
		),
	});
	// Like the SDK, query construction starts initialization without input. The
	// public system/init message remains a first-prompt event, not readiness.
	const initialization = new Promise<Record<string, never>>((done, fail) => {
		rejectInitialization = fail;
		const finish = () => {
			if (initializationFinished) return;
			initializationFinished = true;
			mark({
				kind: fails ? "initialization-failed" : "initialization-ready",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
			if (fails) fail(new Error("Synthetic Claude initialization failure"));
			else done({});
		};
		if (delayMs > 0) initializationTimer = setTimeout(finish, delayMs);
		else finish();
	});
	// A caller may attach the readiness barrier on the next tick.
	void initialization.catch(() => {});
	const messages = (async function* (): AsyncGenerator<SDKMessage> {
		await initialization;
		for await (const input of params.prompt) {
			const at = process.hrtime.bigint().toString();
			if (closed) return;
			const content = input.message.content;
			const prompt =
				typeof content === "string"
					? content
					: content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			mark({
				kind: "enqueue",
				prompt,
				at,
				queryId,
				promptIndex: ++promptIndex,
			});
			if (promptIndex === 1) {
				mark({
					kind: "system-init",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
				yield {
					type: "system",
					subtype: "init",
					session_id: sessionId,
					uuid: randomUUID(),
					cwd: params.options?.cwd ?? "",
					apiKeySource: "none",
					claude_code_version: "process-test",
					tools: ["Bash"],
					mcp_servers: [],
					model: params.options?.model ?? "claude-sonnet-4",
					permissionMode: params.options?.permissionMode ?? "default",
					slash_commands: [],
					output_style: "default",
					skills: [],
					plugins: [],
				} as unknown as SDKMessage;
			}
			const messageId = randomUUID();
			yield stream(sessionId, {
				type: "message_start",
				message: { id: messageId, role: "assistant", content: [] },
			});
			yield stream(sessionId, {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			});
			for (const text of responseChunks(prompt)) {
				const event = stream(sessionId, {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text },
				});
				mark({
					kind: "emit",
					prompt,
					text,
					at: process.hrtime.bigint().toString(),
				});
				yield event;
			}
			yield stream(sessionId, { type: "content_block_stop", index: 0 });
			if (prompt.startsWith("approval-")) {
				const toolUseID = randomUUID();
				const toolInput = { command: "printf harness-approved" };
				yield stream(sessionId, {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: toolUseID,
						name: "Bash",
						input: toolInput,
					},
				});
				yield stream(sessionId, { type: "content_block_stop", index: 1 });
				if (!params.options?.canUseTool)
					throw new Error("Missing canUseTool bridge");
				const approval = await params.options.canUseTool("Bash", toolInput, {
					signal:
						params.options.abortController?.signal ??
						new AbortController().signal,
					toolUseID,
					requestId: randomUUID(),
				});
				if (!approval) throw new Error("Approval bridge returned no decision");
				mark({ kind: "approval", prompt, behavior: approval.behavior });
				yield {
					type: "user",
					uuid: randomUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUseID,
								content:
									approval.behavior === "allow"
										? "harness-approved"
										: "harness-denied",
								is_error: approval.behavior !== "allow",
							},
						],
					},
				} as unknown as SDKMessage;
			}
			yield {
				type: "assistant",
				uuid: messageId,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					id: messageId,
					role: "assistant",
					content: [{ type: "text", text: responseChunks(prompt).join("") }],
				},
			} as unknown as SDKMessage;
			yield {
				type: "result",
				subtype: "success",
				uuid: randomUUID(),
				session_id: sessionId,
				is_error: false,
				duration_ms: 0,
				duration_api_ms: 0,
				num_turns: 1,
				result: responseChunks(prompt).join(""),
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {
					input_tokens: 1,
					output_tokens: 3,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				modelUsage: {},
				permission_denials: [],
			} as unknown as SDKMessage;
		}
	})();
	// The adapter consumes the iterable and these control methods; the full SDK
	// interface also contains unrelated account/MCP methods that this fake never uses.
	return Object.assign(messages, {
		initializationResult: () => initialization,
		close: () => {
			if (closed) return;
			closed = true;
			clearTimeout(initializationTimer);
			if (!initializationFinished) {
				initializationFinished = true;
				rejectInitialization(
					new Error("Claude query closed before initialization"),
				);
			}
			mark({
				kind: "query-closed",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
		},
		interrupt: async () => {},
		setModel: async () => {},
		setPermissionMode: async () => {},
		applyFlagSettings: async () => {},
	}) as unknown as Query;
}

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query,
	titleQuery: async function* () {
		yield {
			type: "result",
			subtype: "success",
			result: "Process harness session",
		};
	},
};
