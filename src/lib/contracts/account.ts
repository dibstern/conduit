import { Schema } from "effect";
import { ClaudeConfigDirSchema } from "./claude-config-dir.js";
import type { KnownProviderDriverKind } from "./provider-instance.js";

export const AccountIdSchema = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountIdSchema.Type;
export const MANAGED_OPENCODE_ACCOUNT_ID = AccountIdSchema.make("opencode");

export const ClaudeAccountSchema = Schema.Struct({
	driver: Schema.Literal("claude"),
	id: Schema.suspend(() => AccountIdSchema),
	name: Schema.String,
	configuredFolder: Schema.optional(Schema.String),
	folder: ClaudeConfigDirSchema,
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	usageEligible: Schema.Boolean,
});
export type ClaudeAccount = typeof ClaudeAccountSchema.Type;

export const OpenCodeAccountSchema = Schema.Struct({
	driver: Schema.Literal("opencode"),
	id: Schema.suspend(() => AccountIdSchema),
	name: Schema.String,
	url: Schema.optional(Schema.String),
});
export type OpenCodeAccount = typeof OpenCodeAccountSchema.Type;

export const AccountSchema = Schema.Union(
	ClaudeAccountSchema,
	OpenCodeAccountSchema,
);
export type Account = typeof AccountSchema.Type;
export type AccountListItem = Account & { readonly isDefault: boolean };

// Keep decoding independent of the directory and its current default pointer.
export const AccountRefSchema = Schema.Union(
	Schema.TaggedStruct("Id", { id: Schema.String }),
	Schema.TaggedStruct("DriverDefault", {
		driver: Schema.Literal("claude", "opencode"),
	}),
);
export type AccountRef = typeof AccountRefSchema.Type;

export const LEGACY_ACCOUNT_DRIVERS: Readonly<
	Record<string, KnownProviderDriverKind | undefined>
> = {
	claude: "claude",
	"claude-sdk": "claude",
	opencode: "opencode",
};

export function accountRefFromSelection(selection: {
	readonly instanceId?: string | undefined;
	readonly providerId?: string | undefined;
	readonly provider?: string | undefined;
	readonly model?: { readonly providerID: string } | string | undefined;
}): AccountRef {
	if (selection.instanceId !== undefined)
		return { _tag: "Id", id: selection.instanceId };
	const providerId = selection.providerId ?? selection.provider;
	if (providerId !== undefined) {
		const driver = Object.hasOwn(LEGACY_ACCOUNT_DRIVERS, providerId)
			? LEGACY_ACCOUNT_DRIVERS[providerId]
			: undefined;
		return driver === undefined
			? { _tag: "Id", id: providerId }
			: { _tag: "DriverDefault", driver };
	}
	const provider =
		typeof selection.model === "object"
			? selection.model.providerID
			: undefined;
	return {
		_tag: "DriverDefault",
		driver:
			provider === undefined ||
			provider === "claude" ||
			provider === "claude-sdk"
				? "claude"
				: "opencode",
	};
}
