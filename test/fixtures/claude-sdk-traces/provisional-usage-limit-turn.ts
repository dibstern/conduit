import { randomUUID } from "node:crypto";
import { decodeProviderMessage } from "../../../src/lib/provider/claude/claude-sdk-validation.js";
import type { SDKUserMessage } from "../../../src/lib/provider/claude/types.js";

// PROVISIONAL: tool/stream envelopes follow extra-folder-read-turn.jsonl and
// api-retry-pong-turn.jsonl, checked against claude-agent-sdk.ts and sdk.d.ts.
// Native transcripts retain the cut-off user prompt. Tools may already have run.
// eon2.14 replaces this constructed limit turn with a real limited-turn capture.
export const provisionalLimitReply =
	"You've hit your limit · resets Monday 9:00";

export function provisionalRejectedLimit(sessionId: string) {
	return decodeProviderMessage({
		type: "rate_limit_event",
		session_id: sessionId,
		uuid: randomUUID(),
		rate_limit_info: {
			status: "rejected",
			rateLimitType: "seven_day",
			resetsAt: 1791370800,
		},
	});
}

export function provisionalUsageLimitTurn(
	sessionId: string,
	prompt: SDKUserMessage,
) {
	const assistantId = randomUUID();
	const syntheticId = randomUUID();
	const toolId = randomUUID();
	const frame = (event: Record<string, unknown>) =>
		decodeProviderMessage({
			type: "stream_event",
			event,
			session_id: sessionId,
			uuid: randomUUID(),
			parent_tool_use_id: null,
		});
	const assistant = (
		uuid: string,
		message: Record<string, unknown>,
		error?: string,
	) =>
		decodeProviderMessage({
			type: "assistant",
			session_id: sessionId,
			uuid,
			parent_tool_use_id: null,
			message,
			...(error ? { error } : {}),
		});
	const nativePrompt = { ...prompt, session_id: sessionId, uuid: randomUUID() };
	const work = [
		assistant(assistantId, {
			id: assistantId,
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: toolId,
					name: "Read",
					input: { file_path: "/provisional-already-read.txt" },
				},
			],
		}),
		decodeProviderMessage({
			type: "user",
			session_id: sessionId,
			uuid: randomUUID(),
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolId,
						content: "PROVISIONAL-TOOL-WORK-COMPLETE",
					},
				],
			},
		}),
	];
	const synthetic = assistant(
		syntheticId,
		{
			id: syntheticId,
			role: "assistant",
			model: "<synthetic>",
			content: [{ type: "text", text: provisionalLimitReply }],
		},
		"rate_limit",
	);
	const result = decodeProviderMessage({
		type: "result",
		subtype: "success",
		session_id: sessionId,
		uuid: randomUUID(),
		is_error: true,
		result: provisionalLimitReply,
		terminal_reason: "blocking_limit",
		stop_reason: null,
		num_turns: 1,
		duration_ms: 0,
		duration_api_ms: 0,
		total_cost_usd: 0,
		usage: {
			input_tokens: 1,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
	});
	return {
		nativeTranscript: [nativePrompt, ...work, synthetic],
		events: [
			frame({
				type: "message_start",
				message: {
					id: assistantId,
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
				},
			}),
			frame({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: toolId,
					name: "Read",
					input: { file_path: "/provisional-already-read.txt" },
				},
			}),
			frame({ type: "content_block_stop", index: 0 }),
			frame({ type: "message_stop" }),
			...work,
			frame({
				type: "message_start",
				message: {
					id: syntheticId,
					role: "assistant",
					model: "<synthetic>",
					content: [],
				},
			}),
			frame({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			frame({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: provisionalLimitReply },
			}),
			frame({ type: "content_block_stop", index: 0 }),
			frame({ type: "message_stop" }),
			provisionalRejectedLimit(sessionId),
			synthetic,
			result,
		],
	};
}
