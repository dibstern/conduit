import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Effect, Schema } from "effect";

export interface CursorUsageToken {
	readonly token: string;
	readonly subjectHash?: string;
}

export type CursorKeychainRead =
	| { readonly credential: CursorUsageToken; readonly reason?: never }
	| { readonly credential?: never; readonly reason: string };

const missing =
	"The Cursor CLI isn't signed in on this Mac. Run cursor-agent login, then try again.";
const denied = "Keychain access was denied. Allow access, then try again.";
export const cursorKeychainTimeout =
	"Timed out waiting for Keychain access. Try again.";
export const cursorKeychainUnsupported =
	"Keychain usage is only available on macOS. Set CURSOR_AUTH_TOKEN instead.";

export function cursorUsageToken(
	token: string,
	subjectHash?: string,
): CursorUsageToken {
	const credential = {
		...(subjectHash ? { subjectHash } : {}),
	} as CursorUsageToken;
	Object.defineProperty(credential, "token", {
		value: token,
		enumerable: false,
	});
	return Object.freeze(credential);
}

const SubjectSchema = Schema.Struct({ sub: Schema.String });

function decodeToken(token: string): CursorKeychainRead {
	const payload = token.split(".")[1];
	const subject = payload
		? Schema.decodeUnknownOption(Schema.fromJsonString(SubjectSchema))(
				Buffer.from(payload, "base64url").toString("utf8"),
			)
		: undefined;
	if (!subject || subject._tag === "None" || !subject.value.sub.trim()) {
		return {
			reason:
				"The Cursor CLI login could not be read. Sign in again, then try again.",
		};
	}
	return {
		credential: cursorUsageToken(
			token,
			createHash("sha256").update(subject.value.sub).digest("hex"),
		),
	};
}

const FakeKeychainSchema = Schema.Struct({
	token: Schema.optional(Schema.String),
	outcome: Schema.optional(Schema.Literals(["missing", "denied"])),
	delayMs: Schema.optional(Schema.Number),
	reads: Schema.optional(Schema.Number),
});

const readFakeKeychain = (path: string): Effect.Effect<CursorKeychainRead> =>
	Effect.tryPromise({
		try: async () => {
			const contents = await readFile(path, "utf8");
			const fixture = Schema.decodeUnknownSync(
				Schema.fromJsonString(FakeKeychainSchema),
			)(contents);
			await writeFile(
				path,
				JSON.stringify({ ...fixture, reads: (fixture.reads ?? 0) + 1 }),
				{ mode: 0o600 },
			);
			return fixture;
		},
		catch: () => ({ reason: "The Cursor CLI login could not be read." }),
	}).pipe(
		Effect.flatMap((fixture) =>
			Effect.sleep(Math.max(0, fixture.delayMs ?? 0)).pipe(
				Effect.as(
					fixture.outcome === "denied"
						? { reason: denied }
						: fixture.outcome === "missing" || !fixture.token?.trim()
							? { reason: missing }
							: decodeToken(fixture.token.trim()),
				),
			),
		),
		Effect.catch((failure) => Effect.succeed(failure)),
	);

/** The real adapter must never reach the login Keychain from a test process. */
export const readCursorKeychain = (
	env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<CursorKeychainRead> =>
	Effect.suspend((): Effect.Effect<CursorKeychainRead> => {
		if (process.env["NODE_ENV"] === "test" || env["NODE_ENV"] === "test") {
			return Effect.succeed({
				reason: "The real Keychain is unavailable in tests.",
			});
		}
		if (process.platform !== "darwin")
			return Effect.succeed({ reason: cursorKeychainUnsupported });
		return Effect.callback<CursorKeychainRead>((resume) => {
			const child = execFile(
				"/usr/bin/security",
				[
					"find-generic-password",
					"-s",
					"cursor-access-token",
					"-a",
					"cursor-user",
					"-w",
				],
				{ timeout: 60_000, maxBuffer: 64 * 1024 },
				(error, stdout) => {
					resume(
						Effect.succeed(
							error
								? {
										reason: error.killed
											? cursorKeychainTimeout
											: error.code === 44
												? missing
												: denied,
									}
								: decodeToken(stdout.trim()),
						),
					);
				},
			);
			return Effect.sync(() => child.kill());
		});
	});

export function makeCursorKeychain(
	env: Readonly<Record<string, string | undefined>>,
) {
	const fixture =
		env["NODE_ENV"] === "test"
			? env["CONDUIT_TEST_CURSOR_KEYCHAIN"]?.trim()
			: undefined;
	return {
		supported: process.platform === "darwin" || fixture !== undefined,
		read: fixture ? readFakeKeychain(fixture) : readCursorKeychain(env),
	};
}
