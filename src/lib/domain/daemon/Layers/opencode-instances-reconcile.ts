// Recovery for state the shared OpenCode stream can miss: prompts asked while
// disconnected, and status transitions whose events were lost. Results are
// emitted as ordinary stream payloads so relays cannot tell them apart.

import type { SessionStatus } from "../../../contracts/providers/opencode-sdk.js";
import type { Logger } from "../../../logger.js";

/** Directory-scoped reads. `OpenCodeAPI` satisfies this structurally. */
export interface OpenCodeReconcileClient {
	readonly session: {
		statuses(directory: string): Promise<Record<string, SessionStatus>>;
	};
	readonly permission: {
		list(directory: string): Promise<ReadonlyArray<{ readonly id: string }>>;
	};
	readonly question: {
		list(directory: string): Promise<ReadonlyArray<{ readonly id: string }>>;
	};
}

export interface OpenCodePayload {
	readonly id: string;
	readonly type: string;
	readonly properties?: Readonly<Record<string, unknown>> | undefined;
}

export type EmitToDirectory = (
	directory: string,
	payload: OpenCodePayload,
) => void;

const STATUS_POLL_INTERVAL_MS = 3_000;

const isBusy = (status: SessionStatus) =>
	status.type === "busy" || status.type === "retry";

let sequence = 0;
const payload = (
	type: string,
	properties: Readonly<Record<string, unknown>>,
): OpenCodePayload => ({
	id: `evt_reconcile_${Date.now()}_${++sequence}`,
	type,
	properties,
});

const statusPayload = (sessionID: string, status: SessionStatus) =>
	payload("session.status", { sessionID, status });

/**
 * Tracks busy sessions and pending prompts per canonical directory from routed
 * events, polls `/session/status` while any are busy, and lists pending prompts
 * on demand. `onChange` fires when `active()` flips.
 */
