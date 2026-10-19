// Failure cases: project scope leaks another clone, search or pagination drops
// scope, or a removed project falls back to the unscoped list.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonSessionQueryOptions } from "../../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Isolate Git discovery from the developer shell.
const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];

function git(cwd: string, ...args: string[]) {
	execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe", timeout: 5000 });
}

describe("project scope through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let browser: ProcessBrowser | undefined;
	const names = new Map<string, string>();
	const observations: Record<string, unknown>[] = [];

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const root = realpathSync(fixture.root);
		try {
			await browser?.close();
			await fixture.terminate();
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				let manifest = JSON.stringify(
					{
						passed: task.result?.state === "pass",
						observations,
						cleanup: fixture.remainingRunnerPids(),
					},
					null,
					2,
				);
				for (const [id, title] of names)
					manifest = manifest.replaceAll(id, `<session:${title}>`);
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/q5u6-19-repository-scope.json",
					`${manifest}\n`,
				);
				writeFileSync(
					"test-results/q5u6-19-repository-scope.log",
					fixture.logTail
						.replaceAll(root, "<root>")
						.replaceAll(fixture.root, "<root>"),
				);
				harness = undefined;
			}
		}
	});

	it("scopes clones separately through search, paging and project removal", async () => {
		harness = ProcessHarness.create();
		await harness.restart();
		browser = await harness.connect();
		const client = browser;
		const root = realpathSync(harness.root);
		const remote = join(root, "remote.git");
		const ssh = join(root, "ssh-clone");
		const https = join(root, "https-clone");
		const unrelated = join(root, "library-clone");
		git(root, "init", "--bare", "-q", remote);
		for (const clone of [ssh, https, unrelated])
			git(root, "clone", "-q", remote, clone);
		git(ssh, "remote", "set-url", "origin", "git@GitHub.COM:Acme/Shared.git");
		git(
			https,
			"remote",
			"set-url",
			"origin",
			"https://github.com/acme/Shared.git",
		);
		git(
			unrelated,
			"remote",
			"set-url",
			"origin",
			"https://github.com/acme/Library.git",
		);
		const slugs: string[] = [];
		for (const [folder, title] of [
			[ssh, "SSH clone"],
			[https, "HTTPS clone"],
			[unrelated, "Library clone"],
		] as const) {
			const saved = await Effect.runPromise(
				client.rpc.SaveProject({ folders: [folder], title }),
			);
			slugs.push(saved.savedSlug);
		}
		const [sshSlug, httpsSlug, unrelatedSlug] = slugs;
		if (!sshSlug || !httpsSlug || !unrelatedSlug)
			throw new Error("Missing saved project");
		const scope = sshSlug;
		const sessionIds = new Map<string, string[]>();
		for (const [slug, title] of [
			[sshSlug, "SSH"],
			[httpsSlug, "HTTPS"],
			[unrelatedSlug, "Library"],
		] as const) {
			const ids: string[] = [];
			for (const prefix of ["needle", "plain"]) {
				const name = `${prefix} ${title}`;
				const created = await Effect.runPromise(
					client.rpc.CreateSession({
						permissionMode: "ask",
						projectSlug: slug,
						originId: "repository-scope-test",
						providerId: "claude",
						model: {
							providerId: "claude",
							modelId: "sonnet",
							variant: "",
							contextWindow: "200k",
						},
						title: name,
					}),
				);
				names.set(created.sessionId, name);
				ids.push(created.sessionId);
			}
			sessionIds.set(slug, ids);
		}
		const read = async (name: string, options: DaemonSessionQueryOptions) => {
			const result = await Effect.runPromise(
				client.rpc.ListDaemonSessions({ roots: true, ...options }),
			);
			const { cursor, ...query } = options;
			observations.push({
				name,
				...query,
				...(cursor ? { cursorSessionId: cursor.id } : {}),
				sessionIds: result.sessions
					.map(({ id }) => id)
					.sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b)),
				hasMore: result.hasMore,
			});
			return result;
		};
		const expected = [...(sessionIds.get(sshSlug) ?? [])].sort();
		expect(
			(await read("all-projects", {})).sessions.map(({ id }) => id).sort(),
		).toEqual([...sessionIds.values()].flat().sort());
		expect(
			(await read("project", { scope })).sessions.map(({ id }) => id).sort(),
		).toEqual(expected);
		expect(
			(await read("unrelated-project", { scope: unrelatedSlug })).sessions
				.map(({ id }) => id)
				.sort(),
		).toEqual([...(sessionIds.get(unrelatedSlug) ?? [])].sort());
		const first = await read("first-page", { scope, limit: 1 });
		expect(first.hasMore).toBe(true);
		if (!first.nextCursor) throw new Error("Missing browse cursor");
		const second = await read("next-page", {
			scope,
			limit: 1,
			cursor: first.nextCursor,
		});
		expect(second.hasMore).toBe(false);
		expect(
			[...first.sessions, ...second.sessions].map(({ id }) => id).sort(),
		).toEqual(expected);
		const matches = await read("search", { scope, search: "needle" });
		expect(matches.sessions.map(({ id }) => names.get(id)).sort()).toEqual([
			"needle SSH",
		]);
		const unknown = await read("unknown-project", { scope: "not-registered" });
		expect(unknown.sessions).toEqual([]);
		expect(unknown.hasMore).toBe(false);
		expect(unknown.nextCursor).toBeNull();
		for (const slug of [sshSlug, httpsSlug])
			await Effect.runPromise(client.rpc.RemoveProject({ slug }));
		expect(await read("stale-after-project-removal", { scope })).toEqual(
			unknown,
		);
	}, 90_000);
});
