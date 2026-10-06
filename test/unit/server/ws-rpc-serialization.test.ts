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
import {
	PermissionId,
	RelayMessageSchema,
} from "../../../src/lib/shared-types.js";
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
	permissionMode: "plan",
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
			pendingQuestionCount: 2,
			pendingPermissionCount: 1,
			unread: true,
			attention: "needs-approval",
		},
		{ id: "minimal", title: "Minimal", status: "retry" },
	],
	roots: true,
	search: true,
} as const;

const todoEnvelopes = [
	{
		_tag: "snapshot",
		rows: [{ sessionId: "session-1", items: [] }],
		sequence: 7,
	},
	{ _tag: "synchronized" },
	{
		_tag: "upsert",
		item: {
			sessionId: "session-1",
			items: [
				{ id: "t1", subject: "Plan", status: "completed" },
				{
					id: "t2",
					subject: "Build",
					description: "the subscription",
					status: "in_progress",
				},
			],
		},
		sequence: 8,
	},
] as const;

const ptyRow = {
	id: "pty-1",
	title: "Shell",
	command: "zsh",
	cwd: "/repo",
	status: "running",
	pid: 42,
} as const;
const ptyEnvelopes = [
	{
		_tag: "snapshot",
		rows: [{ pty: ptyRow, scrollback: '\u001b[1m$ echo "雪"\r\n' }],
	},
	{ _tag: "synchronized" },
	{ _tag: "output", ptyId: "pty-1", data: "\u0007\u001b]0;title\u0007ok\r\n" },
	{ _tag: "output", ptyId: "pty-1", data: "fresh", replace: true },
	{ _tag: "upsert", item: { ...ptyRow, status: "exited" } },
	{ _tag: "remove", id: "pty-1" },
] as const;

// Every optional field set, so a field the schema forgot is stripped and fails
// the equality below rather than vanishing silently.
const approvalEnvelopes = [
	{
		_tag: "snapshot",
		sequence: 40,
		rows: [
			{
				_tag: "question",
				sessionId: "session-1",
				toolId: "que-1",
				toolUseId: "call-1",
				providerId: "opencode",
				questions: [
					{
						question: 'Pick "one"\n雪',
						header: "Choice",
						options: [{ label: "A", description: "first" }, { label: "B" }],
						multiSelect: true,
						custom: false,
					},
				],
			},
		],
	},
	{ _tag: "synchronized" },
	{
		_tag: "upsert",
		sequence: 41,
		item: {
			_tag: "permission",
			sessionId: "child-1",
			requestId: PermissionId.make("perm-1"),
			toolName: "Bash",
			toolInput: { command: "rm -rf build", nested: { flag: true } },
			toolUseId: "toolu-1",
			always: ["rm *"],
			permissionSuggestions: [
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
					behavior: "allow",
					destination: "localSettings",
				},
			],
			permissionTitle: "Claude wants to run rm",
			permissionDisplayName: "Run rm",
			permissionDescription: "Deletes the build directory",
			permissionReason: "Cleanup",
		},
	},
	{ _tag: "remove", sequence: 42, id: "perm-1" },
] as const;

const projectSettingsEnvelopes = [
	{
		_tag: "snapshot",
		rows: [
			{
				_tag: "defaultModel",
				model: "claude-sonnet-4",
				provider: "anthropic",
				variant: "high",
			},
			{
				_tag: "visibility",
				hiddenModels: ["anthropic/claude-haiku"],
				hiddenAgents: [],
			},
			{ _tag: "defaultPermissionMode", mode: "acceptEdits" },
			{
				_tag: "claudeSettings",
				overrides: { model: "opus", env: { FOO: 'b"ar' } },
			},
			{ _tag: "clientCount", count: 2 },
			{ _tag: "opencodeConnection", status: "reconnecting" },
		],
		sequence: 1,
	},
	{ _tag: "synchronized" },
	{
		_tag: "upsert",
		item: { _tag: "defaultModel", variant: "" },
		sequence: 2,
	},
] as const;

