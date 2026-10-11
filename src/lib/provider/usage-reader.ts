import type { Effect } from "effect";
import type { UsageReading } from "../contracts/limit-recovery.js";

export interface UsageAccount {
	readonly id: string;
	readonly harness: UsageReading["harness"];
	readonly configDir?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export type UsageRead = Pick<
	UsageReading,
	"status" | "planLabel" | "windows" | "reason"
>;

/** Each harness translates its own response into the shared usage contract. */
export interface UsageReader {
	readonly read: (account: UsageAccount) => Effect.Effect<UsageRead, unknown>;
}
