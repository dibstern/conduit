import type { CursorAuthState } from "../../contracts/ws-rpc.js";
import { openSettings } from "../components/layout/chrome-actions.js";
import { rpc } from "../transport/ws-rpc-client.js";

export const cursorAuth = $state<{
	current: CursorAuthState | undefined;
	busy: boolean;
	error: string | undefined;
}>({ current: undefined, busy: false, error: undefined });

let generation = 0;
let refreshing: Promise<void> | undefined;

export function refreshCursorAuth(): Promise<void> {
	if (cursorAuth.busy) return Promise.resolve();
	if (refreshing) return refreshing;
	const request = generation;
	refreshing = (async () => {
		try {
			const snapshot = await rpc("GetCursorAuth", {});
			if (request !== generation) return;
			cursorAuth.current = snapshot;
			cursorAuth.error = undefined;
		} catch {
			if (request === generation)
				cursorAuth.error = "Could not check login status. Try again.";
		} finally {
			refreshing = undefined;
		}
	})();
	return refreshing;
}

export async function changeCursorAuth(
	command: "StartCursorLogin" | "CancelCursorLogin" | "LogoutCursor",
): Promise<void> {
	if (cursorAuth.busy) return;
	const request = ++generation;
	cursorAuth.busy = true;
	cursorAuth.error = undefined;
	try {
		const snapshot = await (command === "StartCursorLogin"
			? rpc("StartCursorLogin", {})
			: command === "CancelCursorLogin"
				? rpc("CancelCursorLogin", {})
				: rpc("LogoutCursor", {}));
		if (request === generation) cursorAuth.current = snapshot;
	} catch {
		if (request === generation)
			cursorAuth.error = "Could not update login. Try again.";
	} finally {
		if (request === generation) cursorAuth.busy = false;
	}
}

export function openCursorLogin(): void {
	openSettings("server", "instances");
	void refreshCursorAuth().then(() => {
		if (
			cursorAuth.current &&
			cursorAuth.current.source !== "environment" &&
			cursorAuth.current.login.state !== "pending"
		)
			void changeCursorAuth("StartCursorLogin");
	});
}
