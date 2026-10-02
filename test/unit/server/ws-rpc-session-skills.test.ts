import { type RpcClient, RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderCapabilities } from "../../../src/lib/provider/types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const capabilities: ProviderCapabilities = {
	models: [],
	supportsTools: true,
	supportsThinking: true,
	supportsPermissions: true,
	supportsQuestions: true,
	supportsAttachments: true,
	supportsFork: true,
	supportsRevert: true,
	commands: [
		{ name: "review", source: "project-skill" },
		{ name: "personal", source: "user-skill" },
		{ name: "compact", source: "builtin" },
		{ name: "project-command", source: "project-command" },
		{ name: "user-command", source: "user-command" },
		{ name: "sdk", source: "claude-sdk" },
		{ name: "my-plugin:my-skill", source: "plugin-skill" },
		{ name: "anthropic-skills:pdf", source: "plugin-skill" },
	],
};

const runTest = <E>(
	test: (
		client: RpcClient.FromGroup<typeof WsRpcGroup>,
		sql: SqlClient.SqlClient,
	) => Effect.Effect<void, E>,
	options: { provider?: "claude" | "opencode"; discoveryFails?: boolean } = {},
) =>
	Effect.gen(function* () {
		yield* makeEffectSqlMigrator();
		const sql = yield* SqlClient.SqlClient;
		const readQueryEffect = yield* makeReadQueryEffect;
		const engine = new OrchestrationEngine({
			registry: new ProviderRegistry(),
		});
		const provider = options.provider ?? "claude";
		for (const id of ["session", "subagent", "fork"]) {
			yield* sql`INSERT INTO sessions
				(id, provider, title, status, created_at, updated_at)
				VALUES (${id}, ${provider}, 'Test', 'idle', 1, 1)`;
			engine.bindSession(id, provider);
		}
		const discover = vi
			.spyOn(engine, "dispatchEffect")
			.mockImplementation((command) => {
				expect(command).toEqual({ type: "discover", providerId: "claude" });
				return options.discoveryFails
					? Effect.fail(
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "discover",
								cause: new Error("discovery unavailable"),
							}),
						)
					: Effect.succeed(capabilities);
			});
		const api = makeMockOpenCodeAPI();
		if (options.discoveryFails) {
			vi.mocked(api.app.commands).mockRejectedValue(
				new Error("discovery unavailable"),
			);
		} else {
			vi.mocked(api.app.commands).mockResolvedValue([
				{ name: "review", source: "skill" },
				{ name: "compact", source: "command" },
				{ name: "mcp", source: "mcp" },
				{ name: "other-command", source: "command" },
				{ name: "unsourced" },
			]);
		}
		return yield* Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			yield* test(client, sql);
			if (provider === "claude") {
				expect(discover).toHaveBeenCalled();
				expect(api.app.commands).not.toHaveBeenCalled();
			} else {
				expect(discover).not.toHaveBeenCalled();
				expect(api.app.commands).toHaveBeenCalled();
			}
		}).pipe(
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						// RpcTest requests inherit these services as well as handler context.
						Layer.merge(
							makeTestHandlerLayer({ api, orchestrationEngine: engine }),
							Layer.succeed(ReadQueryEffectTag, readQueryEffect),
						),
					),
				),
			),
		);
	}).pipe(
		Effect.scoped,
		Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
	);

const seedMessage = (
	sql: SqlClient.SqlClient,
	message: {
		id: string;
		role: "user" | "assistant";
		text?: string;
		at: number;
		sessionId?: string;
	},
) => sql`INSERT INTO messages
	(id, session_id, role, text, created_at, updated_at)
	VALUES (${message.id}, ${message.sessionId ?? "session"}, ${message.role},
		${message.text ?? ""}, ${message.at}, ${message.at})`;

