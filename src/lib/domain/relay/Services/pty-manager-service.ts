// ─── PtyManagerState Ref & Tag ───────────────────────────────────────────────
// Effect-native state for PTY session management. Replaces the mutable
// Map<string, PtySessionState> on the imperative PtyManager class with
// a single atomic Ref<HashMap<string, PtySessionState>>.
//
// Pattern (mirrors SessionRegistryState):
//   PtyManagerStateTag → Ref.Ref<PtyManagerState>
//   PtyManagerStateLive → Layer providing the Tag
//   Pure functions: registerPtySession, removePtySession, getPtySession,
//                   listPtySessions

import { Context, Effect, HashMap, Layer, Ref } from "effect";
import type { PtySessionState } from "../../../relay/pty-manager.js";
import type { PtyStatus } from "../../../shared-types.js";

// ─── State type ─────────────────────────────────────────────────────────────

export interface PtyManagerState {
	readonly sessions: HashMap.HashMap<string, PtySessionState>;
}

// ─── Context Tag ────────────────────────────────────────────────────────────

/** Tag for the mutable PTY session HashMap Ref in the Effect Context. */
export class PtyManagerStateTag extends Context.Tag("PtyManagerState")<
	PtyManagerStateTag,
	Ref.Ref<PtyManagerState>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

export const PtyManagerStateLive: Layer.Layer<PtyManagerStateTag> =
	Layer.effect(
		PtyManagerStateTag,
		Ref.make<PtyManagerState>({ sessions: HashMap.empty() }),
	);

// ─── Pure functions ─────────────────────────────────────────────────────────

export const registerPtySession = (
	sessionId: string,
	session: PtySessionState,
) =>
	Effect.gen(function* () {
		const ref = yield* PtyManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			sessions: HashMap.set(s.sessions, sessionId, session),
		}));
	}).pipe(Effect.annotateLogs("sessionId", sessionId));

export const removePtySession = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PtyManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			sessions: HashMap.remove(s.sessions, sessionId),
		}));
	}).pipe(Effect.annotateLogs("sessionId", sessionId));

export const getPtySession = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PtyManagerStateTag;
		const state = yield* Ref.get(ref);
		return HashMap.get(state.sessions, sessionId);
	});

export const listPtySessions = Effect.gen(function* () {
	const ref = yield* PtyManagerStateTag;
	const state = yield* Ref.get(ref);
	return HashMap.toEntries(state.sessions).map(
		([id, s]): { id: string; status: PtyStatus } => ({
			id,
			status: s.exited ? "exited" : "running",
		}),
	);
});

export const hasPtySession = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PtyManagerStateTag;
		const state = yield* Ref.get(ref);
		return HashMap.has(state.sessions, sessionId);
	});
