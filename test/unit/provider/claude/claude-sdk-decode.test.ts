import { describe, expect, it } from "vitest";

import {
	CLAUDE_SDK_MESSAGE_VARIANTS,
	CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS,
	decodeClaudeSDKMessage,
	decodeClaudeSDKOptionsJsonShape,
	decodeClaudeSDKUserMessage,
} from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";

const UUID = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "sdk-session-1";

const systemEnvelope = {
	type: "system",
	uuid: UUID,
	session_id: SESSION_ID,
} as const;

describe("decodeClaudeSDKMessage", () => {
	it("decodes the installed 0.3.207 message envelopes", () => {
		expect(CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS).toEqual([]);
		expect(CLAUDE_SDK_MESSAGE_VARIANTS).toEqual([
			"assistant",
			"user",
			"user_replay",
			"result_success",
			"result_error",
			"system_init",
			"stream_event",
			"system_compact_boundary",
			"system_status",
			"system_api_retry",
			"system_control_request_progress",
			"system_model_refusal_fallback",
			"system_model_refusal_no_fallback",
			"system_local_command_output",
			"system_hook_started",
			"system_hook_progress",
			"system_hook_response",
			"system_plugin_install",
			"tool_progress",
			"auth_status",
			"system_task_notification",
			"system_task_started",
			"system_task_updated",
			"system_task_progress",
			"system_background_tasks_changed",
			"system_thinking_tokens",
			"system_session_state_changed",
			"system_worker_shutting_down",
			"system_commands_changed",
			"system_notification",
			"system_files_persisted",
			"tool_use_summary",
			"system_memory_recall",
			"rate_limit_event",
			"system_elicitation_complete",
			"system_permission_denied",
			"prompt_suggestion",
			"system_mirror_error",
			"system_informational",
			"conversation_reset",
		]);
		const observedBackgroundTasks = [
			{
				task_id: "task-1",
				task_type: "local_agent",
				description: "Inspect the provider contract",
			},
		];
		const observedCommands = [
			{
				name: "review",
				description: "Review changes",
				argumentHint: "<path>",
				aliases: ["inspect"],
			},
		];
		const messages = [
			{
				...systemEnvelope,
				subtype: "control_request_progress",
				request_id: "request-1",
				status: "api_retry",
				attempt: 1,
				max_retries: 3,
				retry_delay_ms: 250,
				error_status: 429,
			},
			{
				...systemEnvelope,
				subtype: "model_refusal_fallback",
				trigger: "refusal",
				direction: "retry",
				original_model: "claude-opus",
				fallback_model: "claude-sonnet",
				request_id: "request-1",
				api_refusal_category: "policy",
				api_refusal_explanation: "Provider-owned explanation",
				retracted_message_uuids: [UUID],
				refused_user_message_uuid: UUID,
				content: "Retrying with fallback model",
			},
			{
				...systemEnvelope,
				subtype: "model_refusal_no_fallback",
				original_model: "claude-opus",
				request_id: null,
				content: "No fallback model is available",
			},
			{
				...systemEnvelope,
				subtype: "background_tasks_changed",
				tasks: observedBackgroundTasks,
			},
			{
				...systemEnvelope,
				subtype: "thinking_tokens",
				estimated_tokens: 1_024,
				estimated_tokens_delta: 128,
			},
			{
				...systemEnvelope,
				subtype: "worker_shutting_down",
				reason: "host_exit",
			},
			{
				...systemEnvelope,
				subtype: "commands_changed",
				commands: observedCommands,
			},
			{
				...systemEnvelope,
				subtype: "permission_denied",
				tool_name: "Bash",
				tool_use_id: "tool-1",
				agent_id: "agent-1",
				decision_reason_type: "rule",
				decision_reason: "Denied by project policy",
				message: "Permission denied",
			},
			{
				...systemEnvelope,
				subtype: "informational",
				content: "Provider-owned informational text",
				level: "notice",
				tool_use_id: "tool-1",
				prevent_continuation: false,
			},
			{
				type: "conversation_reset",
				new_conversation_id: UUID,
				uuid: UUID,
				session_id: SESSION_ID,
			},
		];

		for (const message of messages) {
			expect(() => decodeClaudeSDKMessage(message)).not.toThrow();
		}

		const decodedBackgroundTasks = decodeClaudeSDKMessage(messages[3]);
		const decodedCommands = decodeClaudeSDKMessage(messages[6]);
		expect(
			decodedBackgroundTasks.type === "system" &&
				decodedBackgroundTasks.subtype === "background_tasks_changed"
				? decodedBackgroundTasks.tasks
				: undefined,
		).toEqual(observedBackgroundTasks);
		expect(
			decodedCommands.type === "system" &&
				decodedCommands.subtype === "commands_changed"
				? decodedCommands.commands
				: undefined,
		).toEqual(observedCommands);
	});

	it("preserves the observed provider-owned nested payload inventory", () => {
		const assistantMessage = {
			id: "message-1",
			type: "message",
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tool-1",
					name: "Bash",
					input: { command: "pwd", provider_extra: { nested: true } },
				},
			],
		};
		const rawStreamEvent = {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: "{}" },
		};
		const result = {
			type: "result",
			subtype: "success",
			duration_ms: 10,
			duration_api_ms: 8,
			is_error: false,
			num_turns: 1,
			stop_reason: "end_turn",
			total_cost_usd: 0.01,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 3,
				server_tool_use: { web_search_requests: 1 },
			},
			modelUsage: {
				"claude-sonnet": {
					inputTokens: 10,
					outputTokens: 5,
					costUSD: 0.01,
					contextWindow: 200_000,
				},
			},
			permission_denials: [
				{
					tool_name: "Bash",
					tool_use_id: "tool-1",
					tool_input: { command: "rm -rf /", provider_extra: ["value"] },
				},
			],
			structured_output: { arbitrary: { nested: ["value"] } },
			deferred_tool_use: {
				id: "tool-2",
				name: "Read",
				input: { file_path: "/tmp/file", provider_extra: true },
			},
			origin: { kind: "auto-continuation" },
			result: "done",
			uuid: UUID,
			session_id: SESSION_ID,
		};
		const fixtures = [
			{
				type: "assistant",
				message: assistantMessage,
				parent_tool_use_id: null,
				error: "model_not_found",
				uuid: UUID,
				session_id: SESSION_ID,
			},
			{
				type: "stream_event",
				event: rawStreamEvent,
				parent_tool_use_id: null,
				uuid: UUID,
				session_id: SESSION_ID,
			},
			result,
			{
				...systemEnvelope,
				subtype: "compact_boundary",
				compact_metadata: {
					trigger: "auto",
					pre_tokens: 190_000,
					post_tokens: 80_000,
					preserved_messages: { anchor_uuid: UUID, uuids: [UUID] },
				},
			},
			{
				...systemEnvelope,
				subtype: "init",
				apiKeySource: "oauth",
				claude_code_version: "2.1.207",
				cwd: "/workspace/project",
				tools: ["Read", "Bash"],
				mcp_servers: [{ name: "filesystem", status: "connected" }],
				model: "claude-sonnet",
				permissionMode: "default",
				slash_commands: ["review"],
				output_style: "default",
				skills: ["review"],
				plugins: [{ name: "review", path: "/plugins/review" }],
			},
			{
				...systemEnvelope,
				subtype: "files_persisted",
				files: [{ filename: "report.md", file_id: "file-1" }],
				failed: [{ filename: "missing.md", error: "not found" }],
				processed_at: "2026-07-13T00:00:00.000Z",
			},
			{
				...systemEnvelope,
				subtype: "memory_recall",
				mode: "select",
				memories: [
					{ path: "/memories/one.md", scope: "personal", content: "note" },
				],
			},
			{
				type: "rate_limit_event",
				rate_limit_info: {
					status: "allowed",
					resetsAt: 1_800_000_000,
					provider_extra: { nested: true },
				},
				uuid: UUID,
				session_id: SESSION_ID,
			},
		];

		for (const fixture of fixtures) {
			expect(decodeClaudeSDKMessage(fixture)).toEqual(fixture);
		}
	});

	it("accepts the SSE keepalive ping stream event", () => {
		// Captured live 2026-07-15: the SDK passes the API's keepalive through
		// as a stream_event; rejecting it killed the whole session stream
		// consumer ("SDK stream ended without result").
		const ping = {
			type: "stream_event",
			event: { type: "ping" },
			parent_tool_use_id: null,
			uuid: UUID,
			session_id: SESSION_ID,
		};
		expect(() => decodeClaudeSDKMessage(ping)).not.toThrow();
	});

	it("rejects malformed fields that Conduit reads", () => {
		const malformedMessages = [
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: "0",
					delta: { type: "text_delta", text: "hello" },
				},
				parent_tool_use_id: null,
				uuid: UUID,
				session_id: SESSION_ID,
			},
			{
				...systemEnvelope,
				subtype: "api_retry",
				attempt: 1,
				max_retries: 3,
				retry_delay_ms: 250,
				error_status: 429,
				error: "not-an-sdk-error",
			},
			{
				...systemEnvelope,
				subtype: "init",
				apiKeySource: "oauth",
				claude_code_version: "2.1.207",
				cwd: "/workspace/project",
				tools: [],
				mcp_servers: [],
				model: 42,
				permissionMode: "default",
				slash_commands: [],
				output_style: "default",
				skills: [],
				plugins: [],
			},
			{
				...systemEnvelope,
				subtype: "task_progress",
				task_id: "task-1",
				tool_use_id: "tool-1",
				description: "Inspect the provider contract",
				usage: { total_tokens: "10", tool_uses: 1, duration_ms: 50 },
			},
			{
				...systemEnvelope,
				subtype: "task_notification",
				task_id: "task-1",
				tool_use_id: "tool-1",
				status: "completed",
				output_file: "/tmp/task.output",
				summary: "done",
				usage: { total_tokens: 10, tool_uses: "1", duration_ms: 50 },
			},
			{
				type: "tool_progress",
				tool_use_id: "tool-1",
				tool_name: "Bash",
				parent_tool_use_id: null,
				elapsed_time_seconds: "1",
				uuid: UUID,
				session_id: SESSION_ID,
			},
			{
				type: "result",
				subtype: "success",
				duration_ms: 10,
				duration_api_ms: 8,
				is_error: false,
				num_turns: 1,
				stop_reason: "end_turn",
				total_cost_usd: 0.01,
				usage: {
					input_tokens: "10",
					output_tokens: 5,
					cache_creation_input_tokens: 2,
					cache_read_input_tokens: 3,
				},
				modelUsage: {},
				permission_denials: [],
				result: "done",
				uuid: UUID,
				session_id: SESSION_ID,
			},
		];

		for (const message of malformedMessages) {
			expect(() => decodeClaudeSDKMessage(message)).toThrow();
		}
	});
});

