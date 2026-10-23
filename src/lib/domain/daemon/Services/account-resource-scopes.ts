import { Context, type Effect, type Scope } from "effect";

export interface AccountResourceScopeOwner<A, E = never> {
	/**
	 * Retains demand for the whole operation, including turns, pending prompts
	 * and background work. Invalidation interrupts the operation's fiber.
	 */
	readonly use: <B, E2, R>(
		accountId: string,
		work: (resource: A) => Effect.Effect<B, E2, R>,
	) => Effect.Effect<B, E | E2, R>;
}

export class AccountResourceScopesTag extends Context.Service<
	AccountResourceScopesTag,
	{
		/** Create once per resource kind; opens capture their services here. */
		readonly make: <A, E, R>(
			open: (accountId: string) => Effect.Effect<A, E, R | Scope.Scope>,
		) => Effect.Effect<AccountResourceScopeOwner<A, E>, never, R>;
		/** Invalidates the exact id across resource kinds, without resolving aliases. */
		readonly invalidate: (accountId: string) => Effect.Effect<void>;
	}
>()("AccountResourceScopes") {}
