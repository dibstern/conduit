import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Effect, Fiber, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure modes: a snapshot writes the user's index, objects or refs; staged
// or ignored files leak into the unstaged scope, or untracked files drop out;
// blob ids name the HEAD side instead of the index side; counts, the binary
// flag or the size tier are wrong; file() serves an unlisted path, a forged
// blob pair or a tooLarge file; a collected snapshot surfaces as a crash or an
// empty patch rather than Gone; a re-list after Gone stays broken. Live: a
// device misses an external edit, devices open or get pushed different
// revisions, or a pushed revision cannot be listed or names the old pair.
const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];

const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/** Content hash of every file that records the repository's state. */
function repositoryBytes(gitDir: string) {
	const hashes: Record<string, string> = {};
	const walk = (path: string) => {
		if (!existsSync(path)) return;
		if (statSync(path).isDirectory()) {
			for (const name of readdirSync(path)) walk(join(path, name));
			return;
		}
		hashes[relative(gitDir, path)] = createHash("sha256")
			.update(readFileSync(path))
			.digest("hex");
	};
	for (const name of ["index", "objects", "refs", "packed-refs", "HEAD"])
		walk(join(gitDir, name));
	return hashes;
}

const lines = (count: number, label: string) =>
	Array.from({ length: count }, (_, index) => `${label} ${index}`).join("\n");