const seedPart = (
	sql: SqlClient.SqlClient,
	part: {
		id: string;
		messageId: string;
		input?: string | null;
		result?: string;
		toolName?: string | null;
		status?: string;
		type?: "tool" | "text";
		sortOrder?: number;
		at: number;
	},
) => sql`INSERT INTO message_parts
	(id, message_id, type, tool_name, input, result, status, sort_order,
		created_at, updated_at)
	VALUES (${part.id}, ${part.messageId}, ${part.type ?? "tool"},
		${part.toolName ?? null}, ${part.input ?? null}, ${part.result ?? null},
		${part.status ?? "completed"}, ${part.sortOrder ?? 0}, ${part.at}, ${part.at})`;

describe("WsRpcServerLayer GetSessionSkills with SQLite", () => {
	afterEach(() => vi.restoreAllMocks());

	it.effect("combines user and canonical agent loads in one turn", () =>
		runTest((client, sql) =>
			Effect.gen(function* () {
				yield* seedMessage(sql, {
					id: "user",
					role: "user",
					text: "<attached-files>\n/review\n</attached-files>\n<user-message>\n/review /compact /nope /project-command /user-command /sdk /personal\n</user-message>",
					at: 10,
				});
				yield* seedMessage(sql, { id: "agent", role: "assistant", at: 20 });
				yield* seedPart(sql, {
					id: "skill",
					messageId: "agent",
					toolName: "historical-name",
					input: JSON.stringify({ tool: "Skill", name: "agent-only" }),
					at: 21,
				});
				expect(
					yield* client.GetSessionSkills({
						projectSlug: "test-project",
						sessionId: "session",
					}),
				).toEqual({
					loads: [
						{
							name: "review",
							invokedBy: "user",
							turnOrdinal: 1,
							at: 10,
							anchor: { messageId: "user" },
							running: false,
						},
						{
							name: "personal",
							invokedBy: "user",
							turnOrdinal: 1,
							at: 10,
							anchor: { messageId: "user" },
							running: false,
						},
						{
							name: "agent-only",
							invokedBy: "agent",
							turnOrdinal: 1,
							at: 21,
							anchor: { messageId: "agent", partId: "skill" },
							running: false,
						},
					],
				});
			}),
		),
	);

	it.effect(
		"keeps repeats and counts every user turn in read-model order",
		() =>
			runTest((client, sql) =>
				Effect.gen(function* () {
					// Insert out of order, including tied timestamps, to exercise the query ordering.
					for (const message of [
						{ id: "d-user", role: "user", text: "No skill", at: 20 },
						{ id: "c-agent", role: "assistant", at: 20 },
						{ id: "b-user", role: "user", text: "/review /review", at: 20 },
						{ id: "a-agent", role: "assistant", at: 10 },
						{ id: "e-agent", role: "assistant", at: 30 },
						{ id: "f-user", role: "user", text: "/review", at: 40 },
					] as const)
						yield* seedMessage(sql, message);
					for (const part of [
						{ id: "before-user", messageId: "a-agent", at: 11 },
						{ id: "second-repeat", messageId: "c-agent", at: 22, sortOrder: 1 },
						{ id: "first-repeat", messageId: "c-agent", at: 21 },
						{ id: "pending", messageId: "e-agent", at: 31, status: "pending" },
						{ id: "user-tool", messageId: "f-user", at: 41 },
					])
						yield* seedPart(sql, {
							...part,
							toolName: "Skill",
							input: '{"name":"review"}',
						});
					const { loads } = yield* client.GetSessionSkills({
						projectSlug: "test-project",
						sessionId: "session",
					});
					expect(
						loads.map(({ invokedBy, turnOrdinal, at, running }) => ({
							invokedBy,
							turnOrdinal,
							at,
							running,
						})),
					).toEqual([
						{ invokedBy: "agent", turnOrdinal: 1, at: 11, running: false },
						{ invokedBy: "user", turnOrdinal: 1, at: 20, running: false },
						{ invokedBy: "user", turnOrdinal: 1, at: 20, running: false },
						{ invokedBy: "agent", turnOrdinal: 1, at: 21, running: false },
						{ invokedBy: "agent", turnOrdinal: 1, at: 22, running: false },
						{ invokedBy: "agent", turnOrdinal: 2, at: 31, running: true },
						{ invokedBy: "user", turnOrdinal: 3, at: 40, running: false },
						{ invokedBy: "agent", turnOrdinal: 3, at: 41, running: false },
					]);
					expect(loads.every(({ name }) => name === "review")).toBe(true);
				}),
			),
	);

	it.effect(
		"recovers legacy loads, tolerates invalid JSON, and reports running tools",
		() =>
			runTest((client, sql) =>
				Effect.gen(function* () {
					yield* seedMessage(sql, { id: "agent", role: "assistant", at: 10 });
					for (const [sortOrder, input] of [
						'{"tool":"Skill","name":""}',
						'{"skill":"legacy"}',
						null,
						"{broken",
						"null",
						'"not a record"',
					].entries()) {
						yield* seedPart(sql, {
							id: `legacy-${sortOrder}`,
							messageId: "agent",
							toolName: "Skill",
							input,
							result: "Launching skill: legacy",
							at: 11 + sortOrder,
							sortOrder,
						});
					}
					yield* seedPart(sql, {
						id: "running",
						messageId: "agent",
						toolName: "Skill",
						input: '{"name":"running-skill"}',
						status: "running",
						at: 20,
						sortOrder: 6,
					});
					yield* seedPart(sql, {
						id: "empty",
						messageId: "agent",
						toolName: "Skill",
						input: "{broken",
						at: 21,
						sortOrder: 7,
					});
					yield* seedPart(sql, {
						id: "text",
						messageId: "agent",
						type: "text",
						result: "Launching skill: ignored",
						at: 22,
						sortOrder: 8,
					});
					const { loads } = yield* client.GetSessionSkills({
						projectSlug: "test-project",
						sessionId: "session",
					});
					expect(loads).toEqual([
						...Array.from({ length: 6 }, (_, i) => ({
							name: "legacy",
							invokedBy: "agent",
							turnOrdinal: 1,
							at: 11 + i,
							anchor: { messageId: "agent", partId: `legacy-${i}` },
							running: false,
						})),
						{
							name: "running-skill",
							invokedBy: "agent",
							turnOrdinal: 1,
							at: 20,
							anchor: { messageId: "agent", partId: "running" },
							running: true,
						},
					]);
				}),
			),
	);

	it.effect(
		"excludes subagent messages and reads a rekeyed fork on its own",
		() =>
			runTest((client, sql) =>
				Effect.gen(function* () {
					yield* sql`UPDATE sessions SET parent_id = 'session' WHERE id = 'subagent'`;
					yield* sql`UPDATE sessions SET parent_id = 'session', fork_point_event = 'fork-event', fork_point_timestamp = 21, fork_point_message_id = 'agent' WHERE id = 'fork'`;
					yield* seedMessage(sql, {
						id: "user",
						role: "user",
						text: "/review",
						at: 10,
					});
					yield* seedMessage(sql, { id: "agent", role: "assistant", at: 20 });
					yield* seedPart(sql, {
						id: "skill",
						messageId: "agent",
						input: '{"tool":"Skill","name":"review"}',
						at: 21,
					});
					yield* seedMessage(sql, {
						id: "subagent-user",
						sessionId: "subagent",
						role: "user",
						text: "/personal",
						at: 11,
					});
					yield* seedMessage(sql, {
						id: "subagent-agent",
						sessionId: "subagent",
						role: "assistant",
						at: 12,
					});
					yield* seedPart(sql, {
						id: "subagent-skill",
						messageId: "subagent-agent",
						input: '{"tool":"Skill","name":"subagent-only"}',
						at: 13,
					});
					yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
					SELECT 'fork-' || id, 'fork', role, text, created_at, updated_at FROM messages WHERE session_id = 'session'`;
					yield* sql`INSERT INTO message_parts (id, message_id, type, tool_name, input, status, sort_order, created_at, updated_at)
					SELECT 'fork-' || id, 'fork-' || message_id, type, tool_name, input, status, sort_order, created_at, updated_at FROM message_parts WHERE message_id = 'agent'`;
					yield* seedMessage(sql, {
						id: "later",
						role: "user",
						text: "/personal",
						at: 30,
					});
					const read = (sessionId: string) =>
						client.GetSessionSkills({ projectSlug: "test-project", sessionId });
					const parent = yield* read("session");
					expect(parent.loads.map(({ name }) => name)).toEqual([
						"review",
						"review",
						"personal",
					]);
					expect(yield* read("fork")).toEqual({
						loads: [
							{
								name: "review",
								invokedBy: "user",
								turnOrdinal: 1,
								at: 10,
								anchor: { messageId: "fork-user" },
								running: false,
							},
							{
								name: "review",
								invokedBy: "agent",
								turnOrdinal: 1,
								at: 21,
								anchor: { messageId: "fork-agent", partId: "fork-skill" },
								running: false,
							},
						],
					});
					expect(
						(yield* read("subagent")).loads.map(({ name }) => name),
					).toEqual(["personal", "subagent-only"]);
				}),
			),
	);

	it.effect("counts a typed plugin skill as a user load", () =>
		runTest((client, sql) =>
			Effect.gen(function* () {
				yield* seedMessage(sql, {
					id: "user",
					role: "user",
					text: "/my-plugin:my-skill",
					at: 10,
				});
				expect(
					yield* client.GetSessionSkills({
						projectSlug: "test-project",
						sessionId: "session",
					}),
				).toEqual({
					loads: [
						{
							name: "my-plugin:my-skill",
							invokedBy: "user",
							turnOrdinal: 1,
							at: 10,
							anchor: { messageId: "user" },
							running: false,
						},
					],
				});
			}),
		),
	);

	it.effect(
		"excludes a typed skill from the bundled anthropic-skills plugin",
		() =>
			runTest((client, sql) =>
				Effect.gen(function* () {
					yield* seedMessage(sql, {
						id: "user",
						role: "user",
						text: "/anthropic-skills:pdf",
						at: 10,
					});
					expect(
						yield* client.GetSessionSkills({
							projectSlug: "test-project",
							sessionId: "session",
						}),
					).toEqual({ loads: [] });
				}),
			),
	);

	it.effect("recognizes only OpenCode commands sourced from skills", () =>
		runTest(
			(client, sql) =>
				Effect.gen(function* () {
					yield* seedMessage(sql, {
						id: "user",
						role: "user",
						text: "/review /compact /nope /mcp /other-command /unsourced",
						at: 10,
					});
					expect(
						yield* client.GetSessionSkills({
							projectSlug: "test-project",
							sessionId: "session",
						}),
					).toEqual({
						loads: [
							{
								name: "review",
								invokedBy: "user",
								turnOrdinal: 1,
								at: 10,
								anchor: { messageId: "user" },
								running: false,
							},
						],
					});
				}),
			{ provider: "opencode" },
		),
	);

	for (const provider of ["claude", "opencode"] as const) {
		it.effect(
			`fails on ${provider} discovery errors even with agent loads`,
			() =>
				runTest(
					(client, sql) =>
						Effect.gen(function* () {
							yield* seedMessage(sql, {
								id: "agent",
								role: "assistant",
								at: 10,
							});
							yield* seedPart(sql, {
								id: "skill",
								messageId: "agent",
								input: '{"tool":"Skill","name":"review"}',
								at: 11,
							});
							const result = yield* Effect.either(
								client.GetSessionSkills({
									projectSlug: "test-project",
									sessionId: "session",
								}),
							);
							expect(result._tag).toBe("Left");
							if (result._tag === "Left") {
								expect(result.left._tag).toBe("WsRpcError");
								expect(result.left.message).toContain(
									"GetSessionSkills failed:",
								);
								expect(result.left.message).toContain(
									provider === "claude"
										? "discovery unavailable"
										: "UnknownException",
								);
							}
						}),
					{ provider, discoveryFails: true },
				),
		);
	}
});
