import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
	it.effect(
		"lists matching visible directories and preserves the requested path",
		() =>
			Effect.gen(function* () {
				const root = yield* tempDirectory;
				yield* tryFs(() => mkdir(join(root, "work")));
				yield* tryFs(() => mkdir(join(root, "workspace")));
				yield* tryFs(() => mkdir(join(root, "tmp")));
				yield* tryFs(() => writeFile(join(root, "word.txt"), "file"));

				const service = yield* DirectoryListingServiceTag;
				const requestedPath = `${root}/wo`;
				const result = yield* service.list(requestedPath);

				expect(result).toEqual({
					path: requestedPath,
					entries: [`${root}/work/`, `${root}/workspace/`],
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

				expect(yield* service.list(`${root}/`)).toEqual({
					path: `${root}/`,
					entries: [`${root}/cache/`],
				});
				expect(yield* service.list(`${root}/.`)).toEqual({
					path: `${root}/.`,
					entries: [`${root}/.cache/`],
				});
			}).pipe(Effect.scoped, Effect.provide(DirectoryListingServiceLive)),
	);

	it.effect(
		"returns an empty list when the parent directory cannot be read",
		() =>
			Effect.gen(function* () {
				const service = yield* DirectoryListingServiceTag;

				const result = yield* service.list("/definitely/missing/conduit-path");

				expect(result).toEqual({
					path: "/definitely/missing/conduit-path",
					entries: [],
				});
			}).pipe(Effect.provide(DirectoryListingServiceLive)),
	);
});
