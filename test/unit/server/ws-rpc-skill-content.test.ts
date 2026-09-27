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
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
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
				const result = yield* Effect.either(readSkill(name));
				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left.message).toBe("Skill content not available");
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
					const result = yield* Effect.either(readSkill(name));
					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left.message).toBe("Skill content not available");
					}
				}
			}),
	);

	it.effect("does not use another project's cwd for a mismatched slug", () =>
		Effect.gen(function* () {
			writeSkill(project, "review", "Project instructions");
			const path = writeSkill(home, "review", "Home instructions");
			expect(yield* readSkill("review", "other-project")).toEqual({
				projectSlug: "other-project",
				name: "review",
				path,
				content: "Home instructions",
			});
		}),
	);

	it.effect("returns not-found when neither root contains the skill", () =>
		Effect.gen(function* () {
			const result = yield* Effect.either(readSkill("missing"));
			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left.message).toBe("Skill content not available");
			}
		}),
	);
});
