import { Context, type Effect, type Option } from "effect";

/** A small JPEG, or none when the account/platform has no picture. Fails when
 * a picture may exist but couldn't be read. */
export class AccountPicture extends Context.Service<
	AccountPicture,
	{ readonly read: Effect.Effect<Option.Option<Uint8Array>, Error> }
>()("AccountPicture") {}
