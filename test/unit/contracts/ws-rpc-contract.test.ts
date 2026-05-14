import { type Rpc, RpcClient, type RpcGroup, RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Schema, type Scope } from "effect";
import { expect } from "vitest";
import {
	AddProject,
	AnswerQuestion,
	CancelSession,
	ClosePty,
	CreatePty,
	CreateSession,
	DeleteSession,
	DetectProxy,
	ForkSession,
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
	ListPtys,
	ListSessions,
	LoadMoreHistory,
	RejectQuestion,
	ReloadProviderSession,
	RemoveInstance,
	RemoveProject,
	RenameInstance,
	RenameProject,
	RenameSession,
	ResizePty,
	RespondPermission,
	RewindSession,
	ScanNow,
	SendMessage,
	SetDefaultModel,
	SetLogLevel,
	SetProjectInstance,
	StartInstance,
	StopInstance,
	SwitchAgent,
	SwitchContextWindow,
	SwitchModel,
	SwitchVariant,
	SyncInputDraft,
	ViewSession,
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
				AddProject: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						projects: [
							{
								slug: "new-project",
								title: "New Project",
								directory: request.directory,
							},
						],
						current: "demo",
						addedSlug: "new-project",
					}),
				RemoveProject: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						projects: [],
						current: "demo",
					}),
				RenameProject: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						projects: [
							{
								slug: request.slug,
								title: request.title,
								directory: "/tmp/demo",
							},
						],
						current: "demo",
					}),
				SetProjectInstance: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						projects: [
							{
								slug: request.slug,
								title: "Demo",
								directory: "/tmp/demo",
								instanceId: request.instanceId,
							},
						],
						current: "demo",
					}),
				StartInstance: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						instances: [
							{
								id: request.instanceId,
								name: "Default",
								port: 4096,
								managed: true,
								status: "healthy" as const,
								restartCount: 0,
								createdAt: 1,
							},
						],
					}),
				StopInstance: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						instances: [
							{
								id: request.instanceId,
								name: "Default",
								port: 4096,
								managed: true,
								status: "stopped" as const,
								restartCount: 0,
								createdAt: 1,
							},
						],
					}),
				RemoveInstance: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						instances: [],
					}),
				RenameInstance: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						instances: [
							{
								id: request.instanceId,
								name: request.name,
								port: 4096,
								managed: true,
								status: "healthy" as const,
								restartCount: 0,
								createdAt: 1,
							},
						],
					}),
				ScanNow: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						discovered: [4097],
						lost: [],
						active: [4096, 4097],
					}),
				DetectProxy: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						found: true,
						port: 8317,
					}),
				ListPtys: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						ptys: [
							{
								id: "pty-1",
								title: "Shell",
								command: "zsh",
								cwd: "/tmp/demo",
								status: "running" as const,
								pid: 123,
							},
						],
					}),
				CreatePty: () => Effect.succeed({ ok: true as const }),
				ResizePty: () => Effect.succeed({ ok: true as const }),
				ClosePty: () => Effect.succeed({ ok: true as const }),
				CreateSession: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						sessionId: "session-new",
					}),
				ViewSession: () => Effect.succeed({ ok: true as const }),
				DeleteSession: () => Effect.succeed({ ok: true as const }),
				ForkSession: (request) =>
					Effect.succeed({
						projectSlug: request.projectSlug,
						sessionId: "session-forked",
					}),
				RespondPermission: () => Effect.succeed({ ok: true as const }),
				AnswerQuestion: () => Effect.succeed({ ok: true as const }),
				RejectQuestion: () => Effect.succeed({ ok: true as const }),
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
				RewindSession: () => Effect.succeed({ ok: true as const }),
				SendMessage: () => Effect.succeed({ ok: true as const }),
				SyncInputDraft: () => Effect.succeed({ ok: true as const }),
				CancelSession: () => Effect.succeed({ ok: true as const }),
				SetLogLevel: () => Effect.succeed({ ok: true as const }),
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
		expect(WsRpcGroup.requests.has("AddProject")).toBe(true);
		expect(WsRpcGroup.requests.has("RemoveProject")).toBe(true);
		expect(WsRpcGroup.requests.has("RenameProject")).toBe(true);
		expect(WsRpcGroup.requests.has("SetProjectInstance")).toBe(true);
		expect(WsRpcGroup.requests.has("StartInstance")).toBe(true);
		expect(WsRpcGroup.requests.has("StopInstance")).toBe(true);
		expect(WsRpcGroup.requests.has("RemoveInstance")).toBe(true);
		expect(WsRpcGroup.requests.has("RenameInstance")).toBe(true);
		expect(WsRpcGroup.requests.has("ScanNow")).toBe(true);
		expect(WsRpcGroup.requests.has("DetectProxy")).toBe(true);
		expect(WsRpcGroup.requests.has("ListPtys")).toBe(true);
		expect(WsRpcGroup.requests.has("CreatePty")).toBe(true);
		expect(WsRpcGroup.requests.has("ResizePty")).toBe(true);
		expect(WsRpcGroup.requests.has("ClosePty")).toBe(true);
		expect(WsRpcGroup.requests.has("CreateSession")).toBe(true);
		expect(WsRpcGroup.requests.has("ViewSession")).toBe(true);
		expect(WsRpcGroup.requests.has("DeleteSession")).toBe(true);
		expect(WsRpcGroup.requests.has("ForkSession")).toBe(true);
		expect(WsRpcGroup.requests.has("RespondPermission")).toBe(true);
		expect(WsRpcGroup.requests.has("AnswerQuestion")).toBe(true);
		expect(WsRpcGroup.requests.has("RejectQuestion")).toBe(true);
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
		expect(WsRpcGroup.requests.has("RewindSession")).toBe(true);
		expect(WsRpcGroup.requests.has("SendMessage")).toBe(true);
		expect(WsRpcGroup.requests.has("SyncInputDraft")).toBe(true);
		expect(WsRpcGroup.requests.has("CancelSession")).toBe(true);
		expect(WsRpcGroup.requests.has("SetLogLevel")).toBe(true);
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

				const addedProject = yield* client.AddProject({
					projectSlug: "demo",
					directory: "/tmp/new-project",
					instanceId: "inst-1",
				});
				expect(addedProject.addedSlug).toBe("new-project");
				expect(addedProject.projects[0]?.directory).toBe("/tmp/new-project");

				expect(
					yield* client.RemoveProject({
						projectSlug: "demo",
						slug: "old-project",
					}),
				).toEqual({
					projectSlug: "demo",
					projects: [],
					current: "demo",
				});

				const renamedProject = yield* client.RenameProject({
					projectSlug: "demo",
					slug: "demo",
					title: "Renamed Demo",
				});
				expect(renamedProject.projects[0]?.title).toBe("Renamed Demo");

				const reboundProject = yield* client.SetProjectInstance({
					projectSlug: "demo",
					slug: "demo",
					instanceId: "inst-2",
				});
				expect(reboundProject.projects[0]?.instanceId).toBe("inst-2");

				const startedInstance = yield* client.StartInstance({
					projectSlug: "demo",
					instanceId: "inst-1",
				});
				expect(startedInstance.instances[0]?.status).toBe("healthy");

				const stoppedInstance = yield* client.StopInstance({
					projectSlug: "demo",
					instanceId: "inst-1",
				});
				expect(stoppedInstance.instances[0]?.status).toBe("stopped");

				expect(
					yield* client.RemoveInstance({
						projectSlug: "demo",
						instanceId: "inst-1",
					}),
				).toEqual({ projectSlug: "demo", instances: [] });

				const renamedInstance = yield* client.RenameInstance({
					projectSlug: "demo",
					instanceId: "inst-1",
					name: "Primary",
				});
				expect(renamedInstance.instances[0]?.name).toBe("Primary");

				expect(yield* client.ScanNow({ projectSlug: "demo" })).toEqual({
					projectSlug: "demo",
					discovered: [4097],
					lost: [],
					active: [4096, 4097],
				});

				expect(yield* client.DetectProxy({ projectSlug: "demo" })).toEqual({
					projectSlug: "demo",
					found: true,
					port: 8317,
				});

				expect(
					yield* client.ListPtys({
						projectSlug: "demo",
						originId: "browser-tab-a",
					}),
				).toEqual({
					projectSlug: "demo",
					ptys: [
						{
							id: "pty-1",
							title: "Shell",
							command: "zsh",
							cwd: "/tmp/demo",
							status: "running",
							pid: 123,
						},
					],
				});

				expect(
					yield* client.CreatePty({
						projectSlug: "demo",
						originId: "browser-tab-a",
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.ResizePty({
						projectSlug: "demo",
						originId: "browser-tab-a",
						ptyId: "pty-1",
						cols: 120,
						rows: 40,
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.ClosePty({
						projectSlug: "demo",
						ptyId: "pty-1",
					}),
				).toEqual({ ok: true });

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

				const created = yield* client.CreateSession({
					projectSlug: "demo",
					originId: "browser-tab-a",
					requestId: "request-1",
				});
				expect(created).toEqual({
					projectSlug: "demo",
					sessionId: "session-new",
				});

				expect(
					yield* client.ViewSession({
						projectSlug: "demo",
						sessionId: "session-1",
						originId: "browser-tab-a",
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.DeleteSession({
						projectSlug: "demo",
						sessionId: "session-1",
						originId: "browser-tab-a",
					}),
				).toEqual({ ok: true });

				const forked = yield* client.ForkSession({
					projectSlug: "demo",
					sessionId: "session-1",
					messageId: "message-1",
					originId: "browser-tab-a",
				});
				expect(forked).toEqual({
					projectSlug: "demo",
					sessionId: "session-forked",
				});

				expect(
					yield* client.RespondPermission({
						projectSlug: "demo",
						originId: "browser-tab-a",
						requestId: "per-1",
						decision: "allow",
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.AnswerQuestion({
						projectSlug: "demo",
						originId: "browser-tab-a",
						toolId: "que-1",
						answers: { "0": "yes" },
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.RejectQuestion({
						projectSlug: "demo",
						originId: "browser-tab-a",
						toolId: "que-1",
					}),
				).toEqual({ ok: true });

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
					yield* client.RewindSession({
						projectSlug: "demo",
						sessionId: "session-1",
						messageId: "message-1",
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.SendMessage({
						projectSlug: "demo",
						sessionId: "session-1",
						text: "hello",
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.SyncInputDraft({
						projectSlug: "demo",
						sessionId: "session-1",
						text: "draft",
						originId: "browser-tab-a",
					}),
				).toEqual({ ok: true });

				expect(
					yield* client.SetLogLevel({
						projectSlug: "demo",
						level: "debug",
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
			new AddProject({
				projectSlug: "demo",
				directory: "/tmp/new-project",
			})._tag,
		).toBe("AddProject");
		expect(
			new RemoveProject({
				projectSlug: "demo",
				slug: "old-project",
			})._tag,
		).toBe("RemoveProject");
		expect(
			new RenameProject({
				projectSlug: "demo",
				slug: "demo",
				title: "Renamed Demo",
			})._tag,
		).toBe("RenameProject");
		expect(
			new SetProjectInstance({
				projectSlug: "demo",
				slug: "demo",
				instanceId: "inst-1",
			})._tag,
		).toBe("SetProjectInstance");
		expect(
			new StartInstance({
				projectSlug: "demo",
				instanceId: "inst-1",
			})._tag,
		).toBe("StartInstance");
		expect(
			new StopInstance({
				projectSlug: "demo",
				instanceId: "inst-1",
			})._tag,
		).toBe("StopInstance");
		expect(
			new RemoveInstance({
				projectSlug: "demo",
				instanceId: "inst-1",
			})._tag,
		).toBe("RemoveInstance");
		expect(
			new RenameInstance({
				projectSlug: "demo",
				instanceId: "inst-1",
				name: "Primary",
			})._tag,
		).toBe("RenameInstance");
		expect(new ScanNow({ projectSlug: "demo" })._tag).toBe("ScanNow");
		expect(new DetectProxy({ projectSlug: "demo" })._tag).toBe("DetectProxy");
		expect(
			new ListPtys({
				projectSlug: "demo",
				originId: "browser-tab-a",
			})._tag,
		).toBe("ListPtys");
		expect(
			new CreatePty({
				projectSlug: "demo",
				originId: "browser-tab-a",
			})._tag,
		).toBe("CreatePty");
		expect(
			new ResizePty({
				projectSlug: "demo",
				ptyId: "pty-1",
			})._tag,
		).toBe("ResizePty");
		expect(
			new ClosePty({
				projectSlug: "demo",
				ptyId: "pty-1",
			})._tag,
		).toBe("ClosePty");
		expect(
			new CreateSession({
				projectSlug: "demo",
				originId: "browser-tab-a",
			})._tag,
		).toBe("CreateSession");
		expect(
			new ViewSession({
				projectSlug: "demo",
				sessionId: "session-1",
				originId: "browser-tab-a",
			})._tag,
		).toBe("ViewSession");
		expect(
			new DeleteSession({
				projectSlug: "demo",
				sessionId: "session-1",
			})._tag,
		).toBe("DeleteSession");
		expect(
			new ForkSession({
				projectSlug: "demo",
				sessionId: "session-1",
				messageId: "message-1",
				originId: "browser-tab-a",
			})._tag,
		).toBe("ForkSession");
		expect(
			new RespondPermission({
				projectSlug: "demo",
				originId: "browser-tab-a",
				requestId: "per-1",
				decision: "allow",
			})._tag,
		).toBe("RespondPermission");
		expect(
			new AnswerQuestion({
				projectSlug: "demo",
				originId: "browser-tab-a",
				toolId: "que-1",
				answers: { "0": "yes" },
			})._tag,
		).toBe("AnswerQuestion");
		expect(
			new RejectQuestion({
				projectSlug: "demo",
				originId: "browser-tab-a",
				toolId: "que-1",
			})._tag,
		).toBe("RejectQuestion");
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
			new RewindSession({
				projectSlug: "demo",
				sessionId: "session-1",
				messageId: "message-1",
			})._tag,
		).toBe("RewindSession");
		expect(
			new SendMessage({
				projectSlug: "demo",
				sessionId: "session-1",
				text: "hello",
			})._tag,
		).toBe("SendMessage");
		expect(
			new SyncInputDraft({
				projectSlug: "demo",
				sessionId: "session-1",
				text: "draft",
				originId: "browser-tab-a",
			})._tag,
		).toBe("SyncInputDraft");
		expect(
			new CancelSession({ projectSlug: "demo", sessionId: "session-1" })._tag,
		).toBe("CancelSession");
		expect(new SetLogLevel({ projectSlug: "demo", level: "debug" })._tag).toBe(
			"SetLogLevel",
		);
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