const group = RpcGroup.make(
	Contracts.SubscribeShell,
	Contracts.SubscribeApprovals,
	Contracts.SubscribeSessionDetail,
	Contracts.SubscribeSessionTodos,
	Contracts.SubscribeProjectSettings,
	Contracts.SubscribePtys,
	Rpc.fromTaggedRequest(Contracts.PtyInput),
	Rpc.fromTaggedRequest(Contracts.SetDefaultPermissionMode),
	Rpc.fromTaggedRequest(Contracts.GetClaudeSettings),
	Rpc.fromTaggedRequest(Contracts.SetClaudeSettings),
	Rpc.fromTaggedRequest(Contracts.ResolveClaudeSettings),
	Rpc.fromTaggedRequest(Contracts.RewindSession),
	SessionListProbe,
);
const handlers = group.toLayer({
	SubscribeApprovals: (payload) => {
		expect(payload).toEqual({ projectSlug: "project", resumeFromSequence: 39 });
		return Rpc.fork(
			Stream.fromIterable(approvalEnvelopes).pipe(Stream.rechunk(1)),
		);
	},
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
	SubscribeSessionTodos: (payload) => {
		expect(payload).toEqual({
			projectSlug: "project",
			sessionId: "session-1",
			resumeFromSequence: 7,
		});
		return Rpc.fork(Stream.fromIterable(todoEnvelopes));
	},
	SubscribePtys: (payload) => {
		expect(payload).toEqual({ projectSlug: "project" });
		return Rpc.fork(Stream.fromIterable(ptyEnvelopes));
	},
	PtyInput: (payload) => {
		expect(payload).toEqual({
			_tag: "PtyInput",
			projectSlug: "project",
			ptyId: "pty-1",
			data: "\u0003ls -la 雪\r",
		});
		return Effect.succeed({ ok: true as const });
	},
	SubscribeProjectSettings: (payload) => {
		expect(payload).toEqual({ projectSlug: "project" });
		return Rpc.fork(Stream.fromIterable(projectSettingsEnvelopes));
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

it("SubscribeApprovals preserves both approval kinds and every envelope variant through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, serverFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribeApprovals({
						projectSlug: "project",
						resumeFromSequence: 39,
					}),
				);
				expect(Array.from(result)).toEqual(approvalEnvelopes);
				for (const envelope of approvalEnvelopes) {
					expect(serverFrames.map((frame) => JSON.parse(frame))).toContainEqual(
						expect.objectContaining({ _tag: "Chunk", values: [envelope] }),
					);
				}
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

it("SubscribeSessionTodos preserves the session id and todo items through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, clientFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribeSessionTodos({
						projectSlug: "project",
						sessionId: "session-1",
						resumeFromSequence: 7,
					}),
				);
				expect(Array.from(result)).toEqual(todoEnvelopes);
				expect(clientFrames.map((frame) => JSON.parse(frame))).toContainEqual(
					expect.objectContaining({
						_tag: "Request",
						tag: "SubscribeSessionTodos",
						payload: {
							projectSlug: "project",
							sessionId: "session-1",
							resumeFromSequence: 7,
						},
					}),
				);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("SubscribePtys and PtyInput carry terminal bytes through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, clientFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribePtys({ projectSlug: "project" }),
				);
				expect(Array.from(result)).toEqual(ptyEnvelopes);
				expect(
					yield* client.PtyInput({
						projectSlug: "project",
						ptyId: "pty-1",
						data: "\u0003ls -la 雪\r",
					}),
				).toEqual({ ok: true });
				expect(clientFrames.map((frame) => JSON.parse(frame))).toContainEqual(
					expect.objectContaining({
						_tag: "Request",
						tag: "PtyInput",
						payload: {
							_tag: "PtyInput",
							projectSlug: "project",
							ptyId: "pty-1",
							data: "\u0003ls -la 雪\r",
						},
					}),
				);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});

it("SubscribeProjectSettings preserves every project-setting fact through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, clientFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribeProjectSettings({ projectSlug: "project" }),
				);
				expect(Array.from(result)).toEqual(projectSettingsEnvelopes);
				expect(clientFrames.map((frame) => JSON.parse(frame))).toContainEqual(
					expect.objectContaining({
						_tag: "Request",
						tag: "SubscribeProjectSettings",
						payload: { projectSlug: "project" },
					}),
				);
			}),
		).pipe(Effect.timeout("3 seconds")),
	);
});
