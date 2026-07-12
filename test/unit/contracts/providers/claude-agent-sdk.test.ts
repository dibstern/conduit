import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	CLAUDE_SDK_MESSAGE_VARIANTS,
	CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS,
	ClaudeSDKMessageSchema,
	ClaudeSDKOptionsJsonShapeSchema,
	ClaudeSDKUserMessageSchema,
} from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";

describe("Claude Agent SDK provider contract schemas", () => {
	it("decodes user message envelopes without stripping opaque tool results", () => {
		const raw = {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: [
							{
								type: "text",
								text: "done",
								meta: { nested: ["json", { survives: true }] },
							},
						],
					},
				],
			},
			parent_tool_use_id: null,
			tool_use_result: {
				arbitrary: { nested: ["json", { survives: true }] },
			},
			uuid: "00000000-0000-0000-0000-000000000001",
			session_id: "sdk-session-1",
		};

		const result = Schema.decodeUnknownEither(ClaudeSDKUserMessageSchema)(raw);

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.tool_use_result).toEqual(raw.tool_use_result);
		}
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ClaudeSDKUserMessageSchema)({
					...raw,
					message: { role: "assistant", content: [] },
				}),
			),
		).toBe(true);
	});

	it("decodes installed SDK stream variants while preserving opaque provider payloads", () => {
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

		const toolInput = { deeply: { nested: ["json", { survives: true }] } };
		const assistant = {
			type: "assistant",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [
					{ type: "tool_use", id: "toolu_1", name: "Bash", input: toolInput },
				],
			},
			parent_tool_use_id: null,
			uuid: "00000000-0000-0000-0000-000000000002",
			session_id: "sdk-session-1",
		};
		const structuredOutput = {
			arbitrary: { nested: ["json", { survives: true }] },
		};
		const result = {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "ok",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 2,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
			modelUsage: {},
			permission_denials: [],
			structured_output: structuredOutput,
			uuid: "00000000-0000-0000-0000-000000000003",
			session_id: "sdk-session-1",
		};
		const streamEvent = {
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_1",
					name: "Bash",
					input: toolInput,
				},
			},
			parent_tool_use_id: null,
			uuid: "00000000-0000-0000-0000-000000000004",
			session_id: "sdk-session-1",
		};
		const system = {
			type: "system",
			subtype: "status",
			status: "requesting",
			permissionMode: "default",
			uuid: "00000000-0000-0000-0000-000000000005",
			session_id: "sdk-session-1",
		};

		for (const message of [assistant, result, streamEvent, system]) {
			expect(
				Either.isRight(
					Schema.decodeUnknownEither(ClaudeSDKMessageSchema)(message),
				),
			).toBe(true);
		}

		const decodedAssistant = Schema.decodeUnknownEither(ClaudeSDKMessageSchema)(
			assistant,
		);
		const decodedResult = Schema.decodeUnknownEither(ClaudeSDKMessageSchema)(
			result,
		);
		const decodedStreamEvent = Schema.decodeUnknownEither(
			ClaudeSDKMessageSchema,
		)(streamEvent);

		if (
			Either.isRight(decodedAssistant) &&
			decodedAssistant.right.type === "assistant"
		) {
			expect(decodedAssistant.right.message).toEqual(assistant.message);
		}
		if (
			Either.isRight(decodedResult) &&
			decodedResult.right.type === "result" &&
			decodedResult.right.subtype === "success"
		) {
			expect(decodedResult.right.structured_output).toEqual(structuredOutput);
		}
		if (
			Either.isRight(decodedStreamEvent) &&
			decodedStreamEvent.right.type === "stream_event"
		) {
			expect(decodedStreamEvent.right.event).toEqual(streamEvent.event);
		}
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ClaudeSDKMessageSchema)({
					...result,
					subtype: "not-a-result-subtype",
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ClaudeSDKMessageSchema)({
					message: assistant.message,
					parent_tool_use_id: null,
					uuid: "00000000-0000-0000-0000-000000000006",
					session_id: "sdk-session-1",
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ClaudeSDKMessageSchema)({
					...assistant,
					session_id: 123,
				}),
			),
		).toBe(true);
	});

	it("validates the JSON-like Claude options shape Conduit owns", () => {
		const raw = {
			cwd: "/workspace/project",
			model: "sonnet",
			resume: "sdk-session-1",
			agent: "code-reviewer",
			includePartialMessages: true,
			settingSources: ["user", "project", "local"],
			permissionMode: "default",
			allowedTools: ["Read"],
			disallowedTools: ["Bash"],
			allowDangerouslySkipPermissions: false,
			env: { CLAUDE_AGENT_SDK_CLIENT_APP: "conduit" },
			effort: "high",
			settings: { showThinkingSummaries: true },
		};

		expect(
			Either.isRight(
				Schema.decodeUnknownEither(ClaudeSDKOptionsJsonShapeSchema)(raw),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(ClaudeSDKOptionsJsonShapeSchema)({
					...raw,
					permissionMode: "please",
				}),
			),
		).toBe(true);
	});
});
