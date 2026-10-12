import { Schema } from "effect";
import type { AccountId } from "./account.js";
import { AccountIdSchema } from "./account.js";
import { AgentInfoSchema, ModelInfoSchema } from "./ws-rpc.js";

export type { AccountId } from "./account.js";
export { AccountIdSchema, MANAGED_OPENCODE_ACCOUNT_ID } from "./account.js";

export const KnownProviderDriverKindSchema = Schema.Literal(
	"claude",
	"opencode",
);
export type KnownProviderDriverKind = typeof KnownProviderDriverKindSchema.Type;

export const ProviderDriverKindSchema = Schema.String;
export type ProviderDriverKind = typeof ProviderDriverKindSchema.Type;

const isKnownProviderDriverKind = Schema.is(KnownProviderDriverKindSchema);

export function isKnownDriverKind(
	value: unknown,
): value is KnownProviderDriverKind {
	return isKnownProviderDriverKind(value);
}

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

/** Session contracts pinned by provider captures, independent of model discovery. */
export const PROVIDER_SESSION_CAPABILITIES = {
	// additionalDirectories and cwd/resume are pinned by extra-folder-read-turn
	// and enter-worktree-turn / exit-worktree-keep-turn in claude-sdk-traces.
	claude: {
		supportsMultiFolder: true,
		supportsWorktree: true,
		supportsNewWorktree: true,
		supportsTaskStop: true,
	},
	// The multi-folder-project replay pins external_directory session rules.
	// Managed launches/recreation are pinned by opencode-launch-worktree.test.ts.
	// Native moves reject destinations belonging to another OpenCode project.
	opencode: {
		supportsMultiFolder: true,
		supportsWorktree: false,
		supportsNewWorktree: true,
		supportsTaskStop: false,
	},
} as const satisfies Record<
	KnownProviderDriverKind,
	ProviderSessionCapabilities
>;

export function defaultInstanceIdForDriver(
	kind: ProviderDriverKind,
): AccountId {
	return AccountIdSchema.make(kind);
}

/**
 * Rewrite a pre-driver-model legacy default OpenCode instance id (`"default"`)
 * to the canonical `defaultInstanceIdForDriver("opencode")` in an instance
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
	const canonical: string = defaultInstanceIdForDriver("opencode");
	const legacyId = "default";
	const legacy = instances.find(
		(instance) =>
			instance.id === legacyId &&
			(instance.driver ?? "opencode") === "opencode",
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

export const ProviderInstanceStatusSchema = Schema.Literal(
	"ready",
	"warning",
	"error",
	"disabled",
);
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
