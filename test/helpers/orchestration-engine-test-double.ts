import { Effect } from "effect";
import { vi } from "vitest";
import type { OrchestrationEngine } from "../../src/lib/provider/orchestration-engine.js";

export function withDispatchEffect<T extends object>(
	engine: T,
): T & OrchestrationEngine {
	const mutable = engine as T & {
		dispatch?: (command: unknown) => Promise<unknown>;
		dispatchEffect?: (command: unknown) => Effect.Effect<unknown, unknown>;
	};
	if (!mutable.dispatchEffect && mutable.dispatch) {
		mutable.dispatchEffect = vi.fn((command: unknown) =>
			Effect.tryPromise(() => Promise.resolve(mutable.dispatch?.(command))),
		);
	}
	return mutable as T & OrchestrationEngine;
}
