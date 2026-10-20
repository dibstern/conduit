import { Record, Schema } from "effect";
import { AccountIdSchema, MANAGED_OPENCODE_ACCOUNT_ID } from "./account.js";
import { AgentInfoSchema, ModelInfoSchema } from "./ws-rpc.js";

export type { AccountId } from "./account.js";
export { AccountIdSchema, MANAGED_OPENCODE_ACCOUNT_ID } from "./account.js";

export const ProviderDriverKindSchema = Schema.String;
export type ProviderDriverKind = typeof ProviderDriverKindSchema.Type;

export const ProviderSessionCapabilitiesSchema = Schema.Struct({
	supportsMultiFolder: Schema.Boolean,
	supportsWorktree: Schema.Boolean,
	/** Launch in Conduit-owned worktrees without enabling arbitrary workspace moves. */
	supportsNewWorktree: Schema.optional(Schema.Boolean),
	/** Individual background tasks can be stopped without interrupting a turn. */
	supportsTaskStop: Schema.optional(Schema.Boolean),
});
export type ProviderSessionCapabilities =
	typeof ProviderSessionCapabilitiesSchema.Type;

export interface ProviderDriverTraits {
	/** Composer provider-seam tests pin plain text and PDF delivery. */
	readonly supportsFileAttachments: boolean;
	/** composer-controls-words.feature pins the compact composer's behaviour control. */
	readonly composerModeControl: "agent" | "permission-mode";
	/** permission-modes.test.ts pins the modes each provider can enforce. */
	readonly permissionModes: readonly (
		| "ask"
		| "acceptEdits"
		| "full"
		| "plan"
		| "auto"
		| "dontAsk"
	)[];
	/** question-card.test.ts pins whether a provider accepts skipped questions. */
	readonly supportsQuestionSkip: boolean;
	/** rewind-banner.test.ts pins whether conversation rewind can also restore files. */
	readonly supportsFileRewind: boolean;
	/** Provider captures pin multi-folder, worktree and task-stop session contracts. */
	readonly sessionCapabilities: ProviderSessionCapabilities;
	/** OpenCode's SDK/API and SSE lifecycle pin server-owned operations. */
	readonly runsOpenCodeServer: boolean;
	/** account-usage.integration.ts pins the account sampler's usage harness. */
	readonly usageHarness: "claude" | "cursor" | undefined;
	/** permissions-processing-timeout-effect.test.ts pins service-owned approvals/questions. */
	readonly interactionSink: "permission-asking" | "auto-approving";
	/** orchestration-side-effect-reactor.test.ts pins native-thread preparation and replay. */
	readonly supportsNativeResume: boolean;
	/** session-workspace-fork.test.ts and cursor-fork.test.ts pin native versus digest seeding. */
	readonly forkStrategy: "native" | "transcript-digest";
	/** provider-turn-service.test.ts pins cumulative tokens from stored history metadata. */
	readonly needsPriorHistoryMetadata: boolean;
	/** AccountSchema pins config-directory logins versus server connection accounts. */
	readonly accountKind: "config-directory" | "server";
	/** account-directory.test.ts pins selected defaults versus the fixed managed account. */
	readonly defaultAccountSource: "selection" | "managed";
	/** orchestration-wiring.test.ts pins discovery versus server provider catalogs. */
	readonly catalogSource: "discovery" | "server";
	/** turn-settings.test.ts pins context-window suffixes versus provider-qualified ids. */
	readonly modelIdFormat: "context-window-suffix" | "provider-qualified";
	/** monitoring-wiring.test.ts pins provider-owned turn-end events. */
	readonly streamsSessionLifecycle: boolean;
	/** session-manager-service.test.ts pins local session creation before a native turn. */
	readonly usesLocalSessions: boolean;
	/** provider-turn-service.test.ts pins durable interrupts versus server aborts. */
	readonly interruptViaEngine: boolean;
	/** provider-turn-service.test.ts pins goal state passed to the native runner. */
	readonly supportsGoalState: boolean;
	/** enter-worktree-turn / exit-worktree-keep-turn pin tool-directed workspace moves. */
	readonly worktreeMoves: "tool-directive" | "server-declaration";
	/** OpenCode message snapshots pin native parentID lineage. */
	readonly emitsMessageParentIds: boolean;
	/** steer-during-tool-folds.jsonl pins native delivery; otherwise inputs stay queued. */
	readonly steering: "native" | "queue";
	/** provider-instance.test.ts pins false until restart-safe prompt replies are captured. */
	readonly promptsSurviveRestart: boolean;
	/** cursor-subagents.test.ts pins child transcripts that cannot be resumed. */
	readonly readOnlySubagents: boolean;
}

