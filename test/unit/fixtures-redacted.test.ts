import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Captured provider traces are committed to a public repo. A home path names
// the person who captured it and their accounts, plugins and projects; capture
// tests rewrite it to /home/test before writing.
const HOME_PATH = /\/Users\/[^/\s"\\]+|\/home\/(?!test\b)[^/\s"\\]+/;

it("committed fixtures contain no real home path", () => {
	const root = "test/fixtures";
	const leaks = readdirSync(root, { recursive: true, encoding: "utf8" })
		.map((path) => join(root, path))
		.filter((path) => statSync(path).isFile())
		.flatMap((path) => {
			const match = HOME_PATH.exec(readFileSync(path, "utf8"));
			return match ? [`${path}: ${match[0]}`] : [];
		});
	expect(leaks).toEqual([]);
});

// Plans and e2e recordings leak the same way. Elsewhere placeholder homes like
// /home/user are fine, so look for this machine's own home and its Claude
// project slug. .beads is exported from issue text after this check runs, so
// it would fail the next, unrelated commit; scrub it with `bd sql` instead.
it("no tracked file contains this machine's home path", () => {
	const home = userInfo().homedir;
	const grep = spawnSync(
		"git",
		[
			"grep",
			"-l",
			"-F",
			"-e",
			home,
			"-e",
			`${home.replaceAll("/", "-")}-`,
			"--",
			".",
			":!.beads",
		],
		{ encoding: "utf8" },
	);
	expect(grep.status, grep.stderr).not.toBe(128);
	expect(grep.stdout.split("\n").filter(Boolean)).toEqual([]);
});
