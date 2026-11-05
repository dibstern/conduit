// One (session, scope) Session Diff listing for one consumer: its answers, rows and patches.
import { Effect, Fiber, Stream } from "effect";
import { untrack } from "svelte";
import {
	type SessionDiffBase,
	SessionDiffEditError,
	SessionDiffError,
	type SessionDiffFile,
	type SessionDiffPatch,
	type SessionDiffScope,
} from "../../contracts/session-diff.js";
import { failureLine, toastFailure } from "../transport/rpc-errors.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import { rpc } from "../transport/ws-rpc-client.js";

/** `gone` holds the answer its fetch was made under; it renders like `loading`. */
export type DiffPatch =
	| { readonly kind: "idle" }
	| { readonly kind: "loading" }
	| ({ readonly kind: "ready" } & SessionDiffPatch)
	| { readonly kind: "gone"; readonly answer: number }
	| { readonly kind: "failed"; readonly message: string };

export class DiffRow {
	patch = $state<DiffPatch>({ kind: "idle" });
	constructor(
		/** The blob pair and its labels; an unchanged one keeps its row and patch across listings. */
		readonly key: string,
		readonly folder: string,
		readonly file: SessionDiffFile,
		/** Fetches the patch when idle, or retries once after a Gone. */
		readonly load: () => void,
		/** Discards or stages the file, or one hunk of its patch; only the unstaged scope can. */
		readonly edit?: (
			action: "discard" | "stage",
			hunk?: number,
		) => Promise<void>,
	) {}
}

export type DiffFolder =
	| {
			readonly folder: string;
			/** What a branch listing compared against, and any fallback it took. */
			readonly base?: SessionDiffBase;
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
				/** A tool call's listing: where its Tool File Changes came from. */
				readonly source?: "provider" | "toolInput";
		  }
	>({ kind: "loading" });
	// Reactive: a row's load() reads it, so a row refused while hidden asks again when shown.
	#leases = $state(0);
	#listing = false;
	/** Landed listings. The revision hashes content, so it cannot tell two answers apart. */
	#answer = 0;
	#revision = "";
	/** The live scope's latest pushed revision, while leased. */
	#wanted: string | undefined;
	#unfollow: (() => void) | undefined;
	// Kept through a failed listing, so the next answer reuses the patches.
	#rows = new Map<string, DiffRow>();

	constructor(
		readonly sessionId: string,
		readonly scope: SessionDiffScope,
	) {}

	/**
	 * Taken while the consumer is visible; taking it lists, so showing refreshes. The
	 * first lease opens the scope's live feed and the last one closes it.
	 */
	watch(): () => void {
		untrack(() => {
			this.#leases += 1;
			void this.#list();
			if (this.#leases === 1) this.#unfollow = this.#follow();
		});
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			this.#leases -= 1;
			if (this.#leases > 0) return;
			this.#unfollow?.();
			this.#unfollow = undefined;
			this.#wanted = undefined;
		};
	}

	/** Every (re)subscription opens with the current revision, so a reconnect compares too. */
	#follow(): () => void {
		let stopped = false;
		let feed: Fiber.Fiber<void> | undefined;
		void getRuntime()
			.then((runtime) => {
				if (stopped) return;
				feed = runtime.runFork(
					Effect.flatMap(WsRpcClients, (clients) =>
						Effect.flatMap(clients.forProject(""), ({ subscriptions }) =>
							Stream.runForEach(
								supervise(
									Stream.suspend(() =>
										subscriptions.sessionDiff({
											sessionId: this.sessionId,
											scope: this.scope,
										}),
									),
									() => undefined,
								),
								({ revision }) =>
									Effect.sync(() => {
										this.#wanted = revision;
										if (revision !== this.#revision) void this.#list(revision);
									}),
							),
						),
					),
				);
			})
			.catch(() => undefined);
		return () => {
			stopped = true;
			if (feed) void runTransportEffect(Fiber.interrupt(feed));
		};
	}

	/** A pinned `revision` reuses the listing the server already made for it. */
	async #list(revision?: string) {
		if (this.#leases === 0 || this.#listing) return;
		this.#listing = true;
		const pushed = this.#wanted;
		try {
			const listing = await rpc("SessionDiffList", {
				sessionId: this.sessionId,
				scope: this.scope,
				...(revision === undefined ? {} : { revision }),
			});
			this.#answer += 1;
			this.#revision = listing.revision;
			const rows = new Map<string, DiffRow>();
			const folders = listing.folders.map((entry): DiffFolder => {
				if ("error" in entry) return entry;
				const { folder, base } = entry;
				return {
					folder,
					...(base ? { base } : {}),
					...(entry.shared && { shared: entry.shared }),
					rows: entry.files.map((file) => {
						const key = [
							folder,
							file.oldPath,
							file.path,
							file.before,
							file.after,
							// A mode change rewrites the patch header and the label.
							file.kind,
							file.mode?.before,
							file.mode?.after,
						].join("\0");
						const row: DiffRow =
							this.#rows.get(key) ??
							new DiffRow(
								key,
								folder,
								file,
								() => void this.#fetch(row),
								this.scope.kind === "unstaged"
									? (action, hunk) => this.#edit(row, action, hunk)
									: undefined,
							);
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
				...(listing.source && { source: listing.source }),
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
			// A revision pushed while this list ran, and not the one it brought back.
			const wanted = this.#wanted;
			if (
				wanted !== undefined &&
				wanted !== pushed &&
				wanted !== revision &&
				wanted !== this.#revision
			)
				void this.#list(wanted);
		}
	}

	/**
	 * Guarded by the blob the row shows, and a hunk by the listing its patch came
	 * from. A write reaches every viewer through the live scope; Stale re-lists
	 * here, and keyed rows keep the scroll.
	 */
	async #edit(row: DiffRow, action: "discard" | "stage", hunk?: number) {
		const { file, folder } = row;
		const request = {
			sessionId: this.sessionId,
			folder,
			path: file.path,
			...(file.oldPath !== undefined && { oldPath: file.oldPath }),
			expected: file.after,
			...(hunk !== undefined &&
				file.before !== null && {
					hunk: { revision: this.#revision, before: file.before, index: hunk },
				}),
		};
		try {
			await (action === "discard"
				? rpc("SessionDiffDiscard", request)
				: rpc("SessionDiffStage", request));
		} catch (error) {
			toastFailure(`Could not ${action} ${file.path}`)(error);
			if (error instanceof SessionDiffEditError && error.reason === "stale")
				void this.#list();
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
			row.patch = { kind: "ready", ...reply };
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
