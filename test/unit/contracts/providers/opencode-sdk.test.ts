import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	OPEN_CODE_CONSUMED_EVENT_TYPES,
	OpenCodeAgentSchema,
	OpenCodeCommandSchema,
	OpenCodeEventSchema,
	OpenCodeFileNodeSchema,
	OpenCodeFileStatusEntrySchema,
	OpenCodeMessageWithPartsSchema,
	OpenCodePartSchema,
	OpenCodePathSchema,
	OpenCodePendingPermissionSchema,
	OpenCodePendingQuestionSchema,
	OpenCodePermissionReplyRequestSchema,
	OpenCodeProjectSchema,
	OpenCodeProviderListResponseSchema,
	OpenCodeQuestionRejectRequestSchema,
	OpenCodeQuestionReplyRequestSchema,
	OpenCodeSessionDetailSchema,
	OpenCodeSessionPromptRequestSchema,
	OpenCodeSessionSchema,
	OpenCodeSessionStatusSchema,
	OpenCodeSessionUpdateRequestSchema,
	OpenCodeUndefinedResponseSchema,
} from "../../../../src/lib/contracts/providers/opencode-sdk.js";

describe("OpenCode provider contract schemas", () => {
	it("decodes SDK session envelopes and rejects missing identity fields", () => {
		const validSession = {
			id: "ses_1",
			projectID: "proj_1",
			directory: "/workspace/project",
			title: "Test session",
			version: "1.0.0",
			time: { created: 1, updated: 2 },
		};

		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeSessionSchema)(validSession),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(Schema.Array(OpenCodeSessionSchema))([
					validSession,
				]),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeSessionSchema)({
					...validSession,
					id: undefined,
				}),
			),
		).toBe(true);
	});

	it("decodes session status maps returned by OpenCode", () => {
		const result = Schema.decodeUnknownEither(
			Schema.Record({ key: Schema.String, value: OpenCodeSessionStatusSchema }),
		)({
			ses_1: { type: "idle" },
			ses_2: { type: "busy" },
			ses_3: {
				type: "retry",
				attempt: 2,
				message: "rate limited",
				next: 1700000000,
			},
		});

		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes relay session-detail extension fields returned by OpenCode", () => {
		const result = Schema.decodeUnknownEither(OpenCodeSessionDetailSchema)({
			id: "ses_1",
			projectID: "proj_1",
			directory: "/workspace/project",
			title: "Test session",
			version: "1.0.0",
			time: { created: 1, updated: 2 },
			modelID: "claude",
			providerID: "anthropic",
			agentID: "build",
			slug: "test-session",
			archived: false,
		});

		expect(Either.isRight(result)).toBe(true);
	});

	it("validates OpenCode session status variants", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeSessionStatusSchema)({
					type: "idle",
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeSessionStatusSchema)({
					type: "busy",
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeSessionStatusSchema)({
					type: "retry",
					attempt: 2,
					message: "rate limited",
					next: 1700000000,
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeSessionStatusSchema)({
					type: "retry",
					attempt: 2,
				}),
			),
		).toBe(true);
	});

	it("decodes SDK app path responses", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodePathSchema)({
					state: "/state",
					config: "/config",
					worktree: "/workspace/project",
					directory: "/workspace/project",
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodePathSchema)({
					cwd: "/workspace/project",
				}),
			),
		).toBe(true);
	});

	it("decodes SDK file status entries", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeFileStatusEntrySchema)({
					path: "src/app.ts",
					added: 2,
					removed: 1,
					status: "modified",
				}),
			),
		).toBe(true);
	});

	it("decodes file-list envelopes from SDK and legacy mock responses", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeFileNodeSchema)({
					name: "app.ts",
					type: "file",
					path: "src/app.ts",
					absolute: "/repo/src/app.ts",
					ignored: false,
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeFileNodeSchema)({
					name: "package.json",
					type: "file",
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeFileNodeSchema)({
					name: "package.json",
				}),
			),
		).toBe(true);
	});

	it("decodes SDK agents without requiring local public ids or provider-owned permission shape", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeAgentSchema)({
					name: "build",
					description: "Build agent",
					mode: "primary",
					builtIn: true,
					permission: { edit: "ask", bash: {} },
					tools: {},
					options: {},
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeAgentSchema)({
					name: "build",
					mode: "primary",
					native: true,
					permission: [
						{ permission: "*", action: "allow", pattern: "*" },
						{ permission: "question", action: "deny", pattern: "*" },
					],
					options: {},
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeAgentSchema)({
					description: "missing name",
					mode: "primary",
				}),
			),
		).toBe(true);
	});

	it("decodes SDK void responses from 204 calls and rejects non-empty bodies", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeUndefinedResponseSchema)(undefined),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeUndefinedResponseSchema)({}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeUndefinedResponseSchema)({
					accepted: true,
				}),
			),
		).toBe(true);
	});

	it("decodes SDK command, project, and provider list responses", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeCommandSchema)({
					name: "fix",
					description: "Fix issue",
					template: "Fix {{args}}",
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeCommandSchema)({
					name: "fix",
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeProjectSchema)({
					id: "proj1",
					worktree: "/workspace/project",
					time: { created: 1 },
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeProviderListResponseSchema)({
					all: [
						{
							id: "anthropic",
							name: "Anthropic",
							env: ["ANTHROPIC_API_KEY"],
							models: {
								"claude-sonnet-4": {
									id: "claude-sonnet-4",
									name: "Claude Sonnet 4",
									release_date: "2026-01-01",
									attachment: true,
									reasoning: true,
									temperature: true,
									tool_call: true,
									limit: { context: 200000, output: 64000 },
									options: {},
									variants: {
										"1m": { limit: { context: 1000000 } },
									},
								},
							},
						},
					],
					default: { anthropic: "claude-sonnet-4" },
					connected: ["anthropic"],
				}),
			),
		).toBe(true);
	});

	it("decodes part envelopes without stripping provider-owned metadata", () => {
		const raw = {
			id: "part-1",
			type: "tool",
			metadata: {
				nested: {
					values: [1, "two", { ok: true }],
				},
			},
		};

		const result = Schema.decodeUnknownEither(OpenCodePartSchema)(raw);

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right["metadata"]).toEqual(raw.metadata);
		}
	});

	it("decodes message-with-parts responses and preserves opaque part payloads", () => {
		const raw = {
			info: {
				id: "msg-1",
				sessionID: "ses_1",
				role: "assistant",
				time: { created: 3, completed: 4 },
				parentID: "msg-0",
				modelID: "model",
				providerID: "provider",
				mode: "build",
				path: { cwd: "/workspace/project", root: "/workspace" },
				cost: 0.1,
				tokens: {
					input: 10,
					output: 20,
					reasoning: 0,
					cache: { read: 1, write: 2 },
				},
			},
			parts: [
				{
					id: "part-1",
					type: "tool",
					state: {
						status: "completed",
						input: { deeply: { nested: ["json", { survives: true }] } },
					},
				},
			],
		};

		const result = Schema.decodeUnknownEither(OpenCodeMessageWithPartsSchema)(
			raw,
		);

		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result)) {
			expect(result.right.parts[0]?.["state"]).toEqual(raw.parts[0]?.state);
		}
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeMessageWithPartsSchema)({
					info: raw.info,
				}),
			),
		).toBe(true);
	});

	it("documents and validates OpenCode events Conduit currently consumes", () => {
		expect(OPEN_CODE_CONSUMED_EVENT_TYPES).toEqual([
			"message.created",
			"message.part.delta",
			"message.part.updated",
			"message.part.removed",
			"message.updated",
			"message.removed",
			"session.status",
			"session.error",
			"permission.asked",
			"permission.replied",
			"question.asked",
			"session.updated",
			"todo.updated",
			"pty.created",
			"pty.exited",
			"pty.deleted",
			"file.edited",
			"file.watcher.updated",
			"installation.update-available",
		]);

		const validGapEvent = {
			type: "message.part.delta",
			properties: {
				partID: "part-1",
				field: "text",
				delta: "hello",
				extra: { provider: ["owned"] },
			},
		};

		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeEventSchema)(validGapEvent),
			),
		).toBe(true);

		const validPartRemovedEvent = {
			type: "message.part.removed",
			properties: {
				partID: "part-1",
				messageID: "msg-1",
				sessionID: "ses-1",
				extra: { provider: ["owned"] },
			},
		};
		const decodedPartRemoved = Schema.decodeUnknownEither(OpenCodeEventSchema)(
			validPartRemovedEvent,
		);
		expect(Either.isRight(decodedPartRemoved)).toBe(true);
		if (Either.isRight(decodedPartRemoved)) {
			expect(decodedPartRemoved.right.properties["extra"]).toEqual(
				validPartRemovedEvent.properties.extra,
			);
		}

		const validMessageRemovedEvent = {
			type: "message.removed",
			properties: {
				messageID: "msg-1",
				sessionID: "ses-1",
				extra: { provider: ["owned"] },
			},
		};
		const decodedMessageRemoved = Schema.decodeUnknownEither(
			OpenCodeEventSchema,
		)(validMessageRemovedEvent);
		expect(Either.isRight(decodedMessageRemoved)).toBe(true);
		if (Either.isRight(decodedMessageRemoved)) {
			expect(decodedMessageRemoved.right.properties["extra"]).toEqual(
				validMessageRemovedEvent.properties.extra,
			);
		}
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeEventSchema)({
					type: "message.part.delta",
					properties: { partID: "part-1", delta: "missing field" },
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeEventSchema)({
					type: "message.part.removed",
					properties: { messageID: "msg-1" },
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeEventSchema)({
					type: "message.removed",
					properties: { sessionID: "ses-1" },
				}),
			),
		).toBe(true);
	});

	it("validates OpenCode request bodies Conduit sends to SDK and gap endpoints", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeSessionPromptRequestSchema)({
					parts: [{ type: "text", text: "hello" }],
					model: { providerID: "anthropic", modelID: "claude" },
					agent: "build",
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodeSessionPromptRequestSchema)({
					parts: [{ type: "text" }],
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeSessionUpdateRequestSchema)({
					title: "Renamed",
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodePermissionReplyRequestSchema)({
					response: "once",
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeQuestionReplyRequestSchema)({
					answers: [["yes"], ["custom", "answer"]],
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodeQuestionRejectRequestSchema)({}),
			),
		).toBe(true);
	});

	it("validates gap endpoint response envelopes Conduit reads", () => {
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodePendingPermissionSchema)({
					id: "per_1",
					sessionID: "ses_1",
					permission: "bash",
					patterns: ["npm test"],
					metadata: { nested: ["json", { survives: true }] },
					always: ["npm test"],
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodePendingPermissionSchema)({
					id: "perm-1",
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodePendingPermissionSchema)({
					id: "per_1",
					sessionID: "ses_1",
					permission: "bash",
					patterns: ["npm test"],
					metadata: {},
				}),
			),
		).toBe(true);
		expect(
			Either.isRight(
				Schema.decodeUnknownEither(OpenCodePendingQuestionSchema)({
					id: "que_1",
					sessionID: "ses_1",
					questions: [{ question: "Pick", options: [{ label: "A" }] }],
				}),
			),
		).toBe(true);
		expect(
			Either.isLeft(
				Schema.decodeUnknownEither(OpenCodePendingQuestionSchema)({
					id: "que_1",
					sessionID: "ses_1",
				}),
			),
		).toBe(true);
	});
});
