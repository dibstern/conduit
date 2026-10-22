import type { Effect } from "effect";
import type { Account } from "../contracts/account.js";
import type { ClaudeConfigDir } from "../contracts/claude-config-dir.js";
import type { UsageReading } from "../contracts/limit-recovery.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";

export const usageAccounts = (accounts: readonly Account[]): UsageAccount[] =>
	accounts.flatMap((account) => {
		const harness = PROVIDER_DRIVERS[account.driver].usageHarness;
		return harness !== undefined && account.usageEligible
			? [
					{
						id: account.id,
						harness,
						...(account.driver === "codex" && account.configuredFolder
							? { configDir: account.configuredFolder }
							: {}),
						...("folder" in account ? { folder: account.folder } : {}),
						...(account.env ? { env: account.env } : {}),
					},
				]
			: [];
	});

export interface UsageAccount {
	readonly id: string;
	readonly harness: UsageReading["harness"];
	readonly configDir?: string;
	readonly folder?: ClaudeConfigDir;
	readonly env?: Readonly<Record<string, string>> | undefined;
}

export type UsageRead = Pick<
	UsageReading,
	"status" | "planLabel" | "windows" | "reason"
>;

/** Each harness translates its own response into the shared usage contract. */
export interface UsageReader {
	readonly read: (account: UsageAccount) => Effect.Effect<UsageRead, unknown>;
}
