import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Exit, Layer, Option } from "effect";
import { AccountPicture } from "../Services/account-picture.js";

const execFileAsync = promisify(execFile);
// JPEGPhoto is ~800 KB of hex drained one event-loop tick per pipe chunk, so a
// busy daemon (startup) needs seconds to read it.
const command = (file: string, args: string[]) =>
	execFileAsync(file, args, {
		timeout: 15_000,
		maxBuffer: 16 * 1024 * 1024,
		encoding: "utf8",
	});

async function readMacPicture(): Promise<Option.Option<Uint8Array>> {
	const account = `/Users/${userInfo().username}`;
	// A failed read must not fall through: Picture is often a stock image that
	// JPEGPhoto overrides. Only an absent JPEGPhoto ("No such key") falls back.
	const bytes = await command("/usr/bin/dscl", [
		".",
		"-read",
		account,
		"JPEGPhoto",
	]).then(({ stdout }) => {
		const hex = stdout.replace(/^JPEGPhoto:\s*/, "").replace(/[\s<>]/g, "");
		return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)
			? Buffer.from(hex, "hex")
			: undefined;
	});
	let source = bytes;
	if (!source) {
		const { stdout } = await command("/usr/bin/dscl", [
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
		if (!picturePath || (await stat(picturePath)).size > 16 * 1024 * 1024)
			return Option.none();
		source = await readFile(picturePath);
	}
	const directory = await mkdtemp(join(tmpdir(), "conduit-avatar-"));
	try {
		const input = join(directory, "account-picture");
		const output = join(directory, "avatar.jpg");
		await writeFile(input, source, { mode: 0o600 });
		await command("/usr/bin/sips", [
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
		if ((await stat(output)).size > 128 * 1024) return Option.none();
		const resized = await readFile(output);
		return resized[0] === 0xff && resized[1] === 0xd8
			? Option.some(resized)
			: Option.none();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

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
				Effect.cachedWithTTL(
					Effect.tryPromise({
						try: readMacPicture,
						catch: (cause) =>
							new Error("Couldn't read the Mac account picture", { cause }),
					}),
					(exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
				).pipe(Effect.map((read) => AccountPicture.of({ read }))),
			)
		: AccountPictureNone;
