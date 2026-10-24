import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	DirectoryListingServiceLive,
	DirectoryListingServiceTag,
} from "../../../src/lib/domain/relay/Services/directory-listing-service.js";

const tempDirectory = Effect.acquireRelease(
	Effect.tryPromise({
		try: () => mkdtemp(join(tmpdir(), "conduit-dir-list-")),
		catch: (cause) => cause,
	}),
	(path) =>
		Effect.orDie(
			Effect.tryPromise({
				try: () => rm(path, { recursive: true, force: true }),
				catch: (cause) => cause,
			}),
		),
);

const tryFs = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({
		try: operation,
		catch: (cause) => cause,
	});

describe("DirectoryListingService", () => {
	const match = (path: string, exists = true) => ({
		path,
		isGitRepo: false,
		reason: "match",
		exists,
	});

	it.effect(
		"matches visible directories by prefix and keeps a missing path last",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() => mkdir(join(root, "work")));
				yield* tryFs(() => mkdir(join(root, "workspace")));
				yield* tryFs(() => mkdir(join(root, "tmp")));
				yield* tryFs(() => writeFile(join(root, "word.txt"), "file"));

				const service = yield* DirectoryListingServiceTag;

				expect(yield* service.find(`${root}/wo`)).toEqual({
					home: homedir(),
					entries: [
						match(`${root}/work`),
						match(`${root}/workspace`),
						match(`${root}/wo`, false),
					],
				});
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"lists every child directory, following symlinks to directories",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				const names = Array.from(
					{ length: 60 },
					(_, index) => `dir-${String(index).padStart(2, "0")}`,
				);
				yield* Effect.forEach(names, (name) =>
					tryFs(() => mkdir(join(root, name))),
				);
				yield* tryFs(() => writeFile(join(root, "notes.txt"), "file"));
				yield* tryFs(() => symlink(join(root, "dir-00"), join(root, "linked")));
				yield* tryFs(() =>
					symlink(join(root, "notes.txt"), join(root, "linked-file")),
				);
				yield* tryFs(() =>
					symlink(join(root, "missing"), join(root, "linked-missing")),
				);

				const service = yield* DirectoryListingServiceTag;

				expect(yield* service.find(`${root}/`)).toEqual({
					home: homedir(),
					entries: [
						match(root),
						...names.map((name) => match(`${root}/${name}`)),
						match(`${root}/linked`),
					],
				});
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"shows hidden directories only when the prefix starts with a dot",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() => mkdir(join(root, ".cache")));
				yield* tryFs(() => mkdir(join(root, "cache")));

				const service = yield* DirectoryListingServiceTag;

				expect(yield* service.find(`${root}/`)).toEqual({
					home: homedir(),
					entries: [match(root), match(`${root}/cache`)],
				});
				expect(yield* service.find(`${root}/.c`)).toEqual({
					home: homedir(),
					entries: [match(`${root}/.cache`), match(`${root}/.c`, false)],
				});
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"reads branches from repository HEAD files, including relative and absolute gitdir pointers",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() =>
					mkdir(join(root, "repo", ".git"), { recursive: true }),
				);
				yield* tryFs(() =>
					writeFile(
						join(root, "repo", ".git", "HEAD"),
						"ref: refs/heads/feature/browse\n",
					),
				);
				yield* tryFs(() => mkdir(join(root, "git-data")));
				yield* tryFs(() =>
					writeFile(join(root, "git-data", "HEAD"), "ref: refs/heads/main\n"),
				);
				for (const [name, gitdir] of [
					["relative", "../git-data"],
					["absolute", join(root, "git-data")],
				] as const) {
					yield* tryFs(() => mkdir(join(root, name)));
					yield* tryFs(() =>
						writeFile(join(root, name, ".git"), `gitdir: ${gitdir}\n`),
					);
				}

				const service = yield* DirectoryListingServiceTag;
				const listing = yield* service.find(`${root}/`);
				expect(
					listing.entries.find((entry) => entry.path === join(root, "repo")),
				).toMatchObject({
					isGitRepo: true,
					branch: "feature/browse",
				});
				for (const name of ["relative", "absolute"]) {
					expect(
						listing.entries.find((entry) => entry.path === join(root, name)),
					).toMatchObject({
						isGitRepo: true,
						branch: "main",
					});
				}
				expect((yield* service.find(`${root}/repo/`)).entries[0]).toMatchObject(
					{
						path: join(root, "repo"),
						branch: "feature/browse",
					},
				);
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	// Metadata can fail through detached or missing HEAD, a non-branch ref, a
	// malformed gitdir pointer, unreadable metadata, deep repos, zero repos,
	// or the 500-entry scan bound. None may fail the directory listing.
	it.effect(
		"omits branches for detached HEAD, non-branch refs, missing HEAD and invalid gitdir files",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				for (const [name, head] of [
					["detached", "1234567890abcdef\n"],
					["tag", "ref: refs/tags/v1\n"],
					["missing", ""],
				] as const) {
					yield* tryFs(() =>
						mkdir(join(root, name, ".git"), { recursive: true }),
					);
					if (head)
						yield* tryFs(() =>
							writeFile(join(root, name, ".git", "HEAD"), head),
						);
				}
				for (const [name, pointer] of [
					["invalid", "not a gitdir pointer\n"],
					["broken", "gitdir: ../absent\n"],
				] as const) {
					yield* tryFs(() => mkdir(join(root, name)));
					yield* tryFs(() => writeFile(join(root, name, ".git"), pointer));
				}
				yield* tryFs(() =>
					mkdir(join(root, "unreadable", ".git", "HEAD"), { recursive: true }),
				);
				const service = yield* DirectoryListingServiceTag;
				const listing = yield* service.find(`${root}/`);
				expect(listing.entries).toHaveLength(7);
				for (const entry of listing.entries.slice(1)) {
					expect(entry.isGitRepo).toBe(true);
					expect(entry).not.toHaveProperty("branch");
					expect(entry).not.toHaveProperty("repoCount");
				}
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"counts only immediate repositories in non-repo folders and omits zero counts",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() =>
					mkdir(join(root, "collection", "first", ".git"), { recursive: true }),
				);
				yield* tryFs(() => mkdir(join(root, "collection", "second")));
				yield* tryFs(() =>
					writeFile(
						join(root, "collection", "second", ".git"),
						"gitdir: ../missing\n",
					),
				);
				yield* tryFs(() =>
					mkdir(join(root, "collection", "deep", "nested", ".git"), {
						recursive: true,
					}),
				);
				yield* tryFs(() => mkdir(join(root, "empty")));
				yield* tryFs(() =>
					writeFile(join(root, "collection", "notes.txt"), "file"),
				);
				const service = yield* DirectoryListingServiceTag;
				const listing = yield* service.find(`${root}/`);
				expect(
					listing.entries.find(
						(entry) => entry.path === join(root, "collection"),
					),
				).toMatchObject({
					isGitRepo: false,
					repoCount: 2,
				});
				expect(
					listing.entries.find((entry) => entry.path === join(root, "empty")),
				).not.toHaveProperty("repoCount");
				expect(listing.entries[0]).not.toHaveProperty("repoCount");
				expect(
					(yield* service.find(`${root}/collection/`)).entries[0],
				).toMatchObject({
					repoCount: 2,
				});
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect("omits repository counts when a child metadata read fails", () =>
		Effect.gen(function* () {
			const root = yield* tempDirectory;
			yield* tryFs(() =>
				mkdir(join(root, "collection", "repo", ".git"), { recursive: true }),
			);
			yield* tryFs(() => mkdir(join(root, "collection", "broken")));
			yield* tryFs(() =>
				symlink(".git", join(root, "collection", "broken", ".git")),
			);
			const service = yield* DirectoryListingServiceTag;
			const listing = yield* service.find(`${root}/`);
			expect(
				listing.entries.find(
					(entry) => entry.path === join(root, "collection"),
				),
			).toEqual(match(join(root, "collection")));
		}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"counts repositories at the 500-entry limit and omits counts above it",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() =>
					mkdir(join(root, "collection", "repo", ".git"), { recursive: true }),
				);
				yield* Effect.forEach(
					Array.from({ length: 499 }, (_, index) => index),
					(index) =>
						tryFs(() =>
							writeFile(join(root, "collection", `file-${index}`), ""),
						),
					{ concurrency: 16 },
				);
				const service = yield* DirectoryListingServiceTag;
				expect(
					(yield* service.find(`${root}/`)).entries.find(
						(entry) => entry.path === join(root, "collection"),
					),
				).toMatchObject({ repoCount: 1 });
				yield* tryFs(() => writeFile(join(root, "collection", "extra"), ""));
				expect(
					(yield* service.find(`${root}/`)).entries.find(
						(entry) => entry.path === join(root, "collection"),
					),
				).not.toHaveProperty("repoCount");
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"offers a missing path as a new folder when its parent is missing",
		() =>
			Effect.gen(function* () {
				const service = yield* DirectoryListingServiceTag;

				expect(yield* service.find("/definitely/missing/conduit-path")).toEqual(
					{
						home: homedir(),
						entries: [match("/definitely/missing/conduit-path", false)],
					},
				);
			}).pipe(Effect.provide(DirectoryListingServiceLive)),
	);
});
