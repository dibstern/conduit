import { avatarPicture } from "../../../../test/fixtures/avatar-picture.js";
import type { AvatarChoice } from "../../contracts/user-avatar.js";
import { avatarState } from "../stores/avatar.svelte.js";
import { sessionViewState } from "../stores/session-view.svelte.js";
import { connectedSocket, seedStoryAvatar } from "./sockets.js";

export type AvatarStoryKind =
	| "initial"
	| "mac"
	| "preset"
	| "shape"
	| "missing-mac";

export function prepareAvatarStory(
	kind: AvatarStoryKind = "initial",
	firstRun = false,
): () => void {
	const compact = sessionViewState.compact;
	sessionViewState.compact = window.innerWidth < 768;
	const choice: AvatarChoice =
		kind === "preset"
			? { kind, id: "fox" }
			: kind === "shape"
				? { kind, seed: 0 }
				: kind === "missing-mac"
					? { kind: "mac" }
					: { kind };
	const avatar = {
		choice: firstRun ? null : choice,
		name: "David",
		macPicture: kind === "missing-mac" ? null : avatarPicture,
	};
	Object.assign(avatarState, {
		current: avatar,
		loaded: true,
		saving: false,
		error: "",
	});
	seedStoryAvatar(avatar);
	const restore = connectedSocket();
	return () => {
		sessionViewState.compact = compact;
		restore();
	};
}
