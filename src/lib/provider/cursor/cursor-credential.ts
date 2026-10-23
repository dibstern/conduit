import { createHash } from "node:crypto";
import { Redacted, Schema } from "effect";
import type { CursorAccount } from "../../contracts/account.js";
import type { CursorStoredCredential } from "./sdk-port.js";

export const CursorBackendUrl = Schema.String.pipe(
	Schema.brand("CursorBackendUrl"),
);
export type CursorBackendUrl = typeof CursorBackendUrl.Type;
export const cursorBackendUrl = (url: string): CursorBackendUrl =>
	CursorBackendUrl.make(url.replace(/\/+$/, ""));

export const CursorCredentialFingerprint = Schema.String.pipe(
	Schema.brand("CursorCredentialFingerprint"),
);
export type CursorCredentialFingerprint =
	typeof CursorCredentialFingerprint.Type;

export type CursorCredentialOwner =
	| {
			readonly _tag: "Account";
			readonly account: CursorAccount;
			readonly launchEnv: boolean;
	  }
	| { readonly _tag: "LoginSlot" };

export const CursorCredentialEnvelope = Schema.Struct({
	fingerprint: CursorCredentialFingerprint,
	backendUrl: CursorBackendUrl,
	apiKey: Schema.Redacted(Schema.String),
});
export type CursorCredentialEnvelope = typeof CursorCredentialEnvelope.Type;
export type CursorCredential = CursorCredentialEnvelope & {
	readonly source: "environment" | "sdk-login";
	readonly email?: string;
	readonly apiKeyExpiresAtMs?: number;
};

export type CursorCredentialLookup =
	| { readonly _tag: "Ready"; readonly credential: CursorCredential }
	| { readonly _tag: "LoggedOut" }
	| { readonly _tag: "Expired" }
	| {
			readonly _tag: "OtherBackend";
			readonly loginBackendUrl: CursorBackendUrl;
			readonly activeBackendUrl: CursorBackendUrl;
	  };

export function resolveCursorCredential(
	envKey: string | undefined,
	stored: CursorStoredCredential | undefined,
	activeBackend: CursorBackendUrl,
	now: number,
): CursorCredentialLookup {
	const environmentKey = envKey?.trim();
	if (!environmentKey) {
		if (!stored?.apiKey) return { _tag: "LoggedOut" };
		if (
			stored.apiKeyExpiresAtMs !== undefined &&
			stored.apiKeyExpiresAtMs <= now
		)
			return { _tag: "Expired" };
		const loginBackendUrl = cursorBackendUrl(stored.backendUrl);
		if (loginBackendUrl !== activeBackend)
			return {
				_tag: "OtherBackend",
				loginBackendUrl,
				activeBackendUrl: activeBackend,
			};
	}
	const apiKey = environmentKey || stored?.apiKey;
	if (!apiKey) return { _tag: "LoggedOut" };
	const source = environmentKey ? "environment" : "sdk-login";
	return {
		_tag: "Ready",
		credential: Object.freeze({
			source,
			fingerprint: CursorCredentialFingerprint.make(
				createHash("sha256")
					.update(JSON.stringify([source, activeBackend, apiKey]))
					.digest("hex"),
			),
			backendUrl: activeBackend,
			apiKey: Redacted.make(apiKey),
			...(!environmentKey && stored
				? {
						...(stored.email === undefined ? {} : { email: stored.email }),
						...(stored.apiKeyExpiresAtMs === undefined
							? {}
							: { apiKeyExpiresAtMs: stored.apiKeyExpiresAtMs }),
					}
				: {}),
		}),
	};
}

export function cursorCredentialMessage(
	lookup: Exclude<CursorCredentialLookup, { _tag: "Ready" }>,
): string {
	switch (lookup._tag) {
		case "LoggedOut":
			return "Cursor authentication required. Log in to Cursor in Settings.";
		case "Expired":
			return "Cursor login has expired. Log in to Cursor in Settings.";
		case "OtherBackend":
			return `Cursor login is for ${lookup.loginBackendUrl}, but the active backend is ${lookup.activeBackendUrl}. Log in to Cursor in Settings. Logging in replaces the stored login for ${lookup.loginBackendUrl}.`;
	}
}
