import { Context, type Effect } from "effect";
import type {
	CategorySetContents,
	CategorySetRejected,
	CategorySet as CategorySetSnapshot,
} from "../../../contracts/category-set.js";
import type { WsRpcError } from "../../../contracts/ws-rpc.js";

/** The daemon's only category writer. Replacements are complete, versioned sets. */
export class CategorySet extends Context.Service<
	CategorySet,
	{
		readonly current: () => Effect.Effect<CategorySetSnapshot>;
		readonly criteriaAtVersion: (
			version: number,
		) => Effect.Effect<string | undefined>;
		readonly replace: (
			expectedVersion: number,
			nextSet: CategorySetContents,
		) => Effect.Effect<CategorySetSnapshot, CategorySetRejected | WsRpcError>;
	}
>()("CategorySet") {}
