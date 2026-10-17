import { Option, Schema } from "effect";
import {
	type Avatar,
	type AvatarChoice,
	AvatarSchema,
} from "../../contracts/user-avatar.js";
import { rpc } from "../transport/ws-rpc-client.js";

const STORAGE_KEY = "conduit-avatar";

/** The daemon's last answer, so a reload draws the right face before it
 * answers again. */
const stored = (): Avatar | undefined => {
	try {
		return Option.getOrUndefined(
			Schema.decodeUnknownOption(Schema.parseJson(AvatarSchema))(
				localStorage.getItem(STORAGE_KEY),
			),
		);
	} catch {
		return undefined;
	}
};

const keep = (avatar: Avatar) => {
	avatarState.current = avatar;
	avatarState.loaded = true;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(avatar));
	} catch {
		// Private browsing or a full quota: the next load waits for the daemon.
	}
};

export const avatarState = $state({
	current: stored() ?? ({ choice: null, name: "", macPicture: null } as Avatar),
	loaded: false,
	saving: false,
	error: "",
});

let revision = 0;

export async function loadAvatar(): Promise<void> {
	if (avatarState.saving) return;
	avatarState.loaded = false;
	const request = ++revision;
	try {
		const avatar = await rpc("GetAvatar", {});
		if (request !== revision) return;
		keep(avatar);
	} catch {
		// Keep the initial, and do not ask first-run until the daemon answers.
	}
}

export async function saveAvatar(choice: AvatarChoice): Promise<boolean> {
	if (avatarState.saving) return false;
	++revision;
	avatarState.saving = true;
	avatarState.error = "";
	try {
		const avatar = await rpc("SetAvatar", { choice });
		++revision;
		keep(avatar);
		return true;
	} catch {
		avatarState.error = "Couldn't save your avatar. Try again.";
		return false;
	} finally {
		avatarState.saving = false;
	}
}
