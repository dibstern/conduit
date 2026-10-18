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
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeRoutedWsRpcServerLayer,
	WsRpcServerLayer,
} from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetSkillContent", () => {
	let temp: string;
	let project: string;
	let home: string;

	beforeEach(() => {
		temp = realpathSync(
			mkdtempSync(join(os.tmpdir(), "conduit-skill-content-")),
		);
		project = join(temp, "project");
		home = join(temp, "home");
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(temp, { recursive: true, force: true });
	});

	const writeSkill = (cwd: string, name: string, content: string) => {
		const path = join(cwd, ".claude", "skills", name, "SKILL.md");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		return path;
	};

	const readSkill = (name: string, projectSlug = "project-a") =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			return yield* client.GetSkillContent({ projectSlug, name });
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
						}),
					),
				),
				{ local: true },
			),
		);

	it.effect("resolves a project-local skill", () =>
		Effect.gen(function* () {
			const content = "# Review\nRead the diff carefully.\n";
			const path = writeSkill(project, "Review_2-test", content);
			expect(yield* readSkill("Review_2-test")).toEqual({
				projectSlug: "project-a",
				name: "Review_2-test",
				path,
				content,
			});
		}),
	);

	it.effect("falls back to the home skill when the project has none", () =>
		Effect.gen(function* () {
			const path = writeSkill(home, "review", "Home instructions");
			expect(yield* readSkill("review")).toEqual({
				projectSlug: "project-a",
				name: "review",
				path,
				content: "Home instructions",
			});
		}),
	);

	it.effect("prefers the project skill when both exist", () =>
		Effect.gen(function* () {
			writeSkill(home, "review", "Home instructions");
			const path = writeSkill(project, "review", "Project instructions");
			expect(yield* readSkill("review")).toEqual({
				projectSlug: "project-a",
				name: "review",
				path,
				content: "Project instructions",
			});
		}),
	);

	it.effect("rejects invalid names without accessing the filesystem", () =>
		Effect.gen(function* () {
			const realpath = vi.spyOn(fs, "realpath");
			const open = vi.spyOn(fs, "open");
			for (const name of [
				"..",
				"../secret",
				"nested/skill",
				"a..b",
				".hidden",
			]) {
				const result = yield* Effect.result(readSkill(name));
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") {
					expect(result.failure.message).toBe("Skill content not available");
				}
			}
			expect(realpath).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		}),
	);

	it.effect("returns only the first 256 KiB of a larger file", () =>
		Effect.gen(function* () {
			const content = "x".repeat(256 * 1024);
			const path = writeSkill(project, "large", `${content}discard this`);
			expect(yield* readSkill("large")).toEqual({
				projectSlug: "project-a",
				name: "large",
				path,
				content,
			});
		}),
	);

	it.effect("allows a symlinked skills root", () =>
		Effect.gen(function* () {
			const linkedHome = join(temp, "linked-home");
			const path = writeSkill(linkedHome, "review", "Linked instructions");
			mkdirSync(join(home, ".claude"), { recursive: true });
			symlinkSync(
				join(linkedHome, ".claude", "skills"),
				join(home, ".claude", "skills"),
			);
			expect(yield* readSkill("review")).toEqual({
				projectSlug: "project-a",
				name: "review",
				path,
				content: "Linked instructions",
			});
		}),
	);

	it.effect(
		"rejects skill directories and files symlinked outside the root",
		() =>
			Effect.gen(function* () {
				const root = join(project, ".claude", "skills");
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
					const result = yield* Effect.result(readSkill(name));
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure") {
						expect(result.failure.message).toBe("Skill content not available");
					}
				}
			}),
	);

	it.effect("does not use another project's cwd for a mismatched slug", () =>
		Effect.gen(function* () {
			writeSkill(project, "review", "Project A instructions");
			const homePath = writeSkill(home, "review", "Home instructions");
			const otherProject = join(temp, "project-b");
			const directoryLayer = Layer.succeed(SessionDirectory)({
				projectOf: (sessionId) =>
					Effect.succeed(
						sessionId === "owned-b" ? Option.some("project-b") : Option.none(),
					),
			});
			const projectA = yield* Layer.build(
				makeTestHandlerLayer({
					config: makeMockConfig({ slug: "project-a", projectDir: project }),
				}),
			);
			const projectB = yield* Layer.build(
				makeTestHandlerLayer({
					config: makeMockConfig({
						slug: "project-b",
						projectDir: otherProject,
					}),
					persistenceLayer: makePersistenceEffectLayer(":memory:", "project-b"),
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
			const realpath = vi.spyOn(fs, "realpath");
			const open = vi.spyOn(fs, "open");
			expect(
				yield* client.GetSkillContent({
					projectSlug: "project-b",
					name: "review",
				}),
			).toEqual({
				projectSlug: "project-b",
				name: "review",
				path: homePath,
				content: "Home instructions",
			});
			const path = writeSkill(otherProject, "review", "Project B instructions");
			expect(
				yield* client.GetSkillContent({ sessionId: "owned-b", name: "review" }),
			).toEqual({
				projectSlug: "project-b",
				name: "review",
				path,
				content: "Project B instructions",
			});
			expect(resolve.mock.calls.map(([slug]) => slug)).toEqual([
				"project-b",
				"project-b",
			]);
			const projectARoot = join(project, ".claude", "skills");
			expect(
				realpath.mock.calls.some(([path]) =>
					String(path).startsWith(projectARoot),
				),
			).toBe(false);
			expect(
				open.mock.calls.some(([path]) => String(path).startsWith(projectARoot)),
			).toBe(false);
			resolve.mockClear();
			realpath.mockClear();
			open.mockClear();
			expect(
				yield* Effect.result(
					client.GetSkillContent({ sessionId: "missing", name: "review" }),
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

	it.effect("returns not-found when neither root contains the skill", () =>
		Effect.gen(function* () {
			const result = yield* Effect.result(readSkill("missing"));
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure.message).toBe("Skill content not available");
			}
		}),
	);
});
