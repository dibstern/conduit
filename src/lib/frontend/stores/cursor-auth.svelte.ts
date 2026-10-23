import type { CursorAuthState } from "../../contracts/ws-rpc.js";
import { openSettings } from "../components/layout/chrome-actions.js";
import { rpc } from "../transport/ws-rpc-client.js";

interface CursorAccountAuthState {
	accountId: string | undefined;
	current: CursorAuthState | undefined;
	busy: boolean;
	error: string | undefined;
}

const accounts = new Map<
	string | undefined,
	{
		state: CursorAccountAuthState;
		generation: number;
		refreshing: Promise<void> | undefined;
	}
>();

function accountAuth(accountId: string | undefined) {
	let account = accounts.get(accountId);
	if (!account) {
		const state = $state<CursorAccountAuthState>({
			accountId,
			current: undefined,
			busy: false,
			error: undefined,
		});
		account = {
			state,
			generation: 0,
			refreshing: undefined,
		};
		accounts.set(accountId, account);
	}
	return account;
}

export const cursorAuthFor = (accountId: string | undefined) =>
	accountAuth(accountId).state;
export const cursorAuth = cursorAuthFor(undefined);

export function refreshCursorAuth(
	accountId: string | undefined,
): Promise<void> {
	const account = accountAuth(accountId);
	const state = account.state;
	if (state.busy) return Promise.resolve();
	if (account.refreshing) return account.refreshing;
	const request = account.generation;
	account.refreshing = (async () => {
		try {
			const snapshot = await rpc(
				"GetCursorAuth",
				accountId === undefined ? {} : { accountId },
			);
			if (request !== account.generation) return;
			state.current = snapshot;
			state.error = undefined;
		} catch {
			if (request === account.generation)
				state.error = "Could not check login status. Try again.";
		} finally {
			account.refreshing = undefined;
		}
	})();
	return account.refreshing;
}

export async function changeCursorAuth(
	command: "StartCursorLogin" | "CancelCursorLogin" | "LogoutCursor",
	accountId: string | undefined,
): Promise<void> {
	const account = accountAuth(accountId);
	const state = account.state;
	if (state.busy) return;
	const request = ++account.generation;
	state.busy = true;
	state.error = undefined;
	try {
		const input = accountId === undefined ? {} : { accountId };
		const snapshot = await (command === "StartCursorLogin"
			? rpc("StartCursorLogin", input)
			: command === "CancelCursorLogin"
				? rpc("CancelCursorLogin", input)
				: rpc("LogoutCursor", input));
		if (request === account.generation) state.current = snapshot;
	} catch {
		if (request === account.generation)
			state.error = "Could not update login. Try again.";
	} finally {
		if (request === account.generation) state.busy = false;
	}
}

export function openCursorLogin(accountId: string | undefined): void {
	openSettings("server", "instances");
	const state = cursorAuthFor(accountId);
	void refreshCursorAuth(accountId).then(() => {
		if (
			state.current &&
			state.current.source !== "environment" &&
			state.current.login.state !== "pending"
		)
			void changeCursorAuth("StartCursorLogin", accountId);
	});
}
