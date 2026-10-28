import { MANAGED_OPENCODE_ACCOUNT_ID } from "./account.js";
import { getProviderDriver } from "./provider-instance.js";

/** The first configured OpenCode endpoint, excluding no-server placeholders. */
export const openCodeInstanceFor = <
	I extends {
		readonly id: string;
		readonly driver?: string | undefined;
		readonly managed?: boolean | undefined;
		readonly port?: number | undefined;
		readonly url?: string | undefined;
	},
>(
	instances: readonly I[],
): I | undefined =>
	instances.find((instance) => {
		if (!getProviderDriver(instance.driver ?? "opencode")?.runsOpenCodeServer)
			return false;
		if (instance.managed === true || (instance.port ?? 0) > 0) return true;
		if (instance.url !== undefined)
			return URL.canParse(instance.url) && new URL(instance.url).port !== "0";
		return instance.port === undefined;
	});

/** Resolve a draft start from the account snapshot without changing the saved default. */
export function openCodeStartSelection(
	accounts: readonly {
		readonly id: string;
		readonly driver?: string | undefined;
		readonly isDefault?: boolean | undefined;
		readonly status?: string | undefined;
		readonly managed?: boolean | undefined;
		readonly port?: number | undefined;
		readonly url?: string | undefined;
	}[],
): { account: { _tag: "Id"; id: string }; fallback?: "unreachable" } {
	const selected =
		accounts.find(
			(account) => account.driver === "opencode" && account.isDefault,
		) ?? openCodeInstanceFor(accounts);
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
