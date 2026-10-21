import type { CodexAuthState } from "../../contracts/ws-rpc.js";
import { rpc } from "../transport/ws-rpc-client.js";

export class CodexAuth {
	current = $state<CodexAuthState>();
	busy = $state(false);
	error = $state<string>();
	private generation = 0;
	private refreshing: Promise<void> | undefined;

	constructor(readonly accountId: string) {}

	refresh(): Promise<void> {
		if (this.busy) return Promise.resolve();
		if (this.refreshing) return this.refreshing;
		const request = this.generation;
		this.refreshing = (async () => {
			try {
				const snapshot = await rpc("GetCodexAuth", {
					accountId: this.accountId,
				});
				if (request !== this.generation) return;
				this.current = snapshot;
				this.error = undefined;
			} catch {
				if (request === this.generation)
					this.error = "Could not check login status. Try again.";
			} finally {
				this.refreshing = undefined;
			}
		})();
		return this.refreshing;
	}

	start(method: "browser" | "device-code"): Promise<void> {
		return this.change("start", method);
	}

	cancel(): Promise<void> {
		return this.change("cancel");
	}

	logout(): Promise<void> {
		return this.change("logout");
	}

	dispose(): void {
		this.generation++;
	}

	private async change(
		action: "start" | "cancel" | "logout",
		method: "browser" | "device-code" = "browser",
	): Promise<void> {
		if (this.busy) return;
		const request = ++this.generation;
		this.busy = true;
		this.error = undefined;
		try {
			const snapshot = await (action === "start"
				? rpc("StartCodexLogin", { accountId: this.accountId, method })
				: action === "cancel"
					? rpc("CancelCodexLogin", { accountId: this.accountId })
					: rpc("LogoutCodex", { accountId: this.accountId }));
			if (request === this.generation) this.current = snapshot;
		} catch {
			if (request === this.generation)
				this.error = "Could not update login. Try again.";
		} finally {
			if (request === this.generation) this.busy = false;
		}
	}
}
