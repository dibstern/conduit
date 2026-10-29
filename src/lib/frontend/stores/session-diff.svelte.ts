// One (session, scope) Session Diff listing for one consumer: its answers, rows and patches.
import { untrack } from "svelte";
import {
	SessionDiffError,
	type SessionDiffFile,
	type SessionDiffScope,
} from "../../contracts/session-diff.js";
import { failureLine } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";

/** `gone` holds the answer its fetch was made under; it renders like `loading`. */
export type DiffPatch =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| { readonly kind: "ready"; readonly patch: string }
	| { readonly kind: "gone"; readonly answer: number }
	| { readonly kind: "failed"; readonly message: string };

export class DiffRow {
	patch = $state<DiffPatch>({ kind: "idle" });
	constructor(
		/** The blob pair; an unchanged pair keeps its row and patch across listings. */
		readonly key: string,
		readonly folder: string,
		readonly file: SessionDiffFile,
		/** Fetches the patch when idle, or retries once after a Gone. */
		readonly load: () => void,
	) {}
}

export type DiffFolder =
	| {
			readonly folder: string;
			readonly rows: readonly DiffRow[];
			/** Another session ran in this folder during the turn. */
			readonly shared?: true;
	  }
	| {
			readonly folder: string;
			readonly error: "unavailable" | "timeout";
			readonly message: string;
	  };

const unloadable = "Could not load this diff.";

/**
 * The consumer creates one per key with `$derived(new SessionDiffView(...))`, so a late
 * reply can only land in the view that asked. Only a leased view lists or fetches.
 */
export class SessionDiffView {
	state = $state<
		| { readonly kind: "loading" }
		| { readonly kind: "failed"; readonly message: string }
		| {
				readonly kind: "listed";
				readonly folders: readonly DiffFolder[];
				/** The turn's run was never captured, so there is nothing to list. */
				readonly notCaptured?: true;
		  }
	>({ kind: "loading" });
	// Reactive: a row's load() reads it, so a row refused while hidden asks again when shown.
	#leases = $state(0);
	#listing = false;
	/** Landed listings. The revision hashes content, so it cannot tell two answers apart. */
	#answer = 0;
	#revision = "";
	// Kept through a failed listing, so the next answer reuses the patches.
	#rows = new Map<string, DiffRow>();

	constructor(
		readonly sessionId: string,
		readonly scope: SessionDiffScope,
	) {}

	/** Taken while the consumer is visible; taking it lists, so showing refreshes. */
	watch(): () => void {
		untrack(() => {
			this.#leases += 1;
			void this.#list();
		});
		let held = true;
		return () => {
			if (held) this.#leases -= 1;
			held = false;
		};
	}

	async #list() {
		if (this.#leases === 0 || this.#listing) return;
		this.#listing = true;
		try {
			const listing = await rpc("SessionDiffList", {
				sessionId: this.sessionId,
				scope: this.scope,
			});
			this.#answer += 1;
			this.#revision = listing.revision;
			const rows = new Map<string, DiffRow>();
			const folders = listing.folders.map((entry): DiffFolder => {
				if ("error" in entry) return entry;
				const { folder } = entry;
				return {
					folder,
					...(entry.shared && { shared: entry.shared }),
					rows: entry.files.map((file) => {
						const key = [
							folder,
							file.oldPath,
							file.path,
							file.before,
							file.after,
						].join("\0");
						const row: DiffRow =
							this.#rows.get(key) ??
							new DiffRow(key, folder, file, () => void this.#fetch(row));
						rows.set(key, row);
						return row;
					}),
				};
			});
			this.#rows = rows;
			this.state = {
				kind: "listed",
				folders,
				...(listing.notCaptured && { notCaptured: listing.notCaptured }),
			};
			for (const row of rows.values())
				if (row.patch.kind === "gone") row.load();
		} catch (error) {
			this.state = {
				kind: "failed",
				message: failureLine(error, "Could not load the diff."),
			};
		} finally {
			this.#listing = false;
		}
	}

	async #fetch(row: DiffRow) {
		const { patch } = row;
		const wanted =
			patch.kind === "idle" ||
			(patch.kind === "gone" && patch.answer < this.#answer);
		if (!wanted || this.#leases === 0 || this.#rows.get(row.key) !== row)
			return;
		const answer = this.#answer;
		row.patch = { kind: "loading" };
		try {
			const reply = await rpc("SessionDiffFile", {
				sessionId: this.sessionId,
				scope: this.scope,
				revision: this.#revision,
				folder: row.folder,
				path: row.file.path,
				before: row.file.before,
				after: row.file.after,
			});
			row.patch = { kind: "ready", patch: reply.patch };
		} catch (error) {
			if (!(error instanceof SessionDiffError && error.reason === "gone"))
				row.patch = { kind: "failed", message: failureLine(error, unloadable) };
			// A pair that is gone again on its one retry is broken, not collected.
			else if (patch.kind === "gone")
				row.patch = { kind: "failed", message: unloadable };
			else {
				row.patch = { kind: "gone", answer };
				if (this.#answer > answer) row.load();
				else void this.#list();
			}
		}
	}
}
