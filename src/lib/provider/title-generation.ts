import { Result } from "effect";
import { type AccountsState, resolve } from "../account-directory.js";
import type { Account } from "../contracts/account.js";
import {
	BUILTIN_TITLE_GENERATION,
	type TitleGenerationSelection,
} from "../contracts/title-generation.js";
import { resolveTurnSettings } from "./turn-settings.js";
import type { ModelInfo } from "./types.js";

/** Resolve a title selection without account I/O or catalog discovery. */
export function resolveTitleGeneration(
	stored: TitleGenerationSelection | null | undefined,
	accounts: AccountsState,
	catalogFor: (account: Account) => readonly ModelInfo[] | undefined,
): {
	readonly pick: TitleGenerationSelection;
	readonly status: "ok" | "missing" | "invalid" | "unverified";
	readonly problem?: string;
} {
	const selection = stored ?? BUILTIN_TITLE_GENERATION;
	// Session routing can redirect deleted ids; a saved title choice must report
	// the missing account so its caller can apply the built-in title default.
	const reference = selection.account;
	const account =
		reference._tag === "Id"
			? accounts.accounts.find((candidate) => candidate.id === reference.id)
			: Result.getOrUndefined(resolve(accounts, reference));
	if (!account)
		return {
			pick: selection,
			status: "missing",
			problem: "Title generation account does not exist",
		};
	const pick: TitleGenerationSelection = {
		...selection,
		account: { _tag: "Id", id: account.id },
	};
	// driver-dispatch-ok: title generation is enabled as each adapter lands.
	if (!["claude", "cursor"].includes(account.driver))
		return {
			pick,
			status: "invalid",
			problem: "Title generation is not available for this account",
		};
	const catalog = catalogFor(account);
	const resolved = resolveTurnSettings(
		{
			harness: account.driver,
			model: { providerId: pick.providerId, modelId: pick.modelId },
			effort: pick.effort,
			contextWindow: "",
		},
		catalog,
	);
	if (Result.isFailure(resolved))
		return { pick, status: "invalid", problem: resolved.failure.message };
	return {
		pick,
		status: catalog === undefined ? "unverified" : "ok",
	};
}