export const createOpenCodeReconciler = (options: {
	readonly emit: EmitToDirectory;
	readonly log: Logger;
	readonly pollIntervalMs?: number;
	readonly onChange?: () => void;
}) => {
	const busy = new Map<string, Map<string, SessionStatus>>();
	// Pending prompt keys ("permission:<id>", "question:<id>") per directory.
	const pending = new Map<string, Set<string>>();
	// A removed and re-added directory must not accept its previous reads.
	const generations = new Map<string, symbol>();
	// Order of each session's latest streamed status. A status read answers
	// with the state when it was sent, so it must not overwrite a session whose
	// status streamed in after that.
	let statusOrder = 0;
	const statusChanged = new Map<string, Map<string, number>>();
	const changedSince = (directory: string, sessionID: string, sent: number) =>
		(statusChanged.get(directory)?.get(sessionID) ?? 0) > sent;
	let client: OpenCodeReconcileClient | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let wasActive = false;

	const active = () => busy.size > 0 || pending.size > 0;
	const settle = () => {
		if (active() === wasActive) return;
		wasActive = !wasActive;
		options.onChange?.();
	};

	const setPending = (directory: string, keys: Iterable<string>) => {
		const next = new Set(keys);
		if (next.size > 0) pending.set(directory, next);
		else pending.delete(directory);
	};

	const track = (
		directory: string,
		sessionID: string,
		status: SessionStatus,
	) => {
		const sessions = busy.get(directory) ?? new Map<string, SessionStatus>();
		if (isBusy(status)) sessions.set(sessionID, status);
		else sessions.delete(sessionID);
		if (sessions.size > 0) busy.set(directory, sessions);
		else busy.delete(directory);
	};

	/**
	 * Settle tracked sessions that are no longer busy for every subscriber of
	 * the directory. Busy sessions go to `snapshot` when given (a reconcile),
	 * otherwise only changed ones are emitted (a poll).
	 */
	const correct = (
		directory: string,
		statuses: Record<string, SessionStatus>,
		sent: number,
		snapshot?: EmitToDirectory,
	) => {
		const tracked = new Map(busy.get(directory));
		for (const sessionID of tracked.keys()) {
			// OpenCode omits idle sessions from the status map.
			const status = statuses[sessionID] ?? { type: "idle" };
			if (isBusy(status) || changedSince(directory, sessionID, sent)) continue;
			track(directory, sessionID, status);
			options.emit(directory, statusPayload(sessionID, status));
		}
		for (const [sessionID, status] of Object.entries(statuses)) {
			if (!isBusy(status) || changedSince(directory, sessionID, sent)) continue;
			const changed = tracked.get(sessionID)?.type !== status.type;
			track(directory, sessionID, status);
			if (snapshot) snapshot(directory, statusPayload(sessionID, status));
			else if (changed)
				options.emit(directory, statusPayload(sessionID, status));
		}
		settle();
	};

	const schedule = () => {
		if (timer || !client || busy.size === 0) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				const current = client;
				if (!current) return;
				const sent = statusOrder;
				void Promise.all(
					[...busy.keys()].map((directory) => {
						const generation = generations.get(directory);
						return current.session.statuses(directory).then(
							(statuses) => {
								if (
									client === current &&
									generations.get(directory) === generation
								)
									correct(directory, statuses, sent);
							},
							(error: unknown) =>
								options.log.debug("OpenCode status poll failed", {
									directory,
									error,
								}),
						);
					}),
				).finally(schedule);
			},
			options.pollIntervalMs ??
				(process.env["NODE_ENV"] === "test"
					? Number(
							process.env["CONDUIT_TEST_OPENCODE_STATUS_POLL_INTERVAL_MS"] ??
								STATUS_POLL_INTERVAL_MS,
						)
					: STATUS_POLL_INTERVAL_MS),
		);
		timer.unref?.();
	};

	return {
		/** Busy or retrying sessions, or pending prompts, in any directory. */
		active,

		/** Feed every routed stream payload so polling follows streamed status. */
		observe(directory: string, event: OpenCodePayload) {
			generations.set(directory, generations.get(directory) ?? Symbol());
			const [kind, action] = event.type.split(".");
			const id =
				action === "asked"
					? event.properties?.["id"]
					: event.properties?.["requestID"];
			if (
				(kind === "permission" || kind === "question") &&
				(action === "asked" || action === "replied" || action === "rejected") &&
				typeof id === "string"
			) {
				const keys = new Set(pending.get(directory));
				if (action === "asked") keys.add(`${kind}:${id}`);
				else keys.delete(`${kind}:${id}`);
				setPending(directory, keys);
				settle();
				return;
			}
			if (event.type !== "session.status") return;
			const sessionID = event.properties?.["sessionID"];
			const status = event.properties?.["status"];
			if (
				typeof sessionID !== "string" ||
				typeof status !== "object" ||
				status === null ||
				!("type" in status) ||
				(status.type !== "busy" &&
					status.type !== "idle" &&
					status.type !== "retry")
			)
				return;
			const changed = statusChanged.get(directory) ?? new Map<string, number>();
			statusChanged.set(directory, changed.set(sessionID, ++statusOrder));
			track(directory, sessionID, status as SessionStatus);
			settle();
			schedule();
		},

		/**
		 * List busy sessions and pending prompts once per directory. `emit`
		 * defaults to every subscriber of the directory; a late subscriber passes
		 * its own so others never see the replay. Resolves false when any
		 * directory could not be read.
		 */
		async reconcile(
			next: OpenCodeReconcileClient,
			directories: Iterable<string>,
			emit: EmitToDirectory = options.emit,
		) {
			client = next;
			const read = await Promise.all(
				[...new Set(directories)].map(async (directory) => {
					const generation = generations.get(directory) ?? Symbol();
					generations.set(directory, generation);
					const sent = statusOrder;
					const lists = await Promise.all([
						next.session.statuses(directory),
						next.permission.list(directory),
						next.question.list(directory),
					]).catch((error: unknown) => {
						options.log.warn("OpenCode reconcile failed", { directory, error });
						return undefined;
					});
					if (client !== next || generations.get(directory) !== generation)
						return true;
					if (!lists) return false;
					const [statuses, permissions, questions] = lists;
					correct(directory, statuses, sent, emit);
					setPending(directory, [
						...permissions.map(({ id }) => `permission:${id}`),
						...questions.map(({ id }) => `question:${id}`),
					]);
					settle();
					for (const item of permissions)
						emit(directory, payload("permission.asked", item));
					for (const item of questions)
						emit(directory, payload("question.asked", item));
					return true;
				}),
			);
			schedule();
			return read.every(Boolean);
		},

		/** Release all demand when a directory loses its last subscriber. */
		forget(directory: string) {
			generations.delete(directory);
			statusChanged.delete(directory);
			busy.delete(directory);
			pending.delete(directory);
			if (busy.size === 0 && timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			settle();
		},

		reset() {
			if (timer) clearTimeout(timer);
			timer = undefined;
			client = undefined;
			busy.clear();
			pending.clear();
			generations.clear();
			statusChanged.clear();
			wasActive = false;
		},
	};
};
