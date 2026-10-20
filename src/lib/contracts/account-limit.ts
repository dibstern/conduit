import type {
	LimitRecovery,
	UsageReading,
	UsageWindow,
} from "./limit-recovery.js";

export type AccountLimitAsker = "user" | "automatic";

export type AccountLimit =
	| { readonly kind: "go" }
	| {
			readonly kind: "wait-until";
			readonly until: number;
			readonly label: string;
	  }
	| { readonly kind: "wait" }
	| { readonly kind: "signed-out" };

export function accountLimitWindowLabel(window: UsageWindow | string): string {
	if (typeof window !== "string" && window.kind === "seven_day_model") {
		return `${window.model ?? "model"} weekly limit`;
	}
	const kind = typeof window === "string" ? window : window.kind;
	if (kind === "five_hour") return "5-hour limit";
	if (kind === "seven_day") return "weekly limit";
	if (kind === "month") return "monthly limit";
	if (kind.startsWith("seven_day_")) {
		return `${kind.slice("seven_day_".length).replace(/^./, (letter) => letter.toUpperCase())} weekly limit`;
	}
	return "usage limit";
}

export const accountLimit = (input: {
	readonly asker: AccountLimitAsker;
	readonly reading?: UsageReading;
	readonly recovery?: LimitRecovery;
	readonly now: number;
}): AccountLimit => {
	const { asker, reading, recovery, now } = input;
	if (reading?.status === "unavailable") return { kind: "signed-out" };

	const takenAfterLimit =
		recovery === undefined ||
		(recovery.limitedAt !== undefined &&
			reading !== undefined &&
			reading.readAt > recovery.limitedAt);
	const windows = takenAfterLimit ? (reading?.windows ?? []) : [];

	// All full plan windows must reset before the account can go again.
	let fullWindow: UsageWindow | undefined;
	let fullReset: number | undefined;
	for (const window of windows) {
		if (
			reading?.status === "unknown" ||
			window.kind === "seven_day_model" ||
			window.utilization < 100
		)
			continue;
		const reset = Date.parse(window.resetsAt ?? "");
		if (
			Number.isFinite(reset) &&
			(fullReset === undefined || reset > fullReset)
		) {
			fullWindow = window;
			fullReset = reset;
		}
	}
	if (fullWindow !== undefined && fullReset !== undefined && now < fullReset) {
		return {
			kind: "wait-until",
			until: fullReset,
			label: accountLimitWindowLabel(fullWindow),
		};
	}

	const limitingWindow = recovery
		? windows.find(
				(window) =>
					window.kind === recovery.rateLimitType ||
					(window.kind === "seven_day_model" &&
						window.model !== undefined &&
						recovery.rateLimitType ===
							`seven_day_${window.model.toLowerCase()}`),
			)
		: undefined;
	const readingReset = Date.parse(limitingWindow?.resetsAt ?? "");
	const reset = recovery
		? Number.isFinite(readingReset)
			? readingReset
			: recovery.resetsAt === undefined
				? undefined
				: recovery.resetsAt * 1_000
		: fullReset;
	if (reset !== undefined && now >= reset) return { kind: "go" };

	if (
		reading?.status === "available" &&
		!reading.stale &&
		takenAfterLimit &&
		(recovery === undefined ||
			(!recovery.timeOnly &&
				(recovery.rateLimitType === "five_hour" ||
					recovery.rateLimitType === "seven_day")))
	)
		return { kind: "go" };

	if (asker === "user") return { kind: "go" };
	return reset !== undefined && Number.isFinite(reset)
		? {
				kind: "wait-until",
				until: reset,
				label: accountLimitWindowLabel(recovery?.rateLimitType ?? "usage"),
			}
		: { kind: "wait" };
};
