// ─── SessionRegistryState Ref & Tag ─────────────────────────────────────────
// Replaces the mutable Map<clientId, sessionId> on the imperative
// SessionRegistry class with a single atomic Ref<HashMap<string, string>>.
// All client-session tracking reads/writes through this Ref, giving
// fiber-safe atomic snapshots.
//
// Pattern (mirrors SessionManagerState):
//   SessionRegistryStateTag → Ref.Ref<HashMap<string, string>>
//   makeSessionRegistryStateLive() → Layer providing the Tag
//   Pure functions: setClientSession, getClientSession, removeClient,
//                   getClientsForSession

import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";

// ─── Context Tag ────────────────────────────────────────────────────────────

/** Tag for the mutable client→session HashMap Ref in the Effect Context. */
export class SessionRegistryStateTag extends Context.Tag(
	"SessionRegistryState",
)<SessionRegistryStateTag, Ref.Ref<HashMap.HashMap<string, string>>>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

/**
 * Create a Layer providing SessionRegistryStateTag backed by a Ref.
 *
 * @param initial - Optional initial HashMap. Defaults to empty.
 */
export const makeSessionRegistryStateLive = (
	initial?: HashMap.HashMap<string, string>,
): Layer.Layer<SessionRegistryStateTag> =>
	Layer.effect(
		SessionRegistryStateTag,
		Ref.make(initial ?? HashMap.empty<string, string>()),
	);

// ─── Pure functions ─────────────────────────────────────────────────────────

/**
 * Set which session a client is viewing.
 * No-op if the client is already viewing the given session.
 */
export const setClientSession = (clientId: string, sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionRegistryStateTag;
		yield* Ref.update(ref, (map) => {
			const existing = HashMap.get(map, clientId);
			if (Option.isSome(existing) && existing.value === sessionId) {
				return map; // no-op — same session
			}
			return HashMap.set(map, clientId, sessionId);
		});
	});

/**
 * Get the session a client is viewing.
 * Returns Option<string> — None if the client is not registered.
 */
export const getClientSession = (clientId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionRegistryStateTag;
		const map = yield* Ref.get(ref);
		return HashMap.get(map, clientId);
	});

/**
 * Remove a client entirely.
 * Returns Option<string> — the session they were viewing, or None.
 */
export const removeClient = (clientId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionRegistryStateTag;
		const previous = yield* Ref.modify(ref, (map) => {
			const session = HashMap.get(map, clientId);
			return [session, HashMap.remove(map, clientId)] as const;
		});
		return previous;
	});

/**
 * Get all client IDs viewing a specific session.
 */
export const getClientsForSession = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionRegistryStateTag;
		const map = yield* Ref.get(ref);
		const result: string[] = [];
		for (const [clientId, sid] of map) {
			if (sid === sessionId) result.push(clientId);
		}
		return result;
	});
