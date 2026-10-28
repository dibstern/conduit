// Failure modes: git-parent/extra roots omitted, escaped targets included,
// linked descendants skipped, HOME aliases rejected, managed cache omitted.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { makeCursorRunnerDriver } from "../../../../src/lib/provider/cursor/cursor-runner-driver.js";
import { writeCursorSessionIdentity } from "../../../../src/lib/provider/cursor/cursor-session-recovery.js";
import { discoverCursorSkillsEffect } from "../../../../src/lib/provider/cursor/cursor-skill-discovery.js";
import { createTraceCursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-trace-player.js";
import { cursorAccountResourcesFixture } from "../../../helpers/cursor-account-resources-fixture.js";
import {
	cursorSkillCycle,
	cursorSkillsFixture,
} from "../../../helpers/cursor-skills-fixture.js";

describe("Cursor skill root rules", () => {
	const roots: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});
	const fixture = () => {
		const result = cursorSkillsFixture();
		roots.push(result.root);
		vi.stubEnv("HOME", result.homeAlias);
		vi.stubEnv("GIT_CEILING_DIRECTORIES", result.root);
		return result;
	};
	it("finds a deep legitimate skill without exhausting the directory budget on a symlink cycle", async () => {
		const { cwd, repo } = fixture();
		cursorSkillCycle(repo);
		const skills = await Effect.runPromise(
			discoverCursorSkillsEffect(cwd, { settingSources: ["project"] }),
		);
		expect(skills.map(({ name }) => name)).toContain("deep-legitimate");
	});
	it("lists the on-disk managed cache by default", async () => {
		const { cwd } = fixture();
		const skills = await Effect.runPromise(discoverCursorSkillsEffect(cwd));
		expect(skills.map(({ name }) => name)).toContain("managed");
	});
	it("uses the git toplevel, follows linked descendants, and rejects escaped files", async () => {
		const { cwd } = fixture();
		const skills = await Effect.runPromise(discoverCursorSkillsEffect(cwd));
		expect(skills.map(({ name }) => name)).toEqual([
			"linked",
			"local",
			"managed",
			"must-not-walk",
			"project",
			"toplevel",
			"user",
		]);
	});
	it("uses all explicit folders instead of widening to the git parent", async () => {
		const { cwd, dirs } = fixture();
		const skills = await Effect.runPromise(
			discoverCursorSkillsEffect(cwd, { dirs }),
		);
		expect(skills.map(({ name }) => name)).toEqual([
			"extra",
			"local",
			"managed",
			"project",
			"user",
		]);
	});
	it("honors setting sources for project and cached managed skills", async () => {
		const { cwd } = fixture();
		const withoutUser = await Effect.runPromise(
			discoverCursorSkillsEffect(cwd, { settingSources: ["project"] }),
		);
		expect(withoutUser.map(({ name }) => name)).toEqual([
			"linked",
			"must-not-walk",
			"project",
			"toplevel",
		]);
		const managed = await Effect.runPromise(
			discoverCursorSkillsEffect(cwd, {
				settingSources: ["team"],
			}),
		);
		expect(managed.map(({ name }) => name)).toEqual(["managed"]);
	});
	it.each([
		"draft",
		"moved",
	] as const)("lists the effective folders for %s provider discovery", async (row) => {
		const { cwd, dirs, root } = fixture();
		if (row === "moved")
			writeCursorSessionIdentity(root, "skills", {
				cwd,
				agentId: "skills",
				controllerPid: process.pid,
			});
		const workspaceRoot = row === "moved" ? join(root, "extra") : cwd;
		const account = {
			driver: "cursor" as const,
			id: AccountIdSchema.make("skills"),
			name: "Cursor skills",
			usageEligible: false,
		};
		const driver = makeCursorRunnerDriver(
			cursorAccountResourcesFixture(
				createTraceCursorSdkPort(
					resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"),
				),
			),
			undefined,
			root,
		);
		const capabilities = await Effect.runPromise(
			driver.discoverEffect(cwd, account, undefined, {
				projectId: "skills",
				sessionId: row === "draft" ? "" : "skills",
				workspaceRoot,
				extraFolders: row === "moved" ? [] : dirs,
				account,
				shellEnv: {},
			}),
		);
		expect(capabilities.commands?.map(({ name }) => name)).toEqual([
			"extra",
			"local",
			"managed",
			"project",
			"user",
		]);
	});
});