/** Driver contracts pinned by provider captures, independent of implementations. */
export const PROVIDER_DRIVERS = {
	// additionalDirectories and cwd/resume are pinned by extra-folder-read-turn
	// and enter-worktree-turn / exit-worktree-keep-turn in claude-sdk-traces.
	claude: {
		supportsFileAttachments: true,
		composerModeControl: "permission-mode",
		permissionModes: ["ask", "acceptEdits", "full", "plan", "auto", "dontAsk"],
		supportsQuestionSkip: false,
		supportsFileRewind: false,
		sessionCapabilities: {
			supportsMultiFolder: true,
			supportsWorktree: true,
			supportsNewWorktree: true,
			supportsTaskStop: true,
		},
		runsOpenCodeServer: false,
		usageHarness: "claude",
		interactionSink: "permission-asking",
		supportsNativeResume: true,
		forkStrategy: "native",
		needsPriorHistoryMetadata: true,
		accountKind: "config-directory",
		defaultAccountSource: "selection",
		catalogSource: "discovery",
		modelIdFormat: "context-window-suffix",
		streamsSessionLifecycle: true,
		usesLocalSessions: true,
		interruptViaEngine: true,
		supportsGoalState: true,
		worktreeMoves: "tool-directive",
		emitsMessageParentIds: false,
		// steer-during-tool-folds.jsonl and claude-steer-recovery.test.ts pin native delivery and requeue.
		steering: "native",
		// provider-instance.test.ts pins false; no restart-safe approval/question reply capture yet.
		promptsSurviveRestart: false,
		readOnlySubagents: false,
	},
	// The multi-folder-project replay pins external_directory session rules.
	// Managed launches/recreation are pinned by opencode-launch-worktree.test.ts.
	// Native moves reject destinations belonging to another OpenCode project.
	opencode: {
		supportsFileAttachments: true,
		composerModeControl: "agent",
		permissionModes: ["ask", "acceptEdits", "full"],
		supportsQuestionSkip: true,
		supportsFileRewind: true,
		sessionCapabilities: {
			supportsMultiFolder: true,
			supportsWorktree: false,
			supportsNewWorktree: true,
			supportsTaskStop: false,
		},
		runsOpenCodeServer: true,
		usageHarness: undefined,
		interactionSink: "auto-approving",
		supportsNativeResume: false,
		forkStrategy: "native",
		needsPriorHistoryMetadata: false,
		accountKind: "server",
		defaultAccountSource: "managed",
		catalogSource: "server",
		modelIdFormat: "provider-qualified",
		streamsSessionLifecycle: false,
		usesLocalSessions: false,
		interruptViaEngine: false,
		supportsGoalState: false,
		worktreeMoves: "server-declaration",
		emitsMessageParentIds: true,
		// Classic prompt_async injects a busy prompt at the next model step
		// (test/fixtures/opencode-wire-traces/classic-prompt-during-tool.json).
		// Flip to native only after approval, image and subagent captures on OpenCode 1.19.1.
		steering: "queue",
		// provider-instance.test.ts pins false; no restart-safe approval/question reply capture yet.
		promptsSurviveRestart: false,
		readOnlySubagents: false,
	},
	cursor: {
		supportsFileAttachments: false,
		composerModeControl: "permission-mode", // cursor-turn.feature pins the no-per-call-approval notice.
		permissionModes: ["ask", "acceptEdits", "full", "plan", "auto"], // cursor-turn.test.ts pins sandbox reopen; sandbox-anchored pins enforcement.
		supportsQuestionSkip: false, // Skipping questions needs a captured Cursor contract.
		supportsFileRewind: false, // No runtime can restore files yet.
		sessionCapabilities: {
			supportsMultiFolder: true, // workspace-resume and cursor-turn.test.ts pin changed dirs with fixed cwd.
			supportsWorktree: false, // Await a Cursor worktree trace.
			supportsNewWorktree: false, // No runtime can launch into a worktree yet.
			supportsTaskStop: false, // No runtime can stop individual tasks yet.
		},
		runsOpenCodeServer: false, // Cursor must never start or borrow OpenCode.
		usageHarness: "cursor", // Retain the existing Cursor usage identity.
		interactionSink: "auto-approving", // cursor-session-config allows gated calls; sandbox is the interim boundary.
		supportsNativeResume: false, // cursor-recovery.test.ts pins owned-store resume; cross-account native-thread transfer is unproven.
		forkStrategy: "transcript-digest", // cursor-fork.test.ts pins isolated agents seeded from bounded, redacted history.
		needsPriorHistoryMetadata: false, // No cumulative-history contract is established.
		accountKind: "config-directory", // Keep runner account configuration separate from servers.
		defaultAccountSource: "selection", // Cursor owns its selected account default.
		catalogSource: "discovery", // Models come from a registered runner, never OpenCode.
		modelIdFormat: "provider-qualified", // Preserve ids until a trace establishes a suffix format.
		streamsSessionLifecycle: true, // Runner lifecycle must never be polled through OpenCode.
		usesLocalSessions: true, // Conduit owns sessions before a runner exists.
		interruptViaEngine: true, // Interrupts must fail through runner lookup, never OpenCode abort.
		supportsGoalState: false, // Goals need a captured Cursor runtime contract.
		worktreeMoves: "tool-directive", // Never declare workspace moves through OpenCode.
		emitsMessageParentIds: false, // No native message-lineage contract is established.
		// steer.jsonl pins native text delivery; cursor-steer.test.ts pins missing
		// methods, declined/image/pending steers and crash recovery through the inbox.
		steering: "native",
		readOnlySubagents: true, // cursor-subagents.test.ts pins rejection of child input.
		// cursor-question.test.ts pins an ask_user wait answered after daemon restart on the retained runner.
		promptsSurviveRestart: true,
	},
} as const satisfies { readonly [driver: string]: ProviderDriverTraits };

