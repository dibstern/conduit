/**
 * stream: true turns a mid-stream parse failure into a DEFECT. An unencodable
 * success schema would reach a user's browser as a crash no RpcTest-based test
 * could catch: that helper bypasses serialization. Keep JSON on both sides here.
 */
import { Socket, SocketServer } from "@effect/platform";
import {
	Rpc,
	RpcClient,
	RpcGroup,
	RpcSerialization,
	RpcServer,
} from "@effect/rpc";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Contracts from "../../../src/lib/contracts/ws-rpc.js";
import { RelayMessageSchema } from "../../../src/lib/shared-types.js";
import { makeFakeSocketServer } from "../../helpers/fake-socket-server.js";

const session = {
	id: "session-1",
	title: 'Review "wire"\n雪',
	status: "busy",
	createdAt: 100,
	updatedAt: 200,
	messageCount: 3,
	parentID: "parent-1",
	forkMessageId: "message-0",
	forkPointTimestamp: 90,
} as const;
const shellEnvelopes = [
	{ _tag: "snapshot", rows: [session], sequence: 40 },
	{ _tag: "synchronized" },
	{ _tag: "upsert", item: { ...session, status: "idle" }, sequence: 41 },
	{ _tag: "remove", id: "session-1", sequence: 42 },
] as const;

const detailEnvelopes = [
	{
		_tag: "snapshot",
		rows: [
			{
				_tag: "transcriptMessage",
				message: {
					id: "message-1",
					role: "assistant",
					parts: [{ id: "part-1", type: "text", text: 'Hello "world"\n雪' }],
					time: { created: 100, completed: 200 },
					cost: 0.02,
					tokens: { input: 10, output: 20 },
					modelExecution: {
						requestedModel: "claude-fable-5-1[1m]",
						expectedModel: "claude-fable-5-1[1m]",
						actualModel: "claude-fable-5-1",
						drifted: false,
					},
				},
			},
		],
		sequence: 40,
	},
	{ _tag: "synchronized" },
	{
		// The delta ni8.5 §7 makes detail emit: the whole projected message the
		// version re-query returned, stamped with the read-model version it was
		// read at — the same number a resume cursor resolves against.
		_tag: "upsert",
		item: {
			_tag: "transcriptMessage",
			message: {
				id: "message-1",
				role: "assistant",
				parts: [
					{ id: "part-1", type: "text", text: 'Hello "world"\n雪' },
					{
						id: "part-2",
						type: "tool",
						text: "",
						callID: "call-1",
						tool: "Bash",
						state: {
							status: "completed",
							input: { command: "pwd", nested: { flag: true } },
							output: "/repo\n",
						},
					},
				],
				time: { created: 100, completed: 300 },
			},
		},
		sequence: 44,
	},
	{
		_tag: "upsert",
		item: {
			_tag: "event",
			event: {
				eventId: "event-1",
				sessionId: "session-1",
				type: "tool.started",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					toolName: "Read",
					callId: "call-1",
					input: { tool: "Read", filePath: "a.ts", offset: 1, limit: 20 },
				},
				metadata: { source: "provider", schemaVersion: 1 },
				provider: "claude",
				createdAt: 201,
				sequence: 41,
				streamVersion: 1,
			},
		},
		sequence: 41,
	},
	{
		_tag: "upsert",
		item: {
			_tag: "event",
			event: {
				eventId: "event-2",
				sessionId: "session-1",
				type: "tool.running",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					callId: "call-1",
					toolName: "Read",
					input: { tool: "Read", filePath: "b.ts" },
					metadata: { progress: 0.5 },
				},
				metadata: {},
				provider: "claude",
				createdAt: 202,
				sequence: 42,
				streamVersion: 2,
			},
		},
		sequence: 42,
	},
	{
		_tag: "upsert",
		item: {
			_tag: "event",
			event: {
				eventId: "event-3",
				sessionId: "session-1",
				type: "tool.completed",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					result: { content: "done", lines: [1, 2] },
					duration: 3,
					input: { tool: "Read", filePath: "b.ts" },
				},
				metadata: {},
				provider: "claude",
				createdAt: 203,
				sequence: 43,
				streamVersion: 3,
			},
		},
		sequence: 43,
	},
	{
		_tag: "upsert",
		item: {
			_tag: "event",
			event: {
				eventId: "event-4",
				sessionId: "session-1",
				type: "session.forked",
				data: {
					sessionId: "session-1",
					parentId: "parent-1",
					forkPointEvent: "parent-event-1",
					forkPointTimestamp: 90,
				},
				metadata: {},
				provider: "claude",
				createdAt: 204,
				sequence: 44,
				streamVersion: 4,
			},
		},
		sequence: 44,
	},
	{
		_tag: "upsert",
		item: {
			_tag: "event",
			event: {
				eventId: "event-5",
				sessionId: "session-1",
				type: "session.permission_mode_changed",
				data: {
					sessionId: "session-1",
					mode: "dontAsk",
				},
				metadata: {},
				provider: "claude",
				createdAt: 205,
				sequence: 45,
				streamVersion: 5,
			},
		},
		sequence: 45,
	},
	{ _tag: "remove", id: "message-1", sequence: 46 },
] as const;

