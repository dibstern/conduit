import { Context, type Effect } from "effect";
import type { Avatar, AvatarChoice } from "../../../contracts/user-avatar.js";

export class UserAvatar extends Context.Tag("UserAvatar")<
	UserAvatar,
	{
		readonly get: Effect.Effect<Avatar>;
		readonly set: (choice: AvatarChoice) => Effect.Effect<Avatar, Error>;
	}
>() {}
