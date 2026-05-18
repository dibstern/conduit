import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	ACTIVE_PROVIDER_RUNTIME_EVENT_TYPES,
	HISTORICAL_PROVIDER_RUNTIME_EVENT_TYPES,
	ProviderRuntimeEventSchema,
	ProviderRuntimeEventTypeSchema,
	ProviderRuntimeProviderRefsSchema,
	ProviderRuntimeRawSourceSchema,
} from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { CANONICAL_EVENT_TYPES } from "../../../../src/lib/persistence/events.js";

const baseEvent = {
	eventId: "evt_1",
	type: "message.created",
	providerId: "claude",
	sessionId: "session_1",
	providerRefs: {},
	rawSource: { kind: "claude-sdk" },
	createdAt: "2026-05-18T00:00:00.000Z",
	data: { messageId: "msg_1", role: "assistant", sessionId: "session_1" },
};

const decodeEither = (value: unknown) =>
	Schema.decodeUnknownEither(ProviderRuntimeEventSchema)(value);

const REPO_ROOT = process.cwd();
const CONTRACT_SOURCE_PATH =
	"src/lib/contracts/providers/provider-runtime-event.ts";
const CONTRACT_SOURCE = join(REPO_ROOT, CONTRACT_SOURCE_PATH);

function tsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...tsFiles(path));
		} else if (path.endsWith(".ts")) {
			files.push(relative(REPO_ROOT, path));
		}
	}
	return files.sort();
}

