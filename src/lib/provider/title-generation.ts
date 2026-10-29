import { Effect, Result } from "effect";
import type { Account } from "../contracts/account.js";
import {
	BUILTIN_TITLE_GENERATION,
	type TitleGenerationSelection,
} from "../contracts/title-generation.js";
import type { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { resolveTurnSettings } from "./turn-settings.js";
import type { ModelInfo } from "./types.js";

/** Deleted title accounts stay missing; only driver defaults may fall back. */
export function resolveTitleGenerationAccount(
	stored: TitleGenerationSelection | null | undefined,
	directory: AccountDirectory["Service"],
): Effect.Effect<Account | undefined> {
	const reference = (stored ?? BUILTIN_TITLE_GENERATION).account;
	return reference._tag === "Id"
		? Effect.map(directory.snapshot, (state) =>
				state.accounts.find((account) => account.id === reference.id),
			)
		: directory.resolve(reference).pipe(Effect.orElseSucceed(() => undefined));
}

/** Resolve a title selection without account I/O or catalog discovery. */
export function resolveTitleGeneration(
	stored: TitleGenerationSelection | null | undefined,
	account: Account | undefined,
	catalogFor: (account: Account) => readonly ModelInfo[] | undefined,
): {
	readonly status: "ok" | "missing" | "invalid" | "unverified";
	readonly problem?: string;
} {
	const selection = stored ?? BUILTIN_TITLE_GENERATION;
	if (!account)
		return {
			status: "missing",
			problem: "Title generation account does not exist",
		};
	const catalog = catalogFor(account);
	const resolved = resolveTurnSettings(
		{
			harness: account.driver,
			model: { providerId: selection.providerId, modelId: selection.modelId },
			effort: selection.effort,
			contextWindow: "",
		},
		catalog,
	);
	if (Result.isFailure(resolved))
		return { status: "invalid", problem: resolved.failure.message };
	return {
		status: catalog === undefined ? "unverified" : "ok",
	};
}
