import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type {
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "../../src/lib/provider/claude/types.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";

export type ProcessMark =
	| { kind: "receipt" | "enqueue"; prompt: string; at: string }
	| { kind: "emit"; prompt: string; text: string; at: string }
	| { kind: "approval"; prompt: string; behavior: "allow" | "deny" }
	| {
			kind: "query";
			sessionId: string;
			pid: number;
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
	| { kind: "runner-command"; commandId: string; type: string }
	| { kind: "runner-spawned"; pid: number; socketPath: string };

export function responseChunks(prompt: string): string[] {
	return [`Echo(${prompt}): `, `stream(${prompt}) `, `done(${prompt}).`];
}

function mark(message: ProcessMark): void {
	const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
	if (proof) appendFileSync(proof, `${JSON.stringify(message)}\n`);
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

function query(params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}): Query {
	const sessionId = params.options?.resume ?? randomUUID();
	let closed = false;
	mark({
		kind: "query",
		sessionId,
		pid: process.pid,
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
	const messages = (async function* (): AsyncGenerator<SDKMessage> {
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
			model: "claude-sonnet-4",
			permissionMode: "default",
			slash_commands: [],
			output_style: "default",
			skills: [],
			plugins: [],
		} as unknown as SDKMessage;
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
			mark({ kind: "enqueue", prompt, at });
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
				if (prompt.startsWith("restart-"))
					await new Promise<void>((done) => setTimeout(done, 120));
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
					...(prompt === "approval-restart"
						? {
								suggestions: [
									{
										type: "addRules" as const,
										rules: [
											{
												toolName: "Bash",
												ruleContent: "printf harness-approved",
											},
										],
										behavior: "allow" as const,
										destination: "session" as const,
									},
								],
							}
						: {}),
				});
				if (!approval) throw new Error("Approval bridge returned no decision");
				mark({
					kind: "approval",
					prompt,
					behavior: approval.behavior,
					...(approval.behavior === "allow" && approval.updatedPermissions
						? { updatedPermissions: approval.updatedPermissions }
						: {}),
				});
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
		close: () => {
			closed = true;
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
