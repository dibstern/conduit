import { Effect, Layer } from "effect";
import { makeSubprocess, Subprocess } from "../Services/subprocess.js";

/** An isolated scoped override for the daemon and interface tests. */
export const makeSubprocessLive = (
	options: { readonly concurrency?: number } = {},
) =>
	Layer.effect(
		Subprocess,
		Effect.gen(function* () {
			const owner = makeSubprocess(options);
			yield* Effect.addFinalizer(() => owner.shutdown);
			return owner;
		}),
	);

export const SubprocessLive = makeSubprocessLive();
