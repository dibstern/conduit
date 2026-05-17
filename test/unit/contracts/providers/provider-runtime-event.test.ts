import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	ProviderRuntimeEventSchema,
	ProviderRuntimeEventTypeSchema,
} from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import { CANONICAL_EVENT_TYPES } from "../../../../src/lib/persistence/events.js";

const REPO_ROOT = process.cwd();
const SOURCE_PATH = "src/lib/contracts/providers/provider-runtime-event.ts";
const BEHAVIOR_PATH_PREFIXES = [
	"src/lib/storage/",
	"src/lib/persistence/",
	"src/lib/relay/",
	"src/lib/handlers/",
	"src/lib/frontend/",
	"src/lib/provider/",
] as const;

const baseEvent = {
	eventId: "evt_1",
	type: "message.created",
	providerId: "claude",
	sessionId: "session_1",
	providerRefs: {
		providerSessionId: "claude-session-1",
	},
	rawSource: {
		kind: "claude.sdk.message",
		providerMessageType: "assistant",
		sdkVariant: "agent-sdk",
	},
	createdAt: 1_779_552_000_000,
	data: {
		messageId: "message_1",
		role: "assistant",
		sessionId: "session_1",
	},
};

const requiredEnvelopeFields = [
	"eventId",
	"type",
	"providerId",
	"sessionId",
	"providerRefs",
	"rawSource",
	"createdAt",
	"data",
] as const;

const decodeEventEither = (value: unknown) =>
	Schema.decodeUnknownEither(ProviderRuntimeEventSchema)(value);

const decodeTypeEither = (value: unknown) =>
	Schema.decodeUnknownEither(ProviderRuntimeEventTypeSchema)(value);

function tsFiles(dir: string): string[] {
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
	it("keeps ProviderRuntimeEvent contract-only and unused by behavior modules", () => {
		const productionReferences = tsFiles(join(REPO_ROOT, "src/lib"))
			.filter((file) => file !== SOURCE_PATH)
			.filter((file) =>
				/ProviderRuntimeEvent|provider-runtime-event/.test(
					readFileSync(join(REPO_ROOT, file), "utf8"),
				),
			);
		const behaviorReferences = productionReferences.filter((file) =>
			BEHAVIOR_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)),
		);

		expect(productionReferences).toEqual([]);
		expect(behaviorReferences).toEqual([]);
	});

	it("rejects missing base envelope identity", () => {
		for (const field of requiredEnvelopeFields) {
			const candidate: Record<string, unknown> = { ...baseEvent };
			delete candidate[field];

			expect(Either.isLeft(decodeEventEither(candidate)), field).toBe(true);
		}
	});

	it("covers every canonical event type or explicit reclassification", () => {
		const explicitReclassifications = new Map<string, string>();
		const missingRuntimeTypes = CANONICAL_EVENT_TYPES.filter(
			(type) =>
				Either.isLeft(decodeTypeEither(type)) &&
				!explicitReclassifications.has(type),
		);

		expect(missingRuntimeTypes).toEqual([]);
		expect(explicitReclassifications.size).toBe(0);
	});

	it("rejects unknown runtime event type", () => {
		expect(
			Either.isLeft(decodeEventEither({ ...baseEvent, type: "made.up" })),
		).toBe(true);
	});

	it("marks tool.input_updated as historical compatibility", () => {
		const newProviderRuntimeTypes = CANONICAL_EVENT_TYPES.filter(
			(type) => type !== "tool.input_updated",
		);
		const source = readFileSync(join(REPO_ROOT, SOURCE_PATH), "utf8");

		expect(Either.isRight(decodeTypeEither("tool.input_updated"))).toBe(true);
		expect(newProviderRuntimeTypes).not.toContain("tool.input_updated");
		expect(source).toContain(
			'"tool.input_updated", // Historical compatibility only; new provider runtimes should not emit it.',
		);
		expect(
			Either.isRight(
				decodeEventEither({
					...baseEvent,
					type: "tool.input_updated",
					data: { messageId: "message_1", partId: "part_1" },
				}),
			),
		).toBe(true);
	});

	it("rejects raw payload fields in rawSource", () => {
		for (const field of [
			"raw",
			"rawPayload",
			"sdkPayload",
			"providerPayload",
		]) {
			expect(
				Either.isLeft(
					decodeEventEither({
						...baseEvent,
						rawSource: {
							...baseEvent.rawSource,
							[field]: { hidden: "sdk-message" },
						},
					}),
				),
				field,
			).toBe(true);
		}
	});

	it("decodes Claude refs", () => {
		const input = {
			command: "pnpm check",
			options: { cwd: "/tmp/project", env: { CI: "true" } },
		};
		const event = {
			...baseEvent,
			type: "tool.started",
			providerRefs: {
				providerSessionId: "claude-session-1",
				providerMessageId: "msg_01",
				providerToolUseId: "toolu_01",
				providerTaskId: "task_01",
			},
			rawSource: {
				kind: "claude.sdk.message",
				providerMessageType: "assistant",
				providerMessageSubtype: "tool_use",
				sdkVariant: "agent-sdk",
			},
			data: {
				messageId: "message_1",
				partId: "part_1",
				toolName: "Bash",
				callId: "toolu_01",
				input,
			},
		};

		const result = decodeEventEither(event);

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.providerRefs).toEqual(event.providerRefs);
			expect(result.right.data).toEqual(event.data);
		}
	});

	it("decodes OpenCode refs", () => {
		const event = {
			...baseEvent,
			type: "permission.asked",
			providerId: "opencode",
			providerRefs: {
				providerSessionId: "oc-session-1",
				providerMessageId: "oc-message-1",
				providerRequestId: "request_01",
			},
			rawSource: {
				kind: "opencode.sdk.event",
				streamEventType: "permission.asked",
				endpoint: "/event",
				sourceSchema: "OpenCodeEvent",
			},
			data: {
				id: "permission_1",
				sessionId: "session_1",
				toolName: "Bash",
				input: {
					command: "pnpm test:unit",
					description: "Run tests",
				},
			},
		};

		const result = decodeEventEither(event);

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.providerId).toBe("opencode");
			expect(result.right.providerRefs).toEqual(event.providerRefs);
			expect(result.right.data).toEqual(event.data);
		}
	});

	it("preserves opaque provider-owned payloads", () => {
		const providerOwnedPayload = {
			tool: {
				input: {
					command: "python3 - <<'PY'\nprint('ok')\nPY",
					nested: [{ allow: true }, { retries: 2 }],
				},
				result: {
					exitCode: 0,
					stdout: "ok\n",
					metadata: { durationMs: 12, chunks: ["o", "k"] },
				},
			},
			question: {
				questions: [
					{
						id: "q1",
						text: "Choose files",
						options: [{ label: "src" }, { label: "test" }],
					},
				],
			},
		};

		const result = decodeEventEither({
			...baseEvent,
			type: "tool.completed",
			data: providerOwnedPayload,
		});

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.data).toEqual(providerOwnedPayload);
		}
	});
});
