import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Option } from "effect";
import { AccountPicture } from "../Services/account-picture.js";
import { Subprocess, type SubprocessService } from "../Services/subprocess.js";

const readMacPicture = (subprocess: SubprocessService) =>
	Effect.gen(function* () {
		const filesystem = <A>(operation: () => Promise<A>) =>
			Effect.tryPromise(operation);
		// JPEGPhoto is ~800 KB of hex, so a busy daemon needs seconds to drain it.
		const command = (file: string, args: string[]) =>
			subprocess
				.run(file, args, {
					timeoutMs: 15_000,
					maxBuffer: 16 * 1024 * 1024,
				})
				.pipe(
					Effect.flatMap((result) =>
						result.exitCode === 0
							? Effect.succeed(result)
							: Effect.fail(
									new Error(
										`${file} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
									),
								),
					),
				);
		const account = yield* Effect.try(() => `/Users/${userInfo().username}`);
		// Failed reads must not fall through to the stock Picture image.
		const { stdout } = yield* command("/usr/bin/dscl", [
			".",
			"-read",
			account,
			"JPEGPhoto",
		]);
		const hex = stdout.replace(/^JPEGPhoto:\s*/, "").replace(/[\s<>]/g, "");
		let source: Uint8Array | undefined =
			hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)
				? Buffer.from(hex, "hex")
				: undefined;
		if (!source) {
			const { stdout } = yield* command("/usr/bin/dscl", [
				".",
				"-read",
				account,
				"Picture",
			]);
			const picturePath = stdout
				.replace(/^Picture:\s*/, "")
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.startsWith("/"));
			if (
				!picturePath ||
				(yield* filesystem(() => stat(picturePath))).size > 16 * 1024 * 1024
			)
				return Option.none();
			source = yield* filesystem(() => readFile(picturePath));
		}
		const bytes = source;
		return yield* Effect.acquireUseRelease(
			filesystem(() => mkdtemp(join(tmpdir(), "conduit-avatar-"))),
			(directory) =>
				Effect.gen(function* () {
					const input = join(directory, "account-picture");
					const output = join(directory, "avatar.jpg");
					yield* filesystem(() => writeFile(input, bytes, { mode: 0o600 }));
					yield* command("/usr/bin/sips", [
						"-s",
						"format",
						"jpeg",
						"-s",
						"formatOptions",
						"75",
						"-Z",
						"160",
						input,
						"--out",
						output,
					]);
					if ((yield* filesystem(() => stat(output))).size > 128 * 1024)
						return Option.none();
					const resized = yield* filesystem(() => readFile(output));
					return resized[0] === 0xff && resized[1] === 0xd8
						? Option.some(resized)
						: Option.none();
				}),
			(directory) =>
				filesystem(() => rm(directory, { recursive: true, force: true })).pipe(
					Effect.orDie,
				),
		);
	}).pipe(
		Effect.mapError(
			(cause) => new Error("Couldn't read the Mac account picture", { cause }),
		),
	);

export const AccountPictureNone = Layer.succeed(AccountPicture, {
	read: Effect.succeed(Option.none()),
});

export const AccountPictureLive =
	process.platform === "darwin"
		? Layer.effect(
				AccountPicture,
				// The lookup takes seconds on a busy daemon, so every tab shares one
				// read for ten minutes (late enough to notice a new picture). Failures
				// aren't kept: the next caller tries again.
				Effect.gen(function* () {
					const subprocess = yield* Subprocess;
					const read = yield* Effect.cachedWithTTL(
						readMacPicture(subprocess),
						(exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
					);
					return AccountPicture.of({ read });
				}),
			)
		: AccountPictureNone;