const settings = {
	projectSlug: "project",
	overrides: {
		autoCompactEnabled: false,
		autoCompactWindow: 75,
		attribution: { commit: "雪", pr: null },
		extra: [true, 2, "text"],
	},
} as const;

const resolvedSettings = {
	projectSlug: "project",
	instanceId: "claude-1",
	resolved: {
		autoCompactEnabled: { value: false, source: "flag" },
		autoCompactWindow: {
			value: 75,
			source: "user",
			path: "/home/test/settings.json",
		},
		alwaysThinkingEnabled: {
			value: true,
			source: "project",
			path: "/repo/settings.json",
		},
		disableAllHooks: { value: false, source: "managed", policyOrigin: "plist" },
		cleanupPeriodDays: { value: 30, source: "local" },
		attribution: { value: { commit: "雪", pr: null }, source: "user" },
	},
} as const;

// session_list is still a legacy broadcast, not a shipped RPC. This test-only
// method carries its actual contract through the same JSON serialization seam.
const SessionListProbe = Rpc.make("SessionListProbe", {
	success: RelayMessageSchema,
});
const sessionList = {
	type: "session_list",
	sessions: [
		{
			...session,
			pendingQuestions: 2,
			pendingPermissions: 1,
			unseenActivity: true,
		},
		{ id: "minimal", title: "Minimal", status: "retry" },
	],
	roots: true,
	search: true,
} as const;

const group = RpcGroup.make(
	Contracts.SubscribeShell,
	Contracts.SubscribeSessionDetail,
	Rpc.fromTaggedRequest(Contracts.SetDefaultPermissionMode),
	Rpc.fromTaggedRequest(Contracts.GetClaudeSettings),
	Rpc.fromTaggedRequest(Contracts.SetClaudeSettings),
	Rpc.fromTaggedRequest(Contracts.ResolveClaudeSettings),
	Rpc.fromTaggedRequest(Contracts.RewindSession),
	SessionListProbe,
);
const handlers = group.toLayer({
	SessionListProbe: () => Effect.succeed(sessionList),
	RewindSession: (payload) => {
		expect(payload).toEqual({
			_tag: "RewindSession",
			projectSlug: "project",
			sessionId: "session-1",
			messageId: "provider-message-1",
		});
		return Effect.succeed({
			ok: true as const,
			sessionId: "session-1",
			messageId: "provider-message-1",
		});
	},
	ResolveClaudeSettings: (payload) => {
		expect(payload).toEqual({
			_tag: "ResolveClaudeSettings",
			projectSlug: "project",
			instanceId: "claude-1",
		});
		return Effect.succeed(resolvedSettings);
	},
	SetClaudeSettings: (payload) => {
		expect(payload).toEqual({
			_tag: "SetClaudeSettings",
			...settings,
			originId: "browser-1",
		});
		return Effect.succeed(settings);
	},
	GetClaudeSettings: (payload) => {
		expect(payload).toEqual({
			_tag: "GetClaudeSettings",
			projectSlug: "project",
		});
		return Effect.succeed(settings);
	},
	SetDefaultPermissionMode: (payload) => {
		expect(payload).toEqual({
			_tag: "SetDefaultPermissionMode",
			projectSlug: "project",
			mode: "dontAsk",
			originId: "browser-1",
		});
		return Effect.succeed({ projectSlug: "project", mode: "dontAsk" as const });
	},
	SubscribeSessionDetail: (payload) => {
		expect(payload).toEqual({
			projectSlug: "project",
			sessionId: "session-1",
			resumeFromSequence: 39,
		});
		return Rpc.fork(Stream.fromIterable(detailEnvelopes));
	},
	SubscribeShell: (payload) => {
		expect(payload).toEqual({ projectSlug: "project", resumeFromSequence: 39 });
		return Rpc.fork(
			Stream.fromIterable(shellEnvelopes).pipe(Stream.rechunk(1)),
		);
	},
});

