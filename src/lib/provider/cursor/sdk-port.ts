export interface CursorModel {
	readonly id: string;
	readonly displayName: string;
}

export type CursorAuthStatus =
	| { readonly status: "logged-out" }
	| {
			readonly status: "logged-in";
			readonly backendUrl: string;
			readonly email?: string;
			readonly apiKeyExpiresAtMs?: number;
	  };

export interface CursorStoredCredential {
	readonly apiKey: string;
	readonly backendUrl: string;
	readonly createdAtMs: number;
	readonly apiKeyExpiresAtMs?: number;
}

export interface CursorCredential {
	readonly source: "environment" | "sdk-login";
	readonly fingerprint: string;
	readonly apiKey: string;
	readonly backendUrl?: string;
}

export interface CursorRuntimeProbe {
	readonly available: boolean;
	readonly reason?: string;
}

// All Cursor SDK operations cross this boundary, in either daemon or runner.
// Extend the real adapter and trace player together when adding an operation.
export interface CursorSdkPort {
	readonly replay?: true;
	probeRuntime(): Promise<CursorRuntimeProbe>;
	authStatus(): Promise<CursorAuthStatus>;
	storedCredential(): Promise<CursorStoredCredential | undefined>;
	modelsList(credential: CursorCredential): Promise<readonly CursorModel[]>;
}
