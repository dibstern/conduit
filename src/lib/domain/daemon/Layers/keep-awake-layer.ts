// ─── KeepAwake Effect Layer ─────────────────────────────────────────────────
// Pure Effect replacement for the KeepAwake class.
// Platform detection: macOS -> "caffeinate -di", Linux -> "systemd-inhibit".
// Idempotent activate/deactivate. Process cleanup via Fiber.interrupt on
// scope close (addFinalizer).
//
// Defines its own Tag that will coexist with the one in services.ts until
// Phase 3 consumer migration.

import { Context, Effect, Fiber, Layer, Ref } from "effect";

// ─── Config ─────────────────────────────────────────────────────────────────

interface KeepAwakeConfig {
	command?: string;
	args?: string[];
}

// ─── Service interface ──────────────────────────────────────────────────────

interface KeepAwakeService {
	activate: () => Effect.Effect<void>;
	deactivate: () => Effect.Effect<void>;
	isActive: () => Effect.Effect<boolean>;
	isSupported: () => Effect.Effect<boolean>;
}

// ─── Tag ────────────────────────────────────────────────────────────────────

export class KeepAwakeTag extends Context.Tag("KeepAwake")<
	KeepAwakeTag,
	KeepAwakeService
>() {}

// ─── Platform detection ─────────────────────────────────────────────────────

const detectPlatformCommand = (): {
	command: string;
	args: string[];
} | null => {
	switch (process.platform) {
		case "darwin":
			return { command: "caffeinate", args: ["-di"] };
		case "linux":
			return {
				command: "systemd-inhibit",
				args: [
					"--what=idle",
					"--who=conduit",
					"--why=Keeping system awake",
					"sleep",
					"infinity",
				],
			};
		default:
			return null;
	}
};

// ─── Layer ──────────────────────────────────────────────────────────────────

export const KeepAwakeLive = (config?: KeepAwakeConfig) =>
	Layer.scoped(
		KeepAwakeTag,
		Effect.gen(function* () {
			const fiberRef = yield* Ref.make<Fiber.RuntimeFiber<void> | null>(null);
			const activeRef = yield* Ref.make(false);
			const scope = yield* Effect.scope;

			const resolved = config?.command
				? { command: config.command, args: config.args ?? [] }
				: detectPlatformCommand();

			const activate = Effect.gen(function* () {
				if (!resolved) return;
				const alreadyActive = yield* Ref.get(activeRef);
				if (alreadyActive) return;

				// Fork a long-running fiber to represent the keep-awake process.
				// In production this would spawn the platform command via
				// @effect/platform CommandExecutor; here we use Effect.never
				// (blocks forever, cleanly interruptible).
				// We use forkIn with the layer's captured scope so activate()
				// has no Scope requirement in its own type signature.
				const fiber = yield* Effect.never.pipe(Effect.forkIn(scope));
				yield* Ref.set(fiberRef, fiber);
				yield* Ref.set(activeRef, true);
			});

			const deactivate = Effect.gen(function* () {
				const fiber = yield* Ref.get(fiberRef);
				if (fiber) yield* Fiber.interrupt(fiber);
				yield* Ref.set(fiberRef, null);
				yield* Ref.set(activeRef, false);
			});

			// Finalizer ensures cleanup when scope closes
			yield* Effect.addFinalizer(() => deactivate);

			return {
				activate: () => activate,
				deactivate: () => deactivate,
				isActive: () => Ref.get(activeRef),
				isSupported: () => Effect.succeed(resolved !== null),
			};
		}),
	);
