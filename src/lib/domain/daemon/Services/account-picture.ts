import { Context, type Effect, type Option } from "effect";

/** A small JPEG, or none when the account/platform cannot supply a picture. */
export class AccountPicture extends Context.Tag("AccountPicture")<
	AccountPicture,
	{ readonly read: Effect.Effect<Option.Option<Uint8Array>> }
>() {}
