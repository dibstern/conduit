import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { SessionDirectory } from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../../src/lib/instance/sdk-factory.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import {
	skillCommand,
	skillRefFor,
} from "../../../src/lib/provider/skill-discovery.js";
import type {
	DiscoveredSkill,
	ProviderCapabilities,
} from "../../../src/lib/provider/types.js";
import {
	makeRoutedWsRpcServerLayer,
	WsRpcServerLayer,
} from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetSkillContent", () => {
	let temp: string;
	let project: string;

	beforeEach(() => {
		temp = realpathSync(
			mkdtempSync(join(os.tmpdir(), "conduit-skill-content-")),
		);
		project = join(temp, "project");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(temp, { recursive: true, force: true });
	});

	const writeSkill = (
		root: string,
		name: string,
		content: string,
	): DiscoveredSkill => {
		const path = join(root, name, "SKILL.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		return {
			name,
			source: "project-skill",
			location: { _tag: "File", path, root },
		};
	};

	const discovery = (skills: readonly DiscoveredSkill[]) => {
		const engine = new OrchestrationEngine({
			registry: new ProviderRegistry(),
		});
		const capabilities: ProviderCapabilities = {
			models: [],
			commands: skills.map(skillCommand),
			skills,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: true,
			supportsRevert: true,
		};
		vi.spyOn(engine, "dispatchEffect").mockReturnValue(
			Effect.succeed(capabilities),
		);
		const accounts = makeMockAccountDirectory();
		return {
			orchestrationEngine: engine,
			accountDirectory: {
				...accounts,
				resolve: () =>
					accounts.resolve({ _tag: "DriverDefault", driver: "claude" }),
			},
		};
	};

	const readSkill = (
		skill: DiscoveredSkill,
		skills: readonly DiscoveredSkill[] = [skill],
		skillRef = skillRefFor(skill),
	) =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			return yield* client.GetSkillContent({
				projectSlug: "project-a",
				skillRef,
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config: makeMockConfig({
								slug: "project-a",
								projectDir: project,
							}),
							...discovery(skills),
						}),
					),
				),
				{ local: true },
			),
		);

	const openCodeRpcLayer = (api: OpenCodeAPI) => {
		const engine = new OrchestrationEngine({
			registry: new ProviderRegistry(),
		});
		vi.spyOn(engine, "getProviderForSessionEffect").mockReturnValue(
			Effect.succeed("opencode"),
		);
		return WsRpcServerLayer.pipe(
			Layer.provideMerge(
				makeTestHandlerLayer({
					api,
					orchestrationEngine: engine,
					config: makeMockConfig({
						slug: "project-a",
						projectDir: project,
					}),
					persistenceLayer: makePersistenceEffectLayer(":memory:", "project-a"),
					seedEvents: [
						canonicalEvent("session.created", "opencode-session", {
							sessionId: "opencode-session",
							title: "OpenCode skill",
							provider: "opencode",
						}),
					],
				}),
			),
		);
	};

	it.effect("keeps bound OpenCode commands when skill discovery fails", () => {
		const { client: sdk } = createSdkClient({
			baseUrl: "http://opencode.test",
			fetch: async (input) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				return url.pathname === "/skill"
					? Response.json(
							{ message: "Skill inventory failed" },
							{ status: 500 },
						)
					: Response.json([
							{
								name: "build",
								source: "command",
								template: "Build",
								hints: [],
							},
							{
								name: "review",
								source: "skill",
								template: "Review",
								hints: [],
							},
						]);
			},
		});
		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const { commands } = yield* client.GetCommands({
				sessionId: "opencode-session",
			});
			expect(commands).toEqual([
				{ name: "build" },
				{ name: "review", skillRef: expect.any(String) },
			]);
			const skillRef = commands[1]?.skillRef;
			if (!skillRef) throw new Error("OpenCode skill reference is missing");
			expect(
				yield* Effect.result(
					client.GetSkillContent({ sessionId: "opencode-session", skillRef }),
				),
			).toMatchObject({
				failure: {
					message: "Skill content not available: managed by the provider",
				},
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				openCodeRpcLayer(
					new OpenCodeAPI({
						sdk,
						baseUrl: "http://opencode.test",
						authHeaders: {},
					}),
				),
				{ local: true },
			),
		);
	});

	it.effect.each(["file", "symlink"] as const)(
		"lists and opens an OpenCode project's skill through its reference (%s)",
		(kind) =>
			Effect.gen(function* () {
				const content = "# Review\nUse the OpenCode project's instructions.\n";
				const path = join(project, ".claude", "skills", "review", "SKILL.md");
				const target =
					kind === "symlink"
						? join(project, ".claude", "skills", "shared", "SKILL.md")
						: path;
				mkdirSync(dirname(path), { recursive: true });
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, content);
				if (kind === "symlink") symlinkSync(target, path);
				const requests: URL[] = [];
				const { client: sdk } = createSdkClient({
					baseUrl: "http://opencode.test",
					fetch: async (input) => {
						const url = new URL(
							input instanceof Request ? input.url : String(input),
						);
						requests.push(url);
						return Response.json(
							url.pathname === "/skill"
								? [
										{
											name: "review",
											description: "Review the diff",
											location: path,
											content,
										},
									]
								: [
										{
											name: "review",
											source: "skill",
											template: content,
											hints: [],
										},
									],
						);
					},
				});
				const api = new OpenCodeAPI({
					sdk,
					baseUrl: "http://opencode.test",
					authHeaders: {},
				});
				return yield* Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(WsRpcGroup);
					const { commands } = yield* client.GetCommands({
						sessionId: "opencode-session",
					});
					const skillRef = commands.find(
						(command) => command.name === "review",
					)?.skillRef;
					expect(skillRef).toEqual(expect.any(String));
					if (!skillRef) throw new Error("OpenCode skill reference is missing");
					expect(skillRef).not.toContain(project);
					expect(
						yield* client.GetSkillContent({
							sessionId: "opencode-session",
							skillRef,
						}),
					).toEqual({
						projectSlug: "project-a",
						name: "review",
						path: target,
						content,
					});
					expect(
						requests
							.filter((url) => url.pathname === "/skill")
							.every((url) => url.searchParams.get("directory") === project),
					).toBe(true);
				}).pipe(Effect.provide(openCodeRpcLayer(api), { local: true }));
			}).pipe(Effect.scoped),
	);

	it.effect(
		"reads the discovered location instead of a same-named Claude skill",
		() =>
			Effect.gen(function* () {
				writeSkill(
					join(project, ".claude", "skills"),
					"review",
					"Claude instructions",
				);
				const skill = writeSkill(
					join(project, ".cursor", "skills"),
					"review",
					"Cursor instructions",
				);
				expect(yield* readSkill(skill)).toMatchObject({
					projectSlug: "project-a",
					name: "review",
					content: "Cursor instructions",
				});
			}),
	);

	it.effect(
		"distinguishes same-named skills by their discovered location",
		() =>
			Effect.gen(function* () {
				const personal = writeSkill(
					join(temp, "personal-skills"),
					"review",
					"Personal instructions",
				);
				const work = writeSkill(
					join(temp, "work-skills"),
					"review",
					"Work instructions",
				);
				expect(skillRefFor(personal)).not.toBe(skillRefFor(work));
				expect((yield* readSkill(work, [personal, work])).content).toBe(
					"Work instructions",
				);
				expect((yield* readSkill(personal, [personal, work])).content).toBe(
					"Personal instructions",
				);
			}),
	);

	it.effect("rejects unknown references without accessing the filesystem", () =>
		Effect.gen(function* () {
			const skill = writeSkill(
				join(temp, "skills"),
				"review",
				"Review instructions",
			);
			const realpath = vi.spyOn(fs, "realpath");
			const open = vi.spyOn(fs, "open");
			for (const skillRef of [
				"unknown-ref",
				"0".repeat(64),
				"../secret",
				join(temp, "skills", "review", "SKILL.md"),
			]) {
				expect(
					yield* Effect.result(readSkill(skill, [skill], skillRef)),
				).toMatchObject({
					_tag: "Failure",
					failure: { message: "Skill content not available" },
				});
			}
			expect(realpath).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		}),
	);

	it.effect(
		"reports provider-only content unavailable without guessing a file",
		() =>
			Effect.gen(function* () {
				writeSkill(
					join(project, ".claude", "skills"),
					"review",
					"Unrelated instructions",
				);
				const skill: DiscoveredSkill = {
					name: "review",
					source: "user-skill",
					location: { _tag: "Provider" },
				};
				const realpath = vi.spyOn(fs, "realpath");
				const open = vi.spyOn(fs, "open");
				expect(yield* Effect.result(readSkill(skill))).toMatchObject({
					_tag: "Failure",
					failure: {
						message: "Skill content not available: managed by the provider",
					},
				});
				expect(realpath).not.toHaveBeenCalled();
				expect(open).not.toHaveBeenCalled();
			}),
	);

	it.effect("returns only the first 256 KiB of a larger file", () =>
		Effect.gen(function* () {
			const content = "x".repeat(256 * 1024);
			const skill = writeSkill(
				join(temp, "skills"),
				"large",
				`${content}discard this`,
			);
			expect((yield* readSkill(skill)).content).toBe(content);
		}),
	);

	it.effect("allows a symlinked discovery root", () =>
		Effect.gen(function* () {
			const root = join(temp, "real-skills");
			const skill = writeSkill(root, "review", "Linked instructions");
			const link = join(temp, "linked-skills");
			symlinkSync(root, link);
			const linked: DiscoveredSkill = {
				...skill,
				location: {
					_tag: "File",
					root: link,
					path: join(link, "review", "SKILL.md"),
				},
			};
			expect((yield* readSkill(linked)).content).toBe("Linked instructions");
		}),
	);

	it.effect(
		"rejects skill directories and files symlinked outside the recorded root",
		() =>
			Effect.gen(function* () {
				const root = join(temp, "skills");
				const outside = `${root}-outside`;
				mkdirSync(root, { recursive: true });
				mkdirSync(outside);
				writeFileSync(join(outside, "SKILL.md"), "Private instructions");
				symlinkSync(outside, join(root, "escaped-dir"));
				mkdirSync(join(root, "escaped-file"));
				symlinkSync(
					join(outside, "SKILL.md"),
					join(root, "escaped-file", "SKILL.md"),
				);
				for (const name of ["escaped-dir", "escaped-file"]) {
					const skill: DiscoveredSkill = {
						name,
						source: "project-skill",
						location: {
							_tag: "File",
							root,
							path: join(root, name, "SKILL.md"),
						},
					};
					expect(yield* Effect.result(readSkill(skill))).toMatchObject({
						_tag: "Failure",
						failure: { message: "Skill content not available" },
					});
				}
			}),
	);

	it.effect(
		"routes through the owning project's discovery and refuses missing sessions",
		() =>
			Effect.gen(function* () {
				const skillA = writeSkill(
					join(project, "skills"),
					"review",
					"Project A instructions",
				);
				const otherProject = join(temp, "project-b");
				const skillB = writeSkill(
					join(otherProject, "skills"),
					"review",
					"Project B instructions",
				);
				const directoryLayer = Layer.succeed(SessionDirectory)({
					projectOf: (sessionId) =>
						Effect.succeed(
							sessionId === "owned-b"
								? Option.some("project-b")
								: Option.none(),
						),
				});
				const projectA = yield* Layer.build(
					makeTestHandlerLayer({
						config: makeMockConfig({ slug: "project-a", projectDir: project }),
						...discovery([skillA]),
					}),
				);
				const projectB = yield* Layer.build(
					makeTestHandlerLayer({
						config: makeMockConfig({
							slug: "project-b",
							projectDir: otherProject,
						}),
						...discovery([skillB]),
						persistenceLayer: makePersistenceEffectLayer(
							":memory:",
							"project-b",
						),
						seedEvents: [
							canonicalEvent("session.created", "owned-b", {
								sessionId: "owned-b",
								title: "Owned by B",
								provider: "claude",
							}),
						],
					}),
				);
				const resolve = vi.fn((slug: string) =>
					slug === "project-a"
						? Effect.succeed(projectA)
						: slug === "project-b"
							? Effect.succeed(projectB)
							: Effect.fail(
									new WsRpcError({ message: `Unknown project ${slug}` }),
								),
				);
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(resolve, undefined, "project-a").pipe(
							Layer.provide(directoryLayer),
						),
						{ local: true },
					),
				);
				expect(
					(yield* client.GetSkillContent({
						projectSlug: "project-b",
						skillRef: skillRefFor(skillB),
					})).content,
				).toBe("Project B instructions");
				expect(
					(yield* client.GetSkillContent({
						sessionId: "owned-b",
						skillRef: skillRefFor(skillB),
					})).content,
				).toBe("Project B instructions");
				expect(
					yield* Effect.result(
						client.GetSkillContent({
							projectSlug: "project-b",
							skillRef: skillRefFor(skillA),
						}),
					),
				).toMatchObject({
					_tag: "Failure",
					failure: { message: "Skill content not available" },
				});
				expect(resolve.mock.calls.map(([slug]) => slug)).toEqual([
					"project-b",
					"project-b",
					"project-b",
				]);
				resolve.mockClear();
				const realpath = vi.spyOn(fs, "realpath");
				const open = vi.spyOn(fs, "open");
				expect(
					yield* Effect.result(
						client.GetSkillContent({
							sessionId: "missing",
							skillRef: skillRefFor(skillB),
						}),
					),
				).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "WsRpcError", code: "unknown-session" },
				});
				expect(resolve).not.toHaveBeenCalled();
				expect(realpath).not.toHaveBeenCalled();
				expect(open).not.toHaveBeenCalled();
			}).pipe(Effect.scoped),
	);

	it.effect("reports unavailable when a discovered file was removed", () =>
		Effect.gen(function* () {
			const skill = writeSkill(join(temp, "skills"), "missing", "Instructions");
			rmSync(join(temp, "skills"), { recursive: true });
			expect(yield* Effect.result(readSkill(skill))).toMatchObject({
				_tag: "Failure",
				failure: { message: "Skill content not available" },
			});
		}),
	);
});