const connect = Effect.gen(function* () {
	const connection = yield* makeFakeSocketServer;
	yield* RpcServer.make(group, { concurrency: 32 }).pipe(
		Effect.provide(RpcServer.layerProtocolSocketServer),
		Effect.provideService(SocketServer.SocketServer, connection.socketServer),
		Effect.provide(handlers),
		Effect.provide(RpcSerialization.layerJson),
		Effect.forkScoped,
	);
	const protocol = yield* Layer.build(
		RpcClient.layerProtocolSocket().pipe(
			Layer.provide(Layer.succeed(Socket.Socket, connection.clientSocket)),
			Layer.provide(RpcSerialization.layerJson),
		),
	);
	const client = yield* RpcClient.make(group).pipe(Effect.provide(protocol));
	return { client, ...connection };
});

describe("RPC serialization over a per-connection SocketServer", () => {
	it("SubscribeShell preserves session fields and all envelope variants through JSON", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { client, clientFrames, serverFrames } = yield* connect;
					const result = yield* Stream.runCollect(
						client.SubscribeShell({
							projectSlug: "project",
							resumeFromSequence: 39,
						}),
					);
					expect(Array.from(result)).toEqual(shellEnvelopes);
					expect(clientFrames.map((frame) => JSON.parse(frame))).toContainEqual(
						expect.objectContaining({
							_tag: "Request",
							tag: "SubscribeShell",
							payload: { projectSlug: "project", resumeFromSequence: 39 },
						}),
					);
					for (const envelope of shellEnvelopes) {
						expect(
							serverFrames.map((frame) => JSON.parse(frame)),
						).toContainEqual(
							expect.objectContaining({ _tag: "Chunk", values: [envelope] }),
						);
					}
				}),
			).pipe(Effect.timeout("3 seconds")),
		);
	});
});

it("SubscribeSessionDetail preserves transcript, model identity and stored tool and session events through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, serverFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribeSessionDetail({
						projectSlug: "project",
						sessionId: "session-1",
						resumeFromSequence: 39,
					}),
				);
				expect(
					Array.from(result).flatMap((envelope) =>
						envelope._tag === "upsert" && envelope.item._tag === "event"
							? [envelope.item.event.type]
							: [],
					),
				).toEqual([
					"tool.started",
					"tool.running",
					"tool.completed",
					"session.forked",
					"session.permission_mode_changed",
				]);
				// The delta variant detail actually produces now: a whole message,
				// with its tool part's open-ended `state` intact through JSON.
				const upserted = Array.from(result).flatMap((envelope) =>
					envelope._tag === "upsert" &&
					envelope.item._tag === "transcriptMessage"
						? [envelope.item.message]
						: [],
				);
				expect(upserted.map((message) => message.id)).toEqual(["message-1"]);
				expect(upserted[0]?.parts?.[1]?.state).toEqual({
					status: "completed",
					input: { command: "pwd", nested: { flag: true } },
					output: "/repo\n",
				});
				expect(Array.from(result)).toEqual(detailEnvelopes);
				expect(serverFrames.map((frame) => JSON.parse(frame))).toContainEqual(
					expect.objectContaining({ _tag: "Chunk", values: detailEnvelopes }),
				);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("SetDefaultPermissionMode preserves the new permission mode through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client } = yield* connect;
				expect(
					yield* client.SetDefaultPermissionMode({
						projectSlug: "project",
						mode: "dontAsk",
						originId: "browser-1",
					}),
				).toEqual({ projectSlug: "project", mode: "dontAsk" });
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("GetClaudeSettings preserves nested JSON overrides", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client } = yield* connect;
				expect(
					yield* client.GetClaudeSettings({ projectSlug: "project" }),
				).toEqual(settings);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("SetClaudeSettings round trips nested overrides in the request and response", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client } = yield* connect;
				expect(
					yield* client.SetClaudeSettings({
						...settings,
						originId: "browser-1",
					}),
				).toEqual(settings);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("ResolveClaudeSettings preserves display values and provenance", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client } = yield* connect;
				expect(
					yield* client.ResolveClaudeSettings({
						projectSlug: "project",
						instanceId: "claude-1",
					}),
				).toEqual(resolvedSettings);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("RewindSession preserves the changed response target identifiers", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client } = yield* connect;
				expect(
					yield* client.RewindSession({
						projectSlug: "project",
						sessionId: "session-1",
						messageId: "provider-message-1",
					}),
				).toEqual({
					ok: true,
					sessionId: "session-1",
					messageId: "provider-message-1",
				});
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("session_list keeps notification state and required status on sessions", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client } = yield* connect;
				expect(yield* client.SessionListProbe()).toEqual(sessionList);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});
