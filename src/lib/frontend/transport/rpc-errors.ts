import { Schema } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { type WsRpcError, WsRpcGroup } from "../../contracts/ws-rpc.js";
import { showToast } from "../stores/ui.svelte.js";
import { usageForecastTime } from "../utils/continuation.js";

type DeclaredError = Exclude<
	Rpc.Error<RpcGroup.Rpcs<typeof WsRpcGroup>>,
	WsRpcError
>;

export const copy: {
	readonly [T in DeclaredError["_tag"]]:
		| ((error: Extract<DeclaredError, { _tag: T }>) => string)
		| null;
} = {
	DraftAlreadySent: (error) => error.message,
	DraftAttachmentMissing: (error) => error.message,
	DraftAttachmentRejected: (error) => error.message,
	WorkspaceMoveError: (error) =>
		({
			missing: "That worktree no longer exists.",
			"not-a-worktree": "That folder is not a git worktree.",
			"other-repository": "That worktree belongs to another repository.",
			"unsupported-provider": "This provider does not support worktrees.",
		})[error.reason],
	WorktreeCreationError: (error) => error.message,
	WorktreeBranchRenameError: (error) => `${error.folder}: ${error.message}`,
	WorktreeRecoveryError: (error) => error.message,
	SetPinRejected: (error) => {
		if (error.reason === "wrong_pin") return "Wrong PIN. Try again.";
		const minutes = Math.max(
			1,
			Math.ceil((error.retryAfterSeconds ?? 60) / 60),
		);
		return `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
	},
	AccountUnroutable: (error) => error.message,
	SessionBusy: (error) => error.message,
	StaleSwitch: (error) => error.message,
	AccountUnavailable: (error) => error.message,
	AccountStillLimited: (error) =>
		`Claude still shows the ${error.label} until ${usageForecastTime(error.until, Date.now())}.`,
	DriverMismatch: (error) => error.message,
	HandoffTooLarge: (error) => error.message,
	AccountChangeRejected: (error) => error.message,
	ProjectSaveRejected: (error) => error.message,
	CategorySetRejected: (error) => error.message,
	ClaudeSettingsTrustBoundaryError: (error) => error.message,
	ClaudeSettingsResolveError: (error) => error.message,
};

const isDeclared = Schema.is(
	Schema.Union(
		Array.from(WsRpcGroup.requests.values(), (rpc) => rpc.errorSchema),
	),
);

function sentence(error: unknown): string | undefined {
	try {
		if (!isDeclared(error)) return undefined;
		if (error._tag === "WsRpcError") return error.message || undefined;
		// The validated discriminant selects the function for this exact error.
		// Indexed access loses that correlation across the error union.
		const entry = copy[error._tag] as ((error: DeclaredError) => string) | null;
		return entry?.(error);
	} catch {
		return undefined;
	}
}

export function failureLine(error: unknown, fallback: string): string {
	return sentence(error) ?? fallback;
}

export const toastFailure =
	(action: string, variant: "error" | "warn" = "error") =>
	(error: unknown): void => {
		const body = sentence(error);
		showToast({ title: action, variant, ...(body ? { body } : {}) });
	};