export type KnownProviderDriverKind = keyof typeof PROVIDER_DRIVERS;
export const KnownProviderDriverKindSchema = Schema.Literals([
	...(Object.keys(PROVIDER_DRIVERS) as KnownProviderDriverKind[]),
]);
const isKnownProviderDriverKind = Schema.is(KnownProviderDriverKindSchema);

export function isKnownDriverKind(
	value: unknown,
): value is KnownProviderDriverKind {
	return isKnownProviderDriverKind(value);
}

export const BrowserDriverTraitsSchema = Schema.Struct({
	sessionCapabilities: ProviderSessionCapabilitiesSchema,
	runsOpenCodeServer: Schema.Boolean,
	usageHarness: Schema.optional(Schema.Literals(["claude", "cursor"])),
	composerModeControl: Schema.Literals(["agent", "permission-mode"]),
	accountKind: Schema.Literals(["config-directory", "server"]),
	catalogSource: Schema.Literals(["discovery", "server"]),
	modelIdFormat: Schema.Literals([
		"context-window-suffix",
		"provider-qualified",
	]),
	supportsGoalState: Schema.Boolean,
	permissionModes: Schema.Array(
		Schema.Literals(["ask", "acceptEdits", "full", "plan", "auto", "dontAsk"]),
	),
	supportsQuestionSkip: Schema.Boolean,
	supportsFileRewind: Schema.Boolean,
});
export type BrowserDriverTraits = typeof BrowserDriverTraitsSchema.Type;

export function getProviderDriver(
	driver: ProviderDriverKind | undefined,
): ProviderDriverTraits | undefined {
	return isKnownDriverKind(driver) ? PROVIDER_DRIVERS[driver] : undefined;
}

/** Capability-only compatibility view for callers outside the driver migration. */
export const PROVIDER_SESSION_CAPABILITIES = Record.map(
	PROVIDER_DRIVERS,
	(driver) => driver.sessionCapabilities,
);

/**
 * Rewrite a pre-driver-model legacy default OpenCode instance id (`"default"`)
 * to `MANAGED_OPENCODE_ACCOUNT_ID` in an instance
 * list. The composer rail keys every
 * OpenCode provider to the canonical id, so a lingering `"default"` leaves the
 * OpenCode harness unpickable (and re-seeding would duplicate it).
 *
 * Returns `null` when there is nothing to migrate — no legacy OpenCode
 * `"default"` instance, or a canonical instance already exists — so callers can
 * preserve referential identity and never create a duplicate id.
 */
export function migrateLegacyDefaultOpencodeInstanceId<
	I extends { readonly id: string; readonly driver?: ProviderDriverKind },
>(instances: ReadonlyArray<I>): I[] | null {
	const canonical: string = MANAGED_OPENCODE_ACCOUNT_ID;
	const legacyId = "default";
	const legacy = instances.find(
		(instance) =>
			instance.id === legacyId &&
			getProviderDriver(instance.driver ?? "opencode")?.runsOpenCodeServer,
	);
	if (
		legacy === undefined ||
		instances.some((instance) => instance.id === canonical)
	) {
		return null;
	}
	return instances.map(
		(instance): I =>
			instance === legacy ? { ...instance, id: canonical } : instance,
	);
}

export const ProviderInstanceStatusSchema = Schema.Literals([
	"ready",
	"warning",
	"error",
	"disabled",
]);
export type ProviderInstanceStatus = typeof ProviderInstanceStatusSchema.Type;

export const ProviderInstanceSchema = Schema.Struct({
	id: AccountIdSchema,
	name: Schema.String,
	driver: ProviderDriverKindSchema,
	available: Schema.Boolean,
	models: Schema.Array(Schema.suspend(() => ModelInfoSchema)),
	agents: Schema.Array(Schema.suspend(() => AgentInfoSchema)),
	displayName: Schema.String,
	status: ProviderInstanceStatusSchema,
	accentColor: Schema.optional(Schema.String),
	isNew: Schema.optional(Schema.Boolean),
});
export type ProviderInstance = typeof ProviderInstanceSchema.Type;
