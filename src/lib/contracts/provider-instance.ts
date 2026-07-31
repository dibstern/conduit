import { Schema } from "effect";
import { AgentInfoSchema, ModelInfoSchema } from "./ws-rpc.js";

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

export const ProviderInstanceIdSchema = Schema.String.pipe(
	Schema.brand("ProviderInstanceId"),
);
export type ProviderInstanceId = typeof ProviderInstanceIdSchema.Type;

export function defaultInstanceIdForDriver(
	kind: ProviderDriverKind,
): ProviderInstanceId {
	return ProviderInstanceIdSchema.make(kind);
}

/**
 * Rewrite a pre-driver-model legacy default OpenCode instance id (`"default"`)
 * to the canonical `defaultInstanceIdForDriver("opencode")` across an instance
 * list and the project bindings that reference it. The composer rail keys every
 * OpenCode provider to the canonical id, so a lingering `"default"` leaves the
 * OpenCode harness unpickable (and re-seeding would duplicate it).
 *
 * Returns `null` when there is nothing to migrate — no legacy OpenCode
 * `"default"` instance, or a canonical instance already exists — so callers can
 * preserve referential identity and never create a duplicate id.
 */
export function migrateLegacyDefaultOpencodeInstanceId<
	I extends { readonly id: string; readonly driver?: ProviderDriverKind },
	P extends { readonly instanceId?: string },
>(
	instances: ReadonlyArray<I>,
	projects: ReadonlyArray<P>,
): { instances: I[]; projects: P[] } | null {
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
	return {
		instances: instances.map(
			(instance): I =>
				instance === legacy ? { ...instance, id: canonical } : instance,
		),
		projects: projects.map(
			(project): P =>
				project.instanceId === legacyId
					? { ...project, instanceId: canonical }
					: project,
		),
	};
}

export const ProviderInstanceStatusSchema = Schema.Literal(
	"ready",
	"warning",
	"error",
	"disabled",
);
export type ProviderInstanceStatus = typeof ProviderInstanceStatusSchema.Type;

export const ProviderInstanceSchema = Schema.Struct({
	id: ProviderInstanceIdSchema,
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

const CurrentInstanceModelSelectionSchema = Schema.Struct({
	instanceId: ProviderInstanceIdSchema,
	model: Schema.String,
});

const InstanceModelSelectionWireSchema = Schema.Struct({
	instanceId: Schema.String,
	model: Schema.String,
});

const LegacyModelSelectionSchema = Schema.Struct({
	provider: ProviderDriverKindSchema,
	model: Schema.String,
});

export const InstanceModelSelectionSchema = Schema.transform(
	Schema.Union(InstanceModelSelectionWireSchema, LegacyModelSelectionSchema),
	CurrentInstanceModelSelectionSchema,
	{
		strict: true,
		decode: (selection) =>
			"instanceId" in selection
				? selection
				: {
						instanceId: defaultInstanceIdForDriver(selection.provider),
						model: selection.model,
					},
		encode: (selection) => selection,
	},
);
export type InstanceModelSelection = typeof InstanceModelSelectionSchema.Type;
