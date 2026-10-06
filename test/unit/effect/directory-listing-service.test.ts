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
