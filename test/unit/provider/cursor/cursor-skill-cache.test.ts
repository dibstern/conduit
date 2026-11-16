// Failure modes: every discovery rescans the skill folders (one session open
// asks three times, ~130ms each on a real home), or Reload serves the old list.
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { makeCursorRunnerDriver } from "../../../../src/lib/provider/cursor/cursor-runner-driver.js";
import { createTraceCursorSdkPort } from "../../../../src/lib/provider/cursor/sdk-trace-player.js";
import { cursorAccountResourcesFixture } from "../../../helpers/cursor-account-resources-fixture.js";
import {
	cursorSkill,
	cursorSkillsFixture,
} from "../../../helpers/cursor-skills-fixture.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("reuses one skill scan per workspace until a refresh asks for a new one", async () => {
	const { root, cwd, homeAlias } = cursorSkillsFixture();
	roots.push(root);
	vi.stubEnv("HOME", homeAlias);
	vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
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
	const skillNames = (refresh: boolean) =>
		Effect.runPromise(
			driver.discoverEffect(cwd, account, refresh ? { refresh } : undefined, {
				projectId: "skills",
				sessionId: "",
				workspaceRoot: cwd,
				extraFolders: [],
				account,
				shellEnv: {},
			}),
		).then(({ skills }) => skills?.map(({ name }) => name));

	const first = await skillNames(false);
	expect(first).not.toContain("added");
	cursorSkill(join(cwd, ".cursor/skills/added"));
	expect(await skillNames(false)).toEqual(first);
	expect(await skillNames(true)).toContain("added");
});
