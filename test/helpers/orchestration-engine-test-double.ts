import { Effect } from "effect";
import { vi } from "vitest";
import type { OrchestrationEngine } from "../../src/lib/provider/orchestration-engine.js";

export function withDispatchEffect<T extends object>(
	engine: T,
): T & OrchestrationEngine {
	const mutable = engine as T & {
		dispatch?: (command: unknown) => Promise<unknown>;
		dispatchEffect?: (command: unknown) => Effect.Effect<unknown, unknown>;
		getProviderForSession?: (sessionId: string) => string | undefined;
		bindSession?: (sessionId: string, providerId: string) => void;
		unbindSession?: (sessionId: string) => void;
	};
	const bindings = new Map<string, string>();
	const originalGetProviderForSession =
		mutable.getProviderForSession?.bind(mutable);
	mutable.getProviderForSession = vi.fn((sessionId: string) => {
		const boundProviderId = bindings.get(sessionId);
		return boundProviderId ?? originalGetProviderForSession?.(sessionId);
	});
	mutable.bindSession = vi.fn((sessionId: string, providerId: string) => {
		bindings.set(sessionId, providerId);
	});
	mutable.unbindSession = vi.fn((sessionId: string) => {
		bindings.delete(sessionId);
	});
	if (!mutable.dispatchEffect && mutable.dispatch) {
		mutable.dispatchEffect = vi.fn((command: unknown) =>
			Effect.tryPromise(() => Promise.resolve(mutable.dispatch?.(command))),
		);
	}
	return mutable as T & OrchestrationEngine;
}
