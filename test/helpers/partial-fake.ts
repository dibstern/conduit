/**
 * Types a hand-written test double as the full interface it stands in for.
 * Supplied members are still type-checked; tests must only exercise those.
 */
export function partialFake<T>(fake: Partial<T>): T {
	return fake as T;
}
