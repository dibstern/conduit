export interface CursorModel {
	readonly id: string;
	readonly displayName: string;
	readonly parameters?:
		| readonly {
				readonly id: string;
				readonly displayName?: string | undefined;
				readonly values: readonly {
					readonly value: string;
					readonly displayName?: string | undefined;
				}[];
		  }[]
		| undefined;
	readonly variants?:
		| readonly {
				readonly params: readonly CursorModelParameter[];
				readonly displayName: string;
				readonly isDefault?: boolean | undefined;
		  }[]
		| undefined;
}

export interface CursorModelParameter {
	readonly id: string;
	readonly value: string;
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

export interface CursorAgentOptions {
	readonly cwd: string;
	readonly dirs: readonly string[];
	readonly settingSources: readonly (
		| "project"
		| "user"
		| "team"
		| "mdm"
		| "plugins"
	)[];
	readonly storePath: string;
	readonly sandboxOptions: { readonly enabled: boolean };
	readonly autoReview: boolean;
	readonly tools: readonly string[];
	readonly disallowedTools: readonly string[];
	readonly customToolNames: readonly string[];
	readonly subagentInherit: { readonly reportedWorkspacePath: string };
	readonly credentialFingerprint: string;
}

export interface CursorSendOptions {
	readonly model: {
		readonly id: string;
		readonly params?: readonly CursorModelParameter[];
	};
	readonly mode: "agent" | "plan";
	readonly local?: { readonly force: true };
}

export interface CursorPersistedRun {
	readonly runId: string;
	readonly status:
		| "queued"
		| "running"
		| "finished"
		| "error"
		| "cancelled"
		| "expired";
	readonly requestId?: string | null;
	readonly startedAt?: number | null;
}

export interface CursorCustomTool {
	readonly description: string;
	readonly inputSchema: Record<string, CursorJsonValue>;
	readonly execute: (
		args: Readonly<Record<string, unknown>>,
		context: { readonly toolCallId?: string; readonly sessionId?: string },
	) => Promise<string>;
}

type CursorJsonValue =
	| string
	| number
	| boolean
	| null
	| CursorJsonValue[]
	| { [key: string]: CursorJsonValue };

export interface CursorStore {
	dispose(): Promise<void>;
}

export interface CursorRun {
	readonly id: string;
	readonly stream: AsyncIterable<unknown>;
	wait(): Promise<unknown>;
	cancel(): Promise<void>;
}

export interface CursorAgent {
	readonly id: string;
	send(
		prompt: string,
		options: CursorSendOptions,
		onDelta: (update: unknown) => void,
	): Promise<CursorRun>;
	getUsage(): Promise<unknown>;
	close(): Promise<void>;
}

// All Cursor SDK operations cross this boundary, in either daemon or runner.
// Extend the real adapter and trace player together when adding an operation.
export interface CursorSdkPort {
	readonly replay?: true;
	probeRuntime(): Promise<CursorRuntimeProbe>;
	authStatus(): Promise<CursorAuthStatus>;
	storedCredential(): Promise<CursorStoredCredential | undefined>;
	modelsList(credential: CursorCredential): Promise<readonly CursorModel[]>;
	openStore(path: string, cwd: string): Promise<CursorStore>;
	getActiveRun(
		agentId: string,
		store: CursorStore,
	): Promise<CursorPersistedRun | undefined>;
	deleteAgent(agentId: string, cwd: string, store: CursorStore): Promise<void>;
	primeSandbox(
		options: CursorAgentOptions,
		credential: CursorCredential,
		store: CursorStore,
	): Promise<void>;
	createAgent(
		options: CursorAgentOptions,
		credential: CursorCredential,
		store: CursorStore,
		customTools?: Readonly<Record<string, CursorCustomTool>>,
	): Promise<CursorAgent>;
	resumeAgent(
		id: string,
		options: CursorAgentOptions,
		credential: CursorCredential,
		store: CursorStore,
		customTools?: Readonly<Record<string, CursorCustomTool>>,
	): Promise<CursorAgent>;
}
