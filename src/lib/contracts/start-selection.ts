import { MANAGED_OPENCODE_ACCOUNT_ID } from "./account.js";

/** Resolve a draft start from the account snapshot without changing the saved default. */
export function openCodeStartSelection(
	accounts: readonly {
		readonly id: string;
		readonly driver?: string | undefined;
		readonly isDefault?: boolean | undefined;
		readonly status?: string | undefined;
	}[],
): { account: { _tag: "Id"; id: string }; fallback?: "unreachable" } {
	const selected = accounts.find(
		(account) => account.driver === "opencode" && account.isDefault,
	);
	if (selected && selected.id !== MANAGED_OPENCODE_ACCOUNT_ID) {
		if (selected.status === "healthy")
			return { account: { _tag: "Id", id: selected.id } };
		return {
			account: { _tag: "Id", id: MANAGED_OPENCODE_ACCOUNT_ID },
			fallback: "unreachable",
		};
	}
	return { account: { _tag: "Id", id: MANAGED_OPENCODE_ACCOUNT_ID } };
}
