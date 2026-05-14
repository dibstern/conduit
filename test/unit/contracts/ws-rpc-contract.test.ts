import { type Rpc, RpcClient, type RpcGroup, RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Schema, type Scope } from "effect";
import { expect } from "vitest";
import {
	CancelSession,
	GetAgents,
	GetCommands,
	GetFileContent,
	GetFileList,
	GetFileTree,
	GetModels,
	GetProjects,
	GetTodo,
	GetToolContent,
	ListDirectories,
	ListSessions,
	LoadMoreHistory,
	ReloadProviderSession,
	RenameSession,
	SendMessage,
	SetDefaultModel,
	SwitchAgent,
	SwitchContextWindow,
	SwitchModel,
	SwitchVariant,
	WsRpcError,
	WsRpcGroup,
	WsRpcRequest,
} from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcGroup as FrontendWsRpcGroup } from "../../../src/lib/frontend/transport/ws-rpc.js";
import { WsRpcGroup as ServerWsRpcGroup } from "../../../src/lib/server/ws-rpc.js";

type WsRpcTestEnv =
	| Scope.Scope
	| Rpc.ToHandler<RpcGroup.Rpcs<typeof WsRpcGroup>>;

const provideRpc = <A, E>(effect: Effect.Effect<A, E, WsRpcTestEnv>) =>
	Effect.scoped(effect).pipe(
		Effect.provide(
			WsRpcGroup.toLayer({
				GetModels: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						providers: [
							{
								id: "opencode",
								name: "OpenCode",
								configured: true,
								models: [
									{
										id: "gpt-4",
										name: "GPT-4",
										provider: "opencode",
									},
								],
							},
						],
						active: {
							model: "gpt-4",
							provider: "opencode",
						},
						variant: {
							variant: "default",
							variants: ["default"],
						},
						contextWindow: {
							contextWindow: "default",
							options: [{ value: "default", label: "Default" }],
						},
					}),
				GetAgents: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						agents: [{ id: "build", name: "Build" }],
						...(request.sessionId ? { activeAgentId: "build" } : {}),
					}),
				GetCommands: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						commands: [{ name: "init", description: "Initialize" }],
					}),
				GetProjects: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						projects: [
							{
								slug: "demo",
								title: "Demo",
								directory: "/tmp/demo",
							},
						],
						current: "demo",
					}),
				ListDirectories: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						path: request.path,
						entries: ["/tmp/demo/"],
					}),
				SwitchAgent: () => Effect.succeed({ ok: true as const }),
				SwitchContextWindow: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						contextWindow: request.contextWindow,
						options: [{ value: "1m", label: "1M" }],
					}),
				SwitchModel: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						model: request.modelId,
						provider: request.providerId,
						variant: "fast",
						variants: ["standard", "fast"],
					}),
				SetDefaultModel: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						model: request.model,
						provider: request.provider,
						variant: "",
						variants: [],
					}),
				ReloadProviderSession: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						sessionId: request.sessionId,
					}),
				RenameSession: () => Effect.succeed({ ok: true as const }),
				SwitchVariant: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						variant: request.variant,
						variants: ["low", "medium", "high", "max"],
					}),
				GetTodo: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						items: [],
					}),
				GetFileTree: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						entries: ["src/", "src/index.ts", "README.md"],
					}),
				GetFileList: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						path: request.path ?? ".",
						entries: [{ name: "src", type: "directory" as const }],
					}),
				GetFileContent: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						path: request.path,
						content: "file contents",
					}),
				GetToolContent: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						toolId: request.toolId,
						content: "full output",
					}),
				ListSessions: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						sessions: [{ id: "session-1", title: "Session 1" }],
						roots: request.roots ?? false,
					}),
				LoadMoreHistory: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						sessionId: request.sessionId,
						messages: [
							{
								id: "message-1",
								role: "user" as const,
								parts: [{ id: "part-1", type: "text", text: "hello" }],
							},
						],
						hasMore: false,
					}),
				SendMessage: () => Effect.succeed({ ok: true as const }),
				CancelSession: () => Effect.succeed({ ok: true as const }),
			}),
		),
	);