describe("decodeClaudeSDKUserMessage", () => {
	it("decodes observer-origin user messages without inspecting provider payloads", () => {
		const observedContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: [{ type: "text", text: "done", provider_extra: { value: 1 } }],
			},
		];
		const observedToolResult = {
			status: "completed",
			provider_extra: { nested: ["value"] },
		};
		const raw = {
			type: "user",
			message: { role: "user", content: observedContent },
			parent_tool_use_id: "tool-parent",
			origin: {
				kind: "observer",
				from: "agent-1",
				senderTaskId: "task-1",
			},
			tool_use_result: observedToolResult,
			uuid: UUID,
			session_id: SESSION_ID,
		};

		const decoded = decodeClaudeSDKUserMessage(raw);

		expect(decoded.message.content).toEqual(observedContent);
		expect(decoded.tool_use_result).toEqual(observedToolResult);
		expect(decoded.origin).toEqual(raw.origin);
		expect(() =>
			decodeClaudeSDKUserMessage({ ...raw, parent_tool_use_id: 42 }),
		).toThrow();
		expect(() =>
			decodeClaudeSDKUserMessage({
				...raw,
				message: { ...raw.message, role: "assistant" },
			}),
		).toThrow();
	});
});

describe("decodeClaudeSDKOptionsJsonShape", () => {
	it("validates the JSON options Conduit sends against 0.3.207", () => {
		const observedSettings = {
			showThinkingSummaries: true,
			providerOwnedSetting: { nested: ["value"] },
		};
		const options = {
			cwd: "/workspace/project",
			model: "sonnet",
			resume: SESSION_ID,
			agent: "code-reviewer",
			persistSession: false,
			maxTurns: 0,
			includePartialMessages: true,
			forwardSubagentText: true,
			settings: observedSettings,
			settingSources: ["user", "project", "local"] as const,
			permissionMode: "default" as const,
			allowedTools: ["Read"],
			disallowedTools: ["Bash"],
			allowDangerouslySkipPermissions: false,
			env: { CLAUDE_AGENT_SDK_CLIENT_APP: "conduit" },
			effort: "xhigh" as const,
		};

		expect(decodeClaudeSDKOptionsJsonShape(options)).toBe(options);
		expect(options.settings).toEqual(observedSettings);
		expect(() =>
			decodeClaudeSDKOptionsJsonShape({ ...options, effort: 1 }),
		).toThrow();
		expect(() =>
			decodeClaudeSDKOptionsJsonShape({ ...options, persistSession: "false" }),
		).toThrow();
		expect(() =>
			decodeClaudeSDKOptionsJsonShape({ ...options, maxTurns: "0" }),
		).toThrow();
	});
});