describe("Session diff through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	let artifact = "f02e9-2-session-diff";

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		const root = realpathSync(fixture.root);
		try {
			await fixture.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/${artifact}.json`,
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			evidence = {};
			vi.unstubAllEnvs();
		}
	});

	it("lists unstaged files with blob pairs and tiers, serves only listed patches, and leaves the repository untouched", async () => {
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			managedOpenCode: true,
			claudeReplay: { turns: ["pong-thinking-text-turn"], delayMs: 0 },
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		git(repo, "init", "-b", "main");
		writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
		writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "staged.txt"), "a\n");
		writeFileSync(join(repo, "doomed.txt"), "bye\n");
		writeFileSync(join(repo, "long.txt"), `${lines(600, "old")}\n`);
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Diff test",
			"-c",
			"user.email=diff@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		writeFileSync(join(repo, "staged.txt"), "staged only\n");
		git(repo, "add", "staged.txt");
		writeFileSync(join(repo, "tracked.txt"), "one\nTWO\n");
		rmSync(join(repo, "doomed.txt"));
		writeFileSync(join(repo, "long.txt"), `${lines(600, "new")}\n`);
		writeFileSync(join(repo, "fresh.txt"), "hello\n");
		writeFileSync(join(repo, "ignored.log"), "noise\n");
		writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
		writeFileSync(join(repo, "huge.txt"), "x".repeat(1_200_000));
		const gitDir = join(repo, ".git");
		const before = repositoryBytes(gitDir);

		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		const sessionId = await (await fixture.connect()).createSession("Diff");
		const scope = { kind: "unstaged" } as const;
		const list = () =>
			sendRpcRequest(socket, { _tag: "SessionDiffList", sessionId, scope });

		const [listing, concurrent] = await Promise.all([list(), list()]);
		expect(concurrent.revision).toBe(listing.revision);
		const [folder] = listing.folders;
		if (!folder || !("files" in folder)) throw new Error("Missing folder");
		expect(folder.folder).toBe(repo);
		const files = Object.fromEntries(
			folder.files.map((file) => [file.path, file]),
		);
		evidence["files"] = folder.files;
		expect(Object.keys(files).sort()).toEqual([
			"doomed.txt",
			"fresh.txt",
			"huge.txt",
			"logo.bin",
			"long.txt",
			"tracked.txt",
		]);
		expect(files["tracked.txt"]).toEqual({
			path: "tracked.txt",
			status: "modified",
			before: git(repo, "rev-parse", ":tracked.txt"),
			after: git(repo, "hash-object", "tracked.txt"),
			bytes: 8,
			tier: "auto",
			insertions: 1,
			deletions: 1,
			binary: false,
		});
		expect(files["fresh.txt"]).toMatchObject({
			status: "added",
			before: null,
			tier: "auto",
			insertions: 1,
		});
		expect(files["doomed.txt"]).toMatchObject({
			status: "deleted",
			after: null,
			deletions: 1,
		});
		expect(files["logo.bin"]).toMatchObject({ binary: true, tier: "auto" });
		expect(files["long.txt"]).toMatchObject({
			tier: "onDemand",
			insertions: 600,
			deletions: 600,
		});
		expect(files["huge.txt"]).toEqual({
			path: "huge.txt",
			status: "added",
			before: null,
			after: git(repo, "hash-object", "huge.txt"),
			bytes: 1_200_000,
			tier: "tooLarge",
		});

		const request = (path: string, overrides: object = {}) => {
			const file = files[path];
			return sendRpcRequest(socket, {
				_tag: "SessionDiffFile",
				sessionId,
				scope,
				revision: listing.revision,
				folder: repo,
				path,
				before: file?.before ?? null,
				after: file?.after ?? null,
				...overrides,
			});
		};
		const { patch } = await request("tracked.txt");
		evidence["trackedPatch"] = patch;
		expect(patch).toContain("-two\n+TWO\n");

		const refusals = {
			unlisted: await request("staged.txt", {
				before: git(repo, "rev-parse", "HEAD:staged.txt"),
				after: git(repo, "rev-parse", ":staged.txt"),
			}).catch((error: unknown) => error),
			forgedPair: await request("tracked.txt", {
				after: files["tracked.txt"]?.before,
			}).catch((error: unknown) => error),
			tooLarge: await request("huge.txt").catch((error: unknown) => error),
			unknownRevision: await request("tracked.txt", {
				revision: "forged",
			}).catch((error: unknown) => error),
		};
		evidence["refusals"] = Object.fromEntries(
			Object.entries(refusals).map(([name, error]) => [
				name,
				(error as { reason?: string }).reason,
			]),
		);
		expect(evidence["refusals"]).toEqual({
			unlisted: "not-listed",
			forgedPair: "not-listed",
			tooLarge: "too-large",
			unknownRevision: "gone",
		});

		// Collect every snapshot object, as the store's grace-period GC would.
		const stores = join(fixture.configDir, "folder-timeline");
		for (const store of readdirSync(stores))
			git(join(stores, store), "prune", "--expire=now");
		const collected = await request("tracked.txt").catch(
			(error: unknown) => error,
		);
		evidence["afterCollection"] = (collected as { reason?: string }).reason;
		expect(evidence["afterCollection"]).toBe("gone");
		const relisted = await list();
		const relistedFolder = relisted.folders[0];
		if (!relistedFolder || !("files" in relistedFolder))
			throw new Error("Missing relisted folder");
		expect(relistedFolder.files).toEqual(folder.files);
		const again = await sendRpcRequest(socket, {
			_tag: "SessionDiffFile",
			sessionId,
			scope,
			revision: relisted.revision,
			folder: repo,
			path: "tracked.txt",
			before: files["tracked.txt"]?.before ?? null,
			after: files["tracked.txt"]?.after ?? null,
		});
		expect(again.patch).toBe(patch);

		const after = repositoryBytes(gitDir);
		evidence["repositoryFiles"] = Object.keys(before).length;
		evidence["repositoryUnchanged"] =
			JSON.stringify(after) === JSON.stringify(before);
		expect(after).toEqual(before);
	});

	it("opens a live scope on every device at one revision and pushes an external edit to all of them as one listable revision", async () => {
		artifact = "f02e9-3-live-session-diff";
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			managedOpenCode: true,
			claudeReplay: { turns: ["pong-thinking-text-turn"], delayMs: 0 },
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		git(repo, "init", "-b", "main");
		writeFileSync(join(repo, "tracked.txt"), "one\n");
		writeFileSync(join(repo, "steady.txt"), "steady\n");
		git(repo, "add", ".");
		git(
			repo,
			"-c",
			"user.name=Diff test",
			"-c",
			"user.email=diff@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-m",
			"Initial commit",
		);
		writeFileSync(join(repo, "steady.txt"), "steady edit\n");

		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		const first = await fixture.connect();
		const devices = [first, await fixture.connect()];
		const sessionId = await first.createSession("Live diff");
		const scope = { kind: "unstaged" } as const;
		const feeds = await Promise.all(
			devices.map(async (browser) => {
				const revisions = await Effect.runPromise(Queue.unbounded<string>());
				const fiber = Effect.runFork(
					Stream.runForEach(
						browser.rpc.SubscribeSessionDiff({ sessionId, scope }),
						({ revision }) => Queue.offer(revisions, revision),
					),
				);
				return { fiber, next: () => Effect.runPromise(Queue.take(revisions)) };
			}),
		);
		const next = () => Promise.all(feeds.map((feed) => feed.next()));

		// Each device's first revision proves its subscription is live.
		const opened = await next();
		writeFileSync(join(repo, "tracked.txt"), "one\nTWO\n");
		const pushed = await next();
		await Effect.runPromise(
			Fiber.interruptAll(feeds.map(({ fiber }) => fiber)),
		);
		evidence["revisions"] = { opened, pushed };
		expect(new Set(opened).size).toBe(1);
		expect(new Set(pushed).size).toBe(1);
		expect(pushed[0]).not.toBe(opened[0]);

		const list = (revision: string | undefined) =>
			sendRpcRequest(socket, {
				_tag: "SessionDiffList",
				sessionId,
				scope,
				...(revision === undefined ? {} : { revision }),
			});
		const pairs = async (revision: string | undefined) => {
			const listing = await list(revision);
			expect(listing.revision).toBe(revision);
			return Object.fromEntries(
				listing.folders.flatMap((entry) =>
					"files" in entry
						? entry.files.map((file) => [file.path, file.after])
						: [],
				),
			);
		};
		evidence["pairs"] = {
			opened: await pairs(opened[0]),
			pushed: await pairs(pushed[0]),
		};
		expect(evidence["pairs"]).toEqual({
			opened: { "steady.txt": git(repo, "hash-object", "steady.txt") },
			pushed: {
				"steady.txt": git(repo, "hash-object", "steady.txt"),
				"tracked.txt": git(repo, "hash-object", "tracked.txt"),
			},
		});
	});
});
