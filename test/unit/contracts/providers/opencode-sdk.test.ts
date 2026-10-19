import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	OPEN_CODE_CONSUMED_EVENT_TYPES,
	OpenCodeAgentSchema,
	OpenCodeCommandSchema,
	OpenCodeEventSchema,
	OpenCodeFileNodeSchema,
	OpenCodeMessageWithPartsSchema,
	OpenCodePartSchema,
	OpenCodePathSchema,
	OpenCodePendingPermissionSchema,
	OpenCodePendingQuestionSchema,
	OpenCodeProjectSchema,
	OpenCodeProviderListResponseSchema,
	OpenCodeQuestionReplyRequestSchema,
	OpenCodeSessionDetailSchema,
	OpenCodeSessionSchema,
	OpenCodeSessionStatusSchema,
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
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeSessionSchema)(validSession),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(Schema.Array(OpenCodeSessionSchema))([
					validSession,
				]),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeSessionSchema)({
					...validSession,
					id: undefined,
				}),
			),
		).toBe(true);
	});

	it("decodes session status maps returned by OpenCode", () => {
		const result = Schema.decodeUnknownExit(
			Schema.Record(Schema.String, OpenCodeSessionStatusSchema),
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

		expect(Exit.isSuccess(result)).toBe(true);
	});

	it("decodes relay session-detail extension fields returned by OpenCode", () => {
		const permission = [
			{
				permission: "external_directory",
				pattern: "/extra/*",
				action: "allow",
			},
			{ permission: "edit", pattern: "*", action: "deny" },
			{
				permission: "external_directory",
				pattern: "/removed/*",
				action: "ask",
			},
		];
		const result = Schema.decodeUnknownExit(OpenCodeSessionDetailSchema)({
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
			permission,
		});

		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result)) {
			expect(result.value).toHaveProperty("permission", permission);
		}
	});

	it("rejects invalid session permission actions", () => {
		const result = Schema.decodeUnknownExit(OpenCodeSessionDetailSchema)({
			id: "ses_1",
			projectID: "proj_1",
			directory: "/workspace/project",
			title: "Test session",
			version: "1.0.0",
			time: { created: 1, updated: 2 },
			permission: [
				{
					permission: "external_directory",
					pattern: "/extra/*",
					action: "once",
				},
			],
		});
		expect(Exit.isFailure(result)).toBe(true);
	});

	it("validates OpenCode session status variants", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeSessionStatusSchema)({
					type: "idle",
				}),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeSessionStatusSchema)({
					type: "busy",
				}),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeSessionStatusSchema)({
					type: "retry",
					attempt: 2,
					message: "rate limited",
					next: 1700000000,
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeSessionStatusSchema)({
					type: "retry",
					attempt: 2,
				}),
			),
		).toBe(true);
	});

	it("decodes SDK app path responses", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodePathSchema)({
					state: "/state",
					config: "/config",
					worktree: "/workspace/project",
					directory: "/workspace/project",
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodePathSchema)({
					cwd: "/workspace/project",
				}),
			),
		).toBe(true);
	});

	it("decodes file-list envelopes from SDK and legacy mock responses", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeFileNodeSchema)({
					name: "app.ts",
					type: "file",
					path: "src/app.ts",
					absolute: "/repo/src/app.ts",
					ignored: false,
				}),
			),
		).toBe(true);
		// Conduit reads only name/type; a node without the provider-owned
		// path/absolute/ignored fields still decodes (grill #10).
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeFileNodeSchema)({
					name: "package.json",
					type: "file",
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeFileNodeSchema)({
					name: "package.json",
				}),
			),
		).toBe(true);
	});

	it("decodes SDK agents without requiring local public ids or provider-owned permission shape", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeAgentSchema)({
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
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeAgentSchema)({
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
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeAgentSchema)({
					description: "missing name",
					mode: "primary",
				}),
			),
		).toBe(true);
	});

	it("decodes SDK void responses from 204 calls and rejects non-empty bodies", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeUndefinedResponseSchema)(undefined),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeUndefinedResponseSchema)({}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeUndefinedResponseSchema)({
					accepted: true,
				}),
			),
		).toBe(true);
	});

	it("decodes SDK command, project, and provider list responses", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeCommandSchema)({
					name: "fix",
					description: "Fix issue",
					template: "Fix {{args}}",
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeCommandSchema)({
					name: "fix",
				}),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeProjectSchema)({
					id: "proj1",
					worktree: "/workspace/project",
					time: { created: 1 },
				}),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeProviderListResponseSchema)({
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

		const result = Schema.decodeUnknownExit(OpenCodePartSchema)(raw);

		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result)) {
			expect(result.value["metadata"]).toEqual(raw.metadata);
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

		const result = Schema.decodeUnknownExit(OpenCodeMessageWithPartsSchema)(
			raw,
		);

		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result)) {
			expect(result.value.parts[0]?.["state"]).toEqual(raw.parts[0]?.state);
		}
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeMessageWithPartsSchema)({
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
			"pty.updated",
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
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeEventSchema)(validGapEvent),
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
		const decodedPartRemoved = Schema.decodeUnknownExit(OpenCodeEventSchema)(
			validPartRemovedEvent,
		);
		expect(Exit.isSuccess(decodedPartRemoved)).toBe(true);
		if (Exit.isSuccess(decodedPartRemoved)) {
			expect(decodedPartRemoved.value.properties["extra"]).toEqual(
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
		const decodedMessageRemoved = Schema.decodeUnknownExit(OpenCodeEventSchema)(
			validMessageRemovedEvent,
		);
		expect(Exit.isSuccess(decodedMessageRemoved)).toBe(true);
		if (Exit.isSuccess(decodedMessageRemoved)) {
			expect(decodedMessageRemoved.value.properties["extra"]).toEqual(
				validMessageRemovedEvent.properties.extra,
			);
		}
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeEventSchema)({
					type: "message.part.delta",
					properties: { partID: "part-1", delta: "missing field" },
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeEventSchema)({
					type: "message.part.removed",
					properties: { messageID: "msg-1" },
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodeEventSchema)({
					type: "message.removed",
					properties: { sessionID: "ses-1" },
				}),
			),
		).toBe(true);
	});

	it("validates the question reply body Conduit sends to the SDK", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodeQuestionReplyRequestSchema)({
					answers: [["yes"], ["custom", "answer"]],
				}),
			),
		).toBe(true);
	});

	it("validates permission and question response envelopes Conduit reads", () => {
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodePendingPermissionSchema)({
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
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodePendingPermissionSchema)({
					id: "perm-1",
				}),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodePendingPermissionSchema)({
					id: "per_1",
					sessionID: "ses_1",
					permission: "bash",
					patterns: ["npm test"],
					metadata: {},
				}),
			),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(OpenCodePendingQuestionSchema)({
					id: "que_1",
					sessionID: "ses_1",
					questions: [{ question: "Pick", options: [{ label: "A" }] }],
				}),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(OpenCodePendingQuestionSchema)({
					id: "que_1",
					sessionID: "ses_1",
				}),
			),
		).toBe(true);
	});
});
