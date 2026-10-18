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
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Contracts from "../../../src/lib/contracts/ws-rpc.js";
import { PermissionId } from "../../../src/lib/shared-types.js";
import { makeFakeSocketServer } from "../../helpers/fake-socket-server.js";

const session = {
	projectSlug: "project",
	accountId: null,
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
				_tag: "message",
				message: {
					id: "message-1",
					role: "assistant",
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
			{
				_tag: "part",
				messageId: "message-1",
				sortOrder: 0,
				part: { id: "part-1", type: "text", text: 'Hello "world"\n雪' },
			},
		],
		sequence: 40,
	},
	{ _tag: "synchronized" },
	{
		// A live change carries only the rows that moved: here the message's
		// completion and its new tool part, not the unchanged text part.
		_tag: "upsert",
		item: {
			_tag: "message",
			message: {
				id: "message-1",
				role: "assistant",
				time: { created: 100, completed: 300 },
			},
		},
		sequence: 44,
	},
	{
		_tag: "upsert",
		item: {
			_tag: "part",
			messageId: "message-1",
			sortOrder: 1,
			part: {
				id: "part-2",
				type: "tool",
				text: "",
				callID: "call-1",
				tool: "Bash",
				state: {
					status: "completed",
					input: {
						_tag: "whole" as const,
						value: { command: "pwd", nested: { flag: true } },
					},
					output: { _tag: "whole" as const, text: "/repo\n" },
				},
			},
		},
		sequence: 44,
	},
	{ _tag: "remove", id: '["message-1","part-2"]', sequence: 45 },
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
			{
				_tag: "opencodeConnection",
				instanceId: "opencode",
				status: "reconnecting",
			},
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
);
const handlers = group.toLayer({
	SubscribeApprovals: (payload) => {
		expect(payload).toEqual({ projectSlug: "project", resumeFromSequence: 39 });
		return Rpc.fork(
			Stream.fromIterable(approvalEnvelopes).pipe(Stream.rechunk(1)),
		);
	},
	RewindSession: (payload) => {
		expect(payload).toEqual({
			_tag: "RewindSession",

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
			accountRef: { _tag: "Id", id: "claude-1" },
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
			sessionId: "session-1",
			resumeFromSequence: 39,
		});
		return Rpc.fork(Stream.fromIterable(detailEnvelopes));
	},
	SubscribeSessionTodos: (payload) => {
		expect(payload).toEqual({
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
		expect(payload).toEqual({ resumeFromSequence: 39 });
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
						client.SubscribeShell({ resumeFromSequence: 39 }),
					);
					expect(Array.from(result)).toEqual(shellEnvelopes);
					expect(clientFrames.map((frame) => JSON.parse(frame))).toContainEqual(
						expect.objectContaining({
							_tag: "Request",
							tag: "SubscribeShell",
							payload: { resumeFromSequence: 39 },
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

it("SubscribeSessionDetail preserves message and part rows, model identity and part removals through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, serverFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribeSessionDetail({
						sessionId: "session-1",
						resumeFromSequence: 39,
					}),
				);
				// A tool part's open-ended `state` survives JSON intact.
				const parts = Array.from(result).flatMap((envelope) =>
					envelope._tag === "upsert" && envelope.item._tag === "part"
						? [envelope.item.part]
						: [],
				);
				expect(parts.map((part) => part.id)).toEqual(["part-2"]);
				expect(parts[0]?.state).toEqual({
					status: "completed",
					input: {
						_tag: "whole",
						value: { command: "pwd", nested: { flag: true } },
					},
					output: { _tag: "whole", text: "/repo\n" },
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
	// A supplied Id must win over a stale wire field. These explicit-account
	// requests cannot represent a driver default without changing its meaning.
	const requests = [
		new Contracts.ResolveClaudeSettings({
			projectSlug: "project",
			instanceId: "stale-account",
			accountRef: { _tag: "Id", id: "claude-1" },
		}),
		new Contracts.ContinueSession({
			sessionId: "session-1",
			instanceId: "stale-account",
			expectedInstanceId: "source-account",
			accountRef: { _tag: "Id", id: "claude-1" },
		}),
		new Contracts.PreviewContinuation({
			sessionId: "session-1",
			instanceId: "stale-account",
			accountRef: { _tag: "Id", id: "claude-1" },
		}),
	];
	const wireRequests = requests.map((request) =>
		Schema.encodeSync(Contracts.WsRpcRequest)(request),
	);
	expect(
		wireRequests.map((request) =>
			"instanceId" in request ? request.instanceId : undefined,
		),
	).toEqual(["claude-1", "claude-1", "claude-1"]);
	for (const request of requests) {
		expect(() =>
			Schema.encodeSync(Contracts.WsRpcRequest)({
				...request,
				accountRef: { _tag: "DriverDefault", driver: "claude" },
			}),
		).toThrow(/requires an explicit account Id/);
	}
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, clientFrames } = yield* connect;
				expect(
					yield* client.ResolveClaudeSettings({
						projectSlug: "project",
						instanceId: "stale-account",
						accountRef: { _tag: "Id", id: "claude-1" },
					}),
				).toEqual(resolvedSettings);
				expect(clientFrames.map((frame) => JSON.parse(frame))).toContainEqual(
					expect.objectContaining({
						_tag: "Request",
						tag: "ResolveClaudeSettings",
						payload: {
							_tag: "ResolveClaudeSettings",
							projectSlug: "project",
							instanceId: "claude-1",
						},
					}),
				);
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

it("SubscribeSessionTodos preserves the session id and todo items through JSON", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const { client, clientFrames } = yield* connect;
				const result = yield* Stream.runCollect(
					client.SubscribeSessionTodos({
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
