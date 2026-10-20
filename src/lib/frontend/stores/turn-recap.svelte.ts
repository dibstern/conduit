import { Effect, Fiber, Stream } from "effect";
import type { TurnRecap } from "../../contracts/turn-recap.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import { rpc } from "../transport/ws-rpc-client.js";

/** One mounted turn owns its cached versions and cancels its feed on navigation. */
export class TurnRecapState {
	versions = $state<readonly TurnRecap[]>([]);
	selected = $state<number | null>(null);
	generating = $state(false);
	error = $state("");
	retry = $state<{
		scope: "whole" | "new";
		sourceVersion?: number | undefined;
	} | null>(null);
	#manualGenerating = false;
	#remoteGenerating = false;
	#request = 0;
	#identity = "";
	current = $derived(
		this.versions.find(({ version }) => version === this.selected) ??
			this.versions.at(-1),
	);

	#merge(versions: readonly TurnRecap[]): void {
		const followingLatest =
			this.selected === null || this.selected === this.versions.at(-1)?.version;
		const all = new Map(
			this.versions.map((version) => [version.version, version]),
		);
		for (const version of versions) all.set(version.version, version);
		this.versions = [...all.values()].sort((a, b) => a.version - b.version);
		if (followingLatest) this.selected = null;
	}

	connect(sessionId: string, turnId: string, watch: boolean): () => void {
		const identity = `${sessionId}/${turnId}`;
		if (identity !== this.#identity) {
			this.#identity = identity;
			this.versions = [];
			this.selected = null;
			this.generating = false;
			this.error = "";
			this.retry = null;
			this.#manualGenerating = false;
			this.#remoteGenerating = false;
		}
		const request = ++this.#request;
		let cancelled = false;
		let stop: (() => void) | undefined;
		void rpc("ListRecaps", { sessionId, turnId })
			.then((versions) => {
				if (!cancelled && request === this.#request) this.#merge(versions);
			})
			.catch(() => {
				// A list failure must never turn a cached summary into a failed paid call.
			});
		// Even an older turn needs the initial snapshot: its automatic recap may
		// still be pending when the next prompt replaces the latest-turn feed.
		void getRuntime()
			.then((runtime) => {
				if (cancelled) return;
				const feed = runtime.runFork(
					Effect.flatMap(WsRpcClients, (clients) =>
						Effect.flatMap(clients.forProject(""), ({ subscriptions }) =>
							Stream.runForEach(
								supervise(
									Stream.suspend(() =>
										subscriptions.recaps({ sessionId, turnId }),
									),
									() => undefined,
								).pipe(
									Stream.takeUntil(
										(snapshot) => !watch && !snapshot.generating,
									),
								),
								(snapshot) =>
									Effect.sync(() => {
										if (cancelled || request !== this.#request) return;
										this.#merge(snapshot.versions);
										this.#remoteGenerating = snapshot.generating;
										this.generating =
											this.#manualGenerating || snapshot.generating;
										if (!this.#manualGenerating) {
											this.error = snapshot.error ?? "";
											this.retry = snapshot.retry ?? null;
										}
									}),
							),
						),
					),
				);
				stop = () => {
					void runTransportEffect(Fiber.interrupt(feed));
				};
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
			stop?.();
		};
	}

	async generate(
		sessionId: string,
		turnId: string,
		scope: "whole" | "new",
		sourceVersion?: number,
	): Promise<void> {
		if (this.#manualGenerating || this.generating) return;
		const identity = this.#identity;
		this.#manualGenerating = true;
		this.generating = true;
		this.error = "";
		this.retry = {
			scope,
			...(sourceVersion === undefined ? {} : { sourceVersion }),
		};
		try {
			const version = await rpc("GenerateRecap", {
				sessionId,
				turnId,
				scope,
				...(sourceVersion === undefined ? {} : { sourceVersion }),
			});
			if (identity !== this.#identity) return;
			this.#merge([version]);
			this.selected = version.version;
			this.retry = null;
		} catch (error) {
			if (identity === this.#identity)
				this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (identity === this.#identity) {
				this.#manualGenerating = false;
				this.generating = this.#remoteGenerating;
			}
		}
	}
}