describe("ProviderRuntimeEvent contracts", () => {
	it("rejects missing base envelope identity", () => {
		expect(Either.isRight(decodeEither(baseEvent))).toBe(true);

		for (const field of [
			"eventId",
			"type",
			"providerId",
			"sessionId",
			"providerRefs",
			"rawSource",
			"createdAt",
			"data",
		] as const) {
			const { [field]: _removed, ...eventWithoutRequiredField } = baseEvent;

			expect(Either.isLeft(decodeEither(eventWithoutRequiredField))).toBe(true);
		}
	});

	it("covers every canonical event type or explicit reclassification", () => {
		const explicitlyReclassified: readonly string[] = [];
		const missingRuntimeTypes = CANONICAL_EVENT_TYPES.filter(
			(type) =>
				!explicitlyReclassified.includes(type) &&
				Either.isLeft(
					Schema.decodeUnknownEither(ProviderRuntimeEventTypeSchema)(type),
				),
		);

		expect(missingRuntimeTypes).toEqual([]);
	});

	it("decodes raw-source metadata fields", () => {
		const rawSource = {
			kind: "claude-sdk",
			providerMessageType: "assistant",
			providerMessageSubtype: "content_block_delta",
			sdkVariant: "typescript-v2-preview",
			streamEventType: "message_delta",
			endpoint: "/v1/messages",
			sourceSchema: "ClaudeAgentSdkStreamMessageSchema",
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			rawSource,
		});

		expect(
			Either.isRight(
				Schema.decodeUnknownEither(ProviderRuntimeRawSourceSchema)(rawSource),
			),
		).toBe(true);
		expect(event.rawSource).toEqual(rawSource);
	});

	it("decodes Claude refs", () => {
		const providerRefs = {
			providerSessionId: "claude-session-1",
			providerMessageId: "msg_1",
			providerToolUseId: "toolu_1",
			providerTaskId: "task_1",
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			type: "tool.started",
			providerRefs,
			data: {
				messageId: "msg_1",
				partId: "part_1",
				toolName: "Bash",
				callId: "toolu_1",
				input: { command: "pnpm check" },
			},
		});

		expect(
			Either.isRight(
				Schema.decodeUnknownEither(ProviderRuntimeProviderRefsSchema)(
					providerRefs,
				),
			),
		).toBe(true);
		expect(event.providerRefs).toEqual(providerRefs);
		expect(event.rawSource).not.toHaveProperty("raw");
	});

	it("marks tool.input_updated as historical compatibility", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(ProviderRuntimeEventTypeSchema)(
					"tool.input_updated",
				),
			),
		).toBe(true);
		expect(HISTORICAL_PROVIDER_RUNTIME_EVENT_TYPES).toEqual([
			"tool.input_updated",
		]);
		expect(ACTIVE_PROVIDER_RUNTIME_EVENT_TYPES).not.toContain(
			"tool.input_updated",
		);
	});

	it("rejects unknown runtime event type", () => {
		expect(Either.isLeft(decodeEither({ ...baseEvent, type: "made.up" }))).toBe(
			true,
		);
	});

	it("rejects raw payload fields in rawSource", () => {
		for (const field of [
			"raw",
			"rawPayload",
			"sdkPayload",
			"providerPayload",
		] as const) {
			expect(
				Either.isLeft(
					decodeEither({
						...baseEvent,
						rawSource: { kind: "claude-sdk", [field]: { type: "assistant" } },
					}),
				),
			).toBe(true);
		}
	});

	it("rejects top-level raw payload fields", () => {
		for (const field of ["raw", "payload", "rawPayload"] as const) {
			expect(
				Either.isLeft(
					decodeEither({
						...baseEvent,
						[field]: { type: "provider-message", content: [] },
					}),
				),
			).toBe(true);
		}
	});

	it("decodes OpenCode refs", () => {
		const providerRefs = {
			providerSessionId: "opencode-session-1",
			providerMessageId: "msg_1",
			providerRequestId: "req_1",
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			providerId: "opencode",
			type: "permission.asked",
			providerRefs,
			rawSource: {
				kind: "opencode-sdk",
				streamEventType: "permission.asked",
				endpoint: "/event",
			},
			data: {
				id: "req_1",
				sessionId: "session_1",
				toolName: "Bash",
				input: { command: "pnpm check", cwd: "/repo" },
			},
		});

		expect(
			Either.isRight(
				Schema.decodeUnknownEither(ProviderRuntimeProviderRefsSchema)(
					providerRefs,
				),
			),
		).toBe(true);
		expect(event.providerId).toBe("opencode");
		expect(event.providerRefs).toEqual(providerRefs);
		expect(event.data).toEqual({
			id: "req_1",
			sessionId: "session_1",
			toolName: "Bash",
			input: { command: "pnpm check", cwd: "/repo" },
		});
	});

	it("preserves opaque provider-owned payloads", () => {
		const data = {
			messageId: "msg_1",
			partId: "part_1",
			toolName: "AskUserQuestion",
			callId: "toolu_question_1",
			input: {
				questions: [
					{
						id: "q1",
						header: "Confirm",
						question: "Which paths should be changed?",
						options: ["src", "test"],
					},
				],
				nested: { resultShape: [{ ok: true }, null] },
			},
			result: {
				answers: { q1: ["src", "test"] },
				rawProviderResult: { status: "ok", values: [1, "two"] },
			},
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			type: "tool.completed",
			providerRefs: {
				providerSessionId: "claude-session-1",
				providerMessageId: "msg_1",
				providerToolUseId: "toolu_question_1",
			},
			data,
		});

		expect(event.data).toEqual(data);
	});

	it("rejects unknown providerRefs keys", () => {
		for (const providerRefs of [
			{ providerSessionId: "session_1", providerMessageID: "msg_1" },
			{ providerSessionId: "session_1", providerItemId: "item_1" },
		]) {
			expect(
				Either.isLeft(
					Schema.decodeUnknownEither(ProviderRuntimeProviderRefsSchema)(
						providerRefs,
					),
				),
			).toBe(true);
			expect(Either.isLeft(decodeEither({ ...baseEvent, providerRefs }))).toBe(
				true,
			);
		}
	});

	it("keeps ProviderRuntimeEvent contract-only in production code", () => {
		const filesImportingContract = tsFiles(join(REPO_ROOT, "src/lib"))
			.filter((file) => file !== CONTRACT_SOURCE_PATH)
			.filter((file) => {
				const source = readFileSync(join(REPO_ROOT, file), "utf8");
				return (
					source.includes("ProviderRuntimeEvent") ||
					source.includes("provider-runtime-event.js")
				);
			});

		expect(filesImportingContract).toEqual([]);
	});

	it("stays implementation-free", () => {
		const source = readFileSync(CONTRACT_SOURCE, "utf8");
		const imports = Array.from(
			source.matchAll(/^import\s+.*\s+from\s+["']([^"']+)["'];$/gm),
			(match) => match[1],
		);

		expect(imports).toEqual(["effect"]);
		expect(source).not.toMatch(
			/Context\.Tag|Layer|Effect\.|CanonicalEvent|ProviderInstance|RelayMessage|EventSink|sqlite|fetch\(/,
		);
	});
});
