// Replaces the imperative config-persistence.ts with an Effect-based module.
// Uses @effect/platform FileSystem for testability and atomic writes with
// coalesced saves to avoid write contention under rapid state changes.

import { FileSystem } from "@effect/platform";
import { Context, Effect, Ref } from "effect";
import { migrateProjectFolders } from "../../../daemon/config-persistence.js";
import type { DaemonState } from "./daemon-state.js";
import { DaemonStateTag } from "./daemon-state.js";

/** Path to the daemon.json config file on disk. */
export class PersistencePathTag extends Context.Service<
	PersistencePathTag,
	string
>()("PersistencePath") {}

/** Serialize persisted fields of DaemonState to a JSON-safe object. */
function serializeState(state: DaemonState) {
	return {
		pid: state.pid,
		port: state.port,
		host: state.host,
		pinHash: state.pinHash,
		tls: state.tls,
		...(state.tlsCertPath !== undefined && { tlsCertPath: state.tlsCertPath }),
		...(state.tlsKeyPath !== undefined && { tlsKeyPath: state.tlsKeyPath }),
		debug: state.debug,
		keepAwake: state.keepAwake,
		...(state.keepAwakeCommand !== undefined && {
			keepAwakeCommand: state.keepAwakeCommand,
		}),
		...(state.keepAwakeArgs !== undefined && {
			keepAwakeArgs: state.keepAwakeArgs,
		}),
		projects: state.projects.map(migrateProjectFolders),
		instances: state.instances,
	};
}

/**
 * Atomic write helper: write to a temp file, then rename to target path.
 */
const atomicWrite = (
	fs: FileSystem.FileSystem,
	targetPath: string,
	data: string,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		const tmpPath = `${targetPath}.tmp.${Date.now()}`;

		// Ensure the parent directory exists
		const dirPath = targetPath.substring(0, targetPath.lastIndexOf("/"));
		if (dirPath.length > 0) {
			yield* fs
				.makeDirectory(dirPath, { recursive: true })
				.pipe(Effect.catchAll(() => Effect.void));
		}

		yield* fs.writeFileString(tmpPath, data).pipe(
			Effect.catchAll((err) => {
				return Effect.logWarning(`Failed to write temp file: ${err.message}`);
			}),
		);
		yield* fs.rename(tmpPath, targetPath).pipe(
			Effect.catchAll((err) => {
				return Effect.logWarning(`Failed to rename temp file: ${err.message}`);
			}),
		);
	});

/**
 * Internal save loop. Performs one atomic write, then checks if a resave is
 * needed. Uses an iterative approach (not recursive) for stack safety.
 */
const doSave = (
	fs: FileSystem.FileSystem,
	configPath: string,
	ref: Ref.Ref<DaemonState>,
): Effect.Effect<void, never, never> =>
	Effect.gen(function* () {
		let shouldContinue = true;

		while (shouldContinue) {
			// Read current state and serialize
			const state = yield* Ref.get(ref);
			const json = JSON.stringify(serializeState(state), null, 2);

			// Write atomically
			yield* atomicWrite(fs, configPath, json);

			// Check-and-clear needsResave atomically
			const resaveNeeded = yield* Ref.modify(ref, (s) => {
				if (s.needsResave) {
					return [true, { ...s, needsResave: false }] as const;
				}
				return [false, { ...s, pendingSave: false }] as const;
			});

			if (resaveNeeded) {
				// Yield to scheduler before re-entering, ensuring stack safety
				yield* Effect.yieldNow();
			} else {
				shouldContinue = false;
			}
		}
	});

/**
 * Persist the current DaemonState to disk with coalesced saves.
 *
 * If a save is already in progress (pendingSave=true), sets needsResave=true
 * and returns immediately. The in-progress save will pick up the flag and
 * do one more write after completing.
 *
 * Uses `Ref.modify` for atomic check-and-set of the pendingSave flag.
 */
export const persistConfig: Effect.Effect<
	void,
	never,
	DaemonStateTag | FileSystem.FileSystem | PersistencePathTag
> = Effect.gen(function* () {
	const ref = yield* DaemonStateTag;
	const configPath = yield* PersistencePathTag;
	const fs = yield* FileSystem.FileSystem;

	// Atomically check-and-set pendingSave
	const shouldSave = yield* Ref.modify(ref, (s) => {
		if (s.pendingSave) {
			// Already saving — mark for resave
			return [false, { ...s, needsResave: true }] as const;
		}
		// Not saving — claim the save slot
		return [true, { ...s, pendingSave: true }] as const;
	});

	if (!shouldSave) {
		// Another fiber is already saving; it will pick up needsResave
		return;
	}

	// We own the save slot — perform the write (with resave loop)
	yield* doSave(fs, configPath, ref);
});
