import { Schema } from "effect";

/**
 * Keys whose trust depends on which tier they arrived from: the CLI ignores
 * them from `project`/`local` because those files are repo-controllable, but
 * trusts them from the flag tier. Conduit occupies the flag tier, so passing
 * one through would launder a repo-derived value past a deliberate check.
 * See ADR-0003.
 *
 * Verified against @anthropic-ai/claude-agent-sdk 0.3.258. Note that the SDK's
 * `Settings` type carries a `[k: string]: unknown` index signature, so
 * `satisfies readonly (keyof Settings)[]` accepts any string whatsoever and
 * would assert nothing here. `autoMode` in particular is absent from the
 * published types and exists only in the CLI bundle. The list is pinned by
 * test instead — see test/unit/provider/claude/claude-sdk-settings.test.ts.
 */
export const CLAUDE_TRUST_TIERED_SETTINGS_KEYS: readonly string[] = [
	"permissions",
	"autoMode",
];

/**
 * Keys the settings panel may display, and therefore the only keys the
 * resolver lets out of its child process. Anything absent here never crosses
 * that boundary, which is what keeps unrelated secrets (`env`, `apiKeyHelper`,
 * plugin option blobs) out of conduit's memory and off the wire. Later tickets
 * extend this list when they add controls — each addition permits that key's
 * value to reach the browser, so review it for secret-bearing content.
 */
export const CLAUDE_DISPLAYABLE_SETTINGS_KEYS = [
	"autoCompactEnabled",
	"autoCompactWindow",
	"alwaysThinkingEnabled",
	"disableAllHooks",
	"cleanupPeriodDays",
	"attribution",
] as const;

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(
	(): Schema.Schema<JsonValue> =>
		Schema.Union(
			Schema.Null,
			Schema.Boolean,
			Schema.JsonNumber,
			Schema.String,
			Schema.Array(JsonValueSchema),
			Schema.Record({ key: Schema.String, value: JsonValueSchema }),
		),
);

export const ClaudeSettingsOverridesSchema = Schema.Record({
	key: Schema.String,
	value: JsonValueSchema,
});
export type ClaudeSettingsOverrides = typeof ClaudeSettingsOverridesSchema.Type;

const ClaudeDisplaySettingSchema = Schema.Struct({
	value: Schema.optional(JsonValueSchema),
	source: Schema.optional(
		Schema.Literal("user", "project", "local", "managed", "flag"),
	),
	path: Schema.optional(Schema.String),
	policyOrigin: Schema.optional(
		Schema.Literal(
			"helper",
			"remote",
			"plist",
			"hklm",
			"file",
			"parent",
			"hkcu",
		),
	),
});

export const ResolvedClaudeSettingsSchema = Schema.Record({
	key: Schema.Literal(...CLAUDE_DISPLAYABLE_SETTINGS_KEYS),
	value: ClaudeDisplaySettingSchema,
});
export type ResolvedClaudeSettings = typeof ResolvedClaudeSettingsSchema.Type;

export class ClaudeSettingsTrustBoundaryError extends Schema.TaggedError<ClaudeSettingsTrustBoundaryError>()(
	"ClaudeSettingsTrustBoundaryError",
	{
		key: Schema.String,
		message: Schema.String,
	},
) {}

export class ClaudeSettingsResolveError extends Schema.TaggedError<ClaudeSettingsResolveError>()(
	"ClaudeSettingsResolveError",
	{
		reason: Schema.Literal(
			"timeout",
			"non-zero-exit",
			"invalid-json",
			"invalid-result",
			"spawn-failed",
			"output-too-large",
		),
		message: Schema.String,
	},
) {}
