import { Schema } from "effect";
import { ClaudeConfigDirSchema } from "./claude-config-dir.js";

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
	port: Schema.optional(Schema.Number),
	managed: Schema.optional(Schema.Boolean),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	configuredFolder: Schema.optional(Schema.String),
});
export type OpenCodeAccount = typeof OpenCodeAccountSchema.Type;

export const AccountSchema = Schema.Union(
	ClaudeAccountSchema,
	OpenCodeAccountSchema,
);
export type Account = typeof AccountSchema.Type;
export type AccountListItem = Account & { readonly isDefault: boolean };

export class AccountChangeRejected extends Schema.TaggedError<AccountChangeRejected>()(
	"AccountChangeRejected",
	{ id: Schema.String, reason: Schema.String },
) {
	get message(): string {
		return this.reason;
	}
}

const addFields = {
	name: Schema.String.pipe(Schema.minLength(1)),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	configDir: Schema.optional(Schema.String),
};
const validPort = Schema.Number.pipe(
	Schema.int(),
	Schema.between(1, 65535),
).annotations({
	message: () => "InstanceAdd requires a valid 'port' (1-65535)",
});

/** Driver-specific add rules are decoded by the directory, inside its commit. */
export const AccountAddInputSchema = Schema.Union(
	Schema.Struct({
		...addFields,
		driver: Schema.Literal("claude"),
		managed: Schema.optional(
			Schema.Literal(false).annotations({
				message: () => "InstanceAdd: Claude instances must not be managed",
			}),
		),
		port: Schema.optional(
			Schema.Never.annotations({
				message: () => "InstanceAdd: Claude instances must not include 'port'",
			}),
		),
		url: Schema.optional(
			Schema.Never.annotations({
				message: () => "InstanceAdd: Claude instances must not include 'url'",
			}),
		),
	}),
	Schema.Struct({
		...addFields,
		driver: Schema.Literal("opencode"),
		managed: Schema.optional(Schema.Boolean),
		port: Schema.optional(Schema.Union(validPort, Schema.Literal(0))),
		url: Schema.optional(
			Schema.String.pipe(
				Schema.filter(
					(url) => {
						try {
							new URL(url);
							return true;
						} catch {
							return false;
						}
					},
					{
						message: () =>
							"InstanceAdd: 'url' must be a valid URL (e.g. http://host:4096)",
					},
				),
			),
		),
	}).pipe(
		Schema.filter((input) => input.port !== 0 || input.managed === true, {
			message: () =>
				"InstanceAdd requires a valid 'port' (1-65535), or port 0 with managed: true",
		}),
		Schema.filter(
			(input) =>
				!(input.managed ?? input.url === undefined) || input.port !== undefined,
			{
				message: () =>
					"InstanceAdd requires a valid 'port' (1-65535) for managed instances",
			},
		),
		Schema.filter(
			(input) =>
				!(input.managed ?? input.url === undefined) || input.url === undefined,
			{
				message: () =>
					"InstanceAdd: 'url' is only valid for unmanaged instances (managed: false)",
			},
		),
		Schema.filter(
			(input) => input.url !== undefined || input.port !== undefined,
			{
				message: () =>
					"InstanceAdd: unmanaged instances require either a 'url' or a valid 'port'",
			},
		),
	),
);

// Keep decoding independent of the directory and its current default pointer.
export const AccountRefSchema = Schema.Union(
	Schema.TaggedStruct("Id", { id: Schema.String }),
	Schema.TaggedStruct("DriverDefault", {
		driver: Schema.Literal("claude", "opencode"),
	}),
);
export type AccountRef = typeof AccountRefSchema.Type;

export type AccountChange =
	| {
			readonly _tag: "Add";
			readonly id?: string | undefined;
			readonly name: string;
			readonly driver?: string | undefined;
			readonly managed?: boolean | undefined;
			readonly port?: number | undefined;
			readonly url?: string | undefined;
			readonly env?: Readonly<Record<string, string>> | undefined;
			readonly configDir?: string | undefined;
	  }
	| {
			readonly _tag: "Update";
			readonly id: string;
			readonly updates: {
				readonly name?: string | undefined;
				readonly driver?: string | undefined;
				readonly port?: number | undefined;
				readonly env?: Readonly<Record<string, string>> | undefined;
				readonly configDir?: string | undefined;
			};
	  }
	| { readonly _tag: "SetDefault"; readonly id: string }
	| { readonly _tag: "Remove"; readonly id: string };

export type AddAccountInput = Omit<
	Extract<AccountChange, { _tag: "Add" }>,
	"_tag"
>;
