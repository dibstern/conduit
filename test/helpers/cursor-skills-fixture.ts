import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function cursorSkill(directory: string, name?: string) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\n${name ? `name: ${name}\n` : ""}description: Fixture skill\n---\nUse this skill.\n`,
	);
}

export function cursorSkillCycle(repo: string) {
	for (const name of ["a-cycle", "b-cycle", "c-cycle"])
		symlinkSync(repo, join(repo, name), "dir");
	cursorSkill(
		join(
			repo,
			"z-deep",
			...Array.from({ length: 7 }, (_, i) => `level-${i}`),
			".cursor/skills/deep-legitimate",
		),
	);
}

export function cursorSkillsFixture() {
	mkdirSync("test-results", { recursive: true });
	const root = mkdtempSync(resolve("test-results/c5-a-skills-"));
	const repo = join(root, "repo");
	const cwd = join(repo, "project");
	const home = join(root, "home");
	const dirs = [join(root, "extra")];
	for (const directory of [cwd, home, ...dirs])
		mkdirSync(directory, { recursive: true });
	execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
	const skills = join(cwd, ".cursor/skills");
	cursorSkill(join(skills, "project"));
	cursorSkill(join(repo, ".cursor/skills/toplevel"));
	cursorSkill(join(home, ".cursor/skills/user"));
	cursorSkill(join(home, ".cursor/skills-cursor/managed"));
	cursorSkill(join(dirs[0] ?? "", ".cursor/skills/extra"));
	// The positive target is inside the git toplevel, outside the skill directory.
	const linked = join(repo, "external/linked");
	cursorSkill(linked);
	cursorSkill(join(linked, "must-not-walk"));
	symlinkSync(linked, join(skills, "linked"), "dir");
	const outside = join(root, "outside");
	cursorSkill(outside);
	symlinkSync(outside, join(skills, "outside"), "dir");
	// Plugin skills bypass the workspace/home realpath filter.
	const plugin = join(home, ".cursor/plugins/local/fixture");
	mkdirSync(join(plugin, "skills/external"), { recursive: true });
	writeFileSync(
		join(plugin, "plugin.json"),
		JSON.stringify({ name: "fixture" }),
	);
	cursorSkill(join(plugin, "skills/local"), "local");
	cursorSkill(join(root, "plugin-target"), "external");
	symlinkSync(
		join(root, "plugin-target/SKILL.md"),
		join(plugin, "skills/external/SKILL.md"),
	);
	const homeAlias = join(root, "home-alias");
	symlinkSync(home, homeAlias, "dir");
	return { root, repo, cwd, home, homeAlias, dirs };
}
