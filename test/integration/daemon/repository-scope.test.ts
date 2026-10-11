// Failure cases, written before implementation:
// - A repository scope omits one clone or admits an unrelated repository.
// - Narrowing to a project still returns the other clone's sessions.
// - A project slug resembling the group encoding is interpreted as a group.
// - Search or a keyset page drops the scope or filters after merging the page.
// - Turning grouping off makes a stale scope fall back to all projects.
// - Removing the scoped projects makes an obsolete group scope show other sessions.
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

// Same isolated Git and built-daemon helpers as repository-grouping.test.ts.
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

describe("repository scope through the built daemon", () => {
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

	it("scopes SSH and HTTPS clones, narrows, searches, pages and rejects stale groups", async () => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			foregroundCli: true,
		});
		await harness.restart();
		browser = await harness.connect();
		const client = browser;
		const root = realpathSync(harness.root);
		const remote = join(root, "remote.git");
		const ssh = join(root, "ssh-clone");
		const https = join(root, "https-clone");
		const unrelated = join(root, "group-[repository-github.com-acme-shared]");
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
		expect(unrelatedSlug).toBe("group-repository-github-com-acme-shared");
		const projects = await Effect.runPromise(client.rpc.GetProjects({}));
		const group = projects.projects.find(({ slug }) => slug === sshSlug)?.group;
		expect(group).toMatchObject({
			label: "Shared",
			needsProjectQualifier: true,
		});
		expect(
			projects.projects.find(({ slug }) => slug === httpsSlug)?.group,
		).toEqual(group);
		if (!group) throw new Error("Missing repository group");
		const scope = `/group/${group.key}`;
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
						projectSlug: slug,
						originId: "repository-scope-test",
						providerId: "claude",
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
		const expected = [
			...(sessionIds.get(sshSlug) ?? []),
			...(sessionIds.get(httpsSlug) ?? []),
		].sort();
		expect(
			(await read("repository", { scope })).sessions.map(({ id }) => id).sort(),
		).toEqual(expected);
		expect(
			(await read("project", { scope: sshSlug })).sessions
				.map(({ id }) => id)
				.sort(),
		).toEqual([...(sessionIds.get(sshSlug) ?? [])].sort());
		expect(
			(await read("group-looking-project", { scope: unrelatedSlug })).sessions
				.map(({ id }) => id)
				.sort(),
		).toEqual([...(sessionIds.get(unrelatedSlug) ?? [])].sort());
		const first = await read("first-page", { scope, limit: 2 });
		expect(first.hasMore).toBe(true);
		if (!first.nextCursor) throw new Error("Missing browse cursor");
		const second = await read("next-page", {
			scope,
			limit: 2,
			cursor: first.nextCursor,
		});
		expect(second.hasMore).toBe(false);
		expect(
			[...first.sessions, ...second.sessions].map(({ id }) => id).sort(),
		).toEqual(expected);
		const matches = await read("search", { scope, search: "needle" });
		expect(matches.sessions.map(({ id }) => names.get(id)).sort()).toEqual([
			"needle HTTPS",
			"needle SSH",
		]);
		const searchFirst = await read("search-first-page", {
			scope,
			search: "needle",
			limit: 1,
		});
		expect(searchFirst.hasMore).toBe(true);
		if (!searchFirst.nextCursor) throw new Error("Missing search cursor");
		const searchNext = await read("search-next-page", {
			scope,
			search: "needle",
			limit: 1,
			cursor: searchFirst.nextCursor,
		});
		expect(searchNext.hasMore).toBe(false);
		expect(
			[...searchFirst.sessions, ...searchNext.sessions]
				.map(({ id }) => id)
				.sort(),
		).toEqual(matches.sessions.map(({ id }) => id).sort());
		await Effect.runPromise(client.rpc.SetDefaultGroupingMode({ mode: "off" }));
		const stale = await read("stale-after-grouping-off", { scope });
		const unknown = await read("unknown-project", { scope: "not-registered" });
		expect(stale).toEqual(unknown);
		expect(stale.sessions).toEqual([]);
		expect(stale.hasMore).toBe(false);
		expect(stale.nextCursor).toBeNull();
		await Effect.runPromise(
			client.rpc.SetDefaultGroupingMode({ mode: "repository" }),
		);
		for (const slug of [sshSlug, httpsSlug])
			await Effect.runPromise(client.rpc.RemoveProject({ slug }));
		expect(await read("stale-after-project-removal", { scope })).toEqual(
			unknown,
		);
	}, 90_000);
});