describe("browser WebSocket RPC contract", () => {
	it("exports one shared WsRpcGroup for frontend and server", () => {
		expect(FrontendWsRpcGroup).toBe(WsRpcGroup);
		expect(ServerWsRpcGroup).toBe(WsRpcGroup);
		expect(WsRpcGroup.requests.has("GetModels")).toBe(true);
		expect(WsRpcGroup.requests.has("GetAgents")).toBe(true);
		expect(WsRpcGroup.requests.has("GetCommands")).toBe(true);
		expect(WsRpcGroup.requests.has("GetProjects")).toBe(true);
		expect(WsRpcGroup.requests.has("ListDirectories")).toBe(true);
		expect(WsRpcGroup.requests.has("GetTodo")).toBe(true);
		expect(WsRpcGroup.requests.has("SwitchAgent")).toBe(true);
		expect(WsRpcGroup.requests.has("SwitchContextWindow")).toBe(true);
		expect(WsRpcGroup.requests.has("SwitchModel")).toBe(true);
		expect(WsRpcGroup.requests.has("SetDefaultModel")).toBe(true);
		expect(WsRpcGroup.requests.has("ReloadProviderSession")).toBe(true);
		expect(WsRpcGroup.requests.has("RenameSession")).toBe(true);
		expect(WsRpcGroup.requests.has("SwitchVariant")).toBe(true);
		expect(WsRpcGroup.requests.has("GetFileTree")).toBe(true);
		expect(WsRpcGroup.requests.has("GetFileList")).toBe(true);
		expect(WsRpcGroup.requests.has("GetFileContent")).toBe(true);
		expect(WsRpcGroup.requests.has("GetToolContent")).toBe(true);
		expect(WsRpcGroup.requests.has("ListSessions")).toBe(true);
		expect(WsRpcGroup.requests.has("LoadMoreHistory")).toBe(true);
		expect(WsRpcGroup.requests.has("SendMessage")).toBe(true);
		expect(WsRpcGroup.requests.has("CancelSession")).toBe(true);
		expect(typeof RpcClient.make).toBe("function");
	});

	it.effect("handles GetModels through the real @effect/rpc test client", () =>
		provideRpc(
			Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.GetModels({
					projectSlug: "demo",
					sessionId: "session-1",
				});

				expect(result.projectSlug).toBe("demo");
				expect(result.providers[0]?.models[0]?.id).toBe("gpt-4");
				expect(result.active).toEqual({
					model: "gpt-4",
					provider: "opencode",
				});

				const agents = yield* client.GetAgents({
					projectSlug: "demo",
					sessionId: "session-1",
				});
				expect(agents).toEqual({
					projectSlug: "demo",
					agents: [{ id: "build", name: "Build" }],
					activeAgentId: "build",
				});

				const commands = yield* client.GetCommands({ projectSlug: "demo" });
				expect(commands).toEqual({
					projectSlug: "demo",
					commands: [{ name: "init", description: "Initialize" }],
				});

				const projects = yield* client.GetProjects({ projectSlug: "demo" });
				expect(projects).toEqual({
					projectSlug: "demo",
					projects: [
						{
							slug: "demo",
							title: "Demo",
							directory: "/tmp/demo",
						},
					],
					current: "demo",
				});

				const directories = yield* client.ListDirectories({
					projectSlug: "demo",
					path: "/tmp/",
				});
				expect(directories).toEqual({
					projectSlug: "demo",
					path: "/tmp/",
					entries: ["/tmp/demo/"],
				});

				const todo = yield* client.GetTodo({ projectSlug: "demo" });
				expect(todo).toEqual({
					projectSlug: "demo",
					items: [],
				});

				expect(
					yield* client.SwitchAgent({
						projectSlug: "demo",
						sessionId: "session-1",
						agentId: "plan",
					}),
				).toEqual({ ok: true });

				const contextWindow = yield* client.SwitchContextWindow({
					projectSlug: "demo",
					sessionId: "session-1",
					contextWindow: "1m",
				});
				expect(contextWindow).toEqual({
					projectSlug: "demo",
					contextWindow: "1m",
					options: [{ value: "1m", label: "1M" }],
				});

				const model = yield* client.SwitchModel({
					projectSlug: "demo",
					sessionId: "session-1",
					modelId: "gpt-4",
					providerId: "opencode",
				});
				expect(model).toEqual({
					projectSlug: "demo",
					model: "gpt-4",
					provider: "opencode",
					variant: "fast",
					variants: ["standard", "fast"],
				});

				const defaultModel = yield* client.SetDefaultModel({
					projectSlug: "demo",
					model: "gpt-4",
					provider: "opencode",
				});
				expect(defaultModel).toEqual({
					projectSlug: "demo",
					model: "gpt-4",
					provider: "opencode",
					variant: "",
					variants: [],
				});

				const reload = yield* client.ReloadProviderSession({
					projectSlug: "demo",
					sessionId: "session-1",
				});
				expect(reload).toEqual({
					projectSlug: "demo",
					sessionId: "session-1",
				});

				expect(
					yield* client.RenameSession({
						projectSlug: "demo",
						sessionId: "session-1",
						title: "Renamed",
					}),
				).toEqual({ ok: true });

				const variant = yield* client.SwitchVariant({
					projectSlug: "demo",
					sessionId: "session-1",
					variant: "high",
				});
				expect(variant).toEqual({
					projectSlug: "demo",
					variant: "high",
					variants: ["low", "medium", "high", "max"],
				});

				const fileTree = yield* client.GetFileTree({ projectSlug: "demo" });
				expect(fileTree).toEqual({
					projectSlug: "demo",
					entries: ["src/", "src/index.ts", "README.md"],
				});

				const fileList = yield* client.GetFileList({
					projectSlug: "demo",
					path: ".",
				});
				expect(fileList).toEqual({
					projectSlug: "demo",
					path: ".",
					entries: [{ name: "src", type: "directory" }],
				});

				const fileContent = yield* client.GetFileContent({
					projectSlug: "demo",
					path: "README.md",
				});
				expect(fileContent).toEqual({
					projectSlug: "demo",
					path: "README.md",
					content: "file contents",
				});

				const toolContent = yield* client.GetToolContent({
					projectSlug: "demo",
					toolId: "tool-1",
				});
				expect(toolContent).toEqual({
					projectSlug: "demo",
					toolId: "tool-1",
					content: "full output",
				});

				const sessions = yield* client.ListSessions({ projectSlug: "demo" });
				expect(sessions.sessions).toEqual([
					{ id: "session-1", title: "Session 1" },
				]);

				const history = yield* client.LoadMoreHistory({
					projectSlug: "demo",
					sessionId: "session-1",
					offset: 50,
				});
				expect(history).toEqual({
					projectSlug: "demo",
					sessionId: "session-1",
					messages: [
						{
							id: "message-1",
							role: "user",
							parts: [{ id: "part-1", type: "text", text: "hello" }],
						},
					],
					hasMore: false,
				});

				expect(
					yield* client.SendMessage({
						projectSlug: "demo",
						sessionId: "session-1",
						text: "hello",
					}),
				).toEqual({ ok: true });
			}),
		),
	);

	it("constructs contract request and typed error classes", () => {
		expect(new GetAgents({ projectSlug: "demo" })._tag).toBe("GetAgents");
		expect(new GetCommands({ projectSlug: "demo" })._tag).toBe("GetCommands");
		expect(new GetProjects({ projectSlug: "demo" })._tag).toBe("GetProjects");
		expect(
			new ListDirectories({ projectSlug: "demo", path: "/tmp/" })._tag,
		).toBe("ListDirectories");
		expect(new GetTodo({ projectSlug: "demo" })._tag).toBe("GetTodo");
		expect(
			new SwitchAgent({
				projectSlug: "demo",
				sessionId: "session-1",
				agentId: "plan",
			})._tag,
		).toBe("SwitchAgent");
		expect(
			new SwitchContextWindow({
				projectSlug: "demo",
				sessionId: "session-1",
				contextWindow: "1m",
			})._tag,
		).toBe("SwitchContextWindow");
		expect(
			new SwitchModel({
				projectSlug: "demo",
				sessionId: "session-1",
				modelId: "gpt-4",
				providerId: "opencode",
			})._tag,
		).toBe("SwitchModel");
		expect(
			new SetDefaultModel({
				projectSlug: "demo",
				model: "gpt-4",
				provider: "opencode",
			})._tag,
		).toBe("SetDefaultModel");
		expect(
			new ReloadProviderSession({
				projectSlug: "demo",
				sessionId: "session-1",
			})._tag,
		).toBe("ReloadProviderSession");
		expect(
			new RenameSession({
				projectSlug: "demo",
				sessionId: "session-1",
				title: "Renamed",
			})._tag,
		).toBe("RenameSession");
		expect(
			new SwitchVariant({
				projectSlug: "demo",
				sessionId: "session-1",
				variant: "high",
			})._tag,
		).toBe("SwitchVariant");
		expect(new GetFileTree({ projectSlug: "demo" })._tag).toBe("GetFileTree");
		expect(new GetFileList({ projectSlug: "demo" })._tag).toBe("GetFileList");
		expect(
			new GetFileContent({ projectSlug: "demo", path: "README.md" })._tag,
		).toBe("GetFileContent");
		expect(
			new GetToolContent({ projectSlug: "demo", toolId: "tool-1" })._tag,
		).toBe("GetToolContent");
		expect(new GetModels({ projectSlug: "demo" })._tag).toBe("GetModels");
		expect(new ListSessions({ projectSlug: "demo" })._tag).toBe("ListSessions");
		expect(
			new LoadMoreHistory({
				projectSlug: "demo",
				sessionId: "session-1",
				offset: 50,
			})._tag,
		).toBe("LoadMoreHistory");
		expect(
			new SendMessage({
				projectSlug: "demo",
				sessionId: "session-1",
				text: "hello",
			})._tag,
		).toBe("SendMessage");
		expect(
			new CancelSession({ projectSlug: "demo", sessionId: "session-1" })._tag,
		).toBe("CancelSession");
		expect(new WsRpcError({ message: "bad" })._tag).toBe("WsRpcError");
	});

	it("rejects unknown browser RPC tags at the contract boundary", () => {
		const decoded = Schema.decodeUnknownEither(WsRpcRequest)({
			_tag: "UnknownBrowserRequest",
			projectSlug: "demo",
		});

		expect(decoded._tag).toBe("Left");
	});
});
