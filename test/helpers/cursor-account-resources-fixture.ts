import { createHash } from "node:crypto";
import { Effect, Redacted } from "effect";
import { AccountIdSchema } from "../../src/lib/contracts/account.js";
import type { CursorAccountResources } from "../../src/lib/provider/cursor/cursor-account-resources.js";
import { makeCursorAuth } from "../../src/lib/provider/cursor/cursor-auth.js";
import {
	CursorCredentialFingerprint,
	type CursorCredentialLookup,
	cursorBackendUrl,
} from "../../src/lib/provider/cursor/cursor-credential.js";
import type { CursorSdkPort } from "../../src/lib/provider/cursor/sdk-port.js";

export const cursorCredentialFixture = (
	key = "[REDACTED]",
	source: "environment" | "sdk-login" = "sdk-login",
	backendUrl = "https://api2.cursor.sh",
) => ({
	source,
	fingerprint: CursorCredentialFingerprint.make(
		createHash("sha256")
			.update(JSON.stringify([source, cursorBackendUrl(backendUrl), key]))
			.digest("hex"),
	),
	backendUrl: cursorBackendUrl(backendUrl),
	apiKey: Redacted.make(key),
});

/** Injects already resolved credentials; account resolution is tested through the daemon. */
export const cursorAccountResourcesFixture = (
	port: CursorSdkPort | ((id: string) => CursorSdkPort),
	lookup: CursorCredentialLookup | ((id: string) => CursorCredentialLookup) = {
		_tag: "Ready",
		credential: cursorCredentialFixture(),
	},
): CursorAccountResources["Service"] => ({
	backendUrl: cursorBackendUrl("https://api2.cursor.sh"),
	use: (selected, work) =>
		Effect.scoped(
			Effect.gen(function* () {
				const id = typeof selected === "string" ? selected : "";
				const sdk = typeof port === "function" ? port(id) : port;
				const credential = Effect.succeed(
					typeof lookup === "function" ? lookup(id) : lookup,
				);
				const auth = yield* makeCursorAuth(() => Effect.void, {
					port: sdk,
					credential,
				});
				return yield* work({
					owner:
						typeof selected === "string"
							? {
									_tag: "Account",
									account: {
										driver: "cursor",
										id: AccountIdSchema.make(id),
										name: id,
										usageEligible: false,
									},
									launchEnv: false,
								}
							: selected,
					sdk,
					auth,
					credential,
				});
			}),
		),
});
