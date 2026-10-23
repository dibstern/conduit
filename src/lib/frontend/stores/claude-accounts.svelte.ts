import { accountLimit } from "../../contracts/account-limit.js";
import type {
	HandoffSummary,
	LimitRecovery,
	UsageReading,
	UsageWindow,
} from "../../contracts/limit-recovery.js";
import { rpc } from "../transport/ws-rpc-client.js";
import {
	showAccountSwitchRefusal,
	switchSessionAccount,
} from "../utils/account-switch.js";
import {
	accountQuota,
	planUsageWindows,
	quotaReading,
	usageDisplay,
} from "../utils/continuation.js";
import { getBrowserClientId } from "./client-identity.js";
import { clock } from "./clock.svelte.js";
import {
	getDriverTraits,
	getInstanceById,
	instanceState,
} from "./instance.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { composerAccountId, usageState } from "./usage.svelte.js";

export type AccountAvailability =
	| { kind: "current" }
	| { kind: "signed-out" }
	| { kind: "limited"; resetsAt: string | undefined }
	| { kind: "selectable"; usagePct: number | null; usageUnknown: boolean };

type SwitchContext = {
	requestId: number;
	sessionId: string;
	from: string;
	to: string;
	limit: LimitRecovery | undefined;
};

type HandoffState =
	| { kind: "idle" }
	| ({ kind: "previewing" } & SwitchContext)
	| ({
			kind: "pending" | "switching";
			summary: HandoffSummary;
	  } & SwitchContext);

class ClaudeAccounts {
	quotas = $state<ReadonlyMap<string, UsageReading> | undefined>();
	private sendQuotas = $state<ReadonlyMap<string, UsageReading> | undefined>();
	handoff = $state<HandoffState>({ kind: "idle" });
	private quotaTicket = 0;
	private sendQuotaTicket = 0;
	private previewTicket = 0;
	private inFlightTarget = $state<string | null>(null);

	constructor(
		readonly projectSlug: string,
		readonly harness: "claude" | "codex",
	) {}

	get configuredAccounts() {
		return instanceState.instances.filter(
			(instance) =>
				getDriverTraits(instance.driver)?.usageHarness === this.harness,
		);
	}

	get accounts() {
		return this.configuredAccounts;
	}

	nameOf(
		instanceId: string | undefined,
		fallback = this.harness === "codex" ? "Codex" : "Claude",
	): string {
		return getInstanceById(instanceId ?? "")?.name ?? fallback;
	}

	hasAlternative(instanceId: string | undefined): boolean {
		return this.configuredAccounts.some((account) => account.id !== instanceId);
	}

	readingOf(instanceId: string | undefined): UsageReading | undefined {
		return usageState.readings.find(
			(reading) =>
				reading.accountId === instanceId && reading.harness === this.harness,
		);
	}

	quotaOf(instanceId: string): UsageReading | undefined {
		const quota = accountQuota(this.quotas, instanceId);
		return quota === undefined || quota.harness === this.harness
			? quota
			: { ...quota, harness: this.harness };
	}

	/** Closing or changing the composer must not invalidate a picker's read. */
	invalidateSendQuotas(clear = true): void {
		this.sendQuotaTicket++;
		if (clear) this.sendQuotas = undefined;
	}

	/** Every open reads afresh; only the latest request may replace the result. */
	async refreshQuotas(source: "shared" | "send" = "shared"): Promise<boolean> {
		const ticket = ++this.quotaTicket;
		const sendTicket = source === "send" ? ++this.sendQuotaTicket : undefined;
		this.quotas = undefined;
		if (source === "send") this.sendQuotas = undefined;
		let checked: readonly UsageReading[] = [];
		let refreshed = false;
		try {
			checked = await rpc("QuotaForAccounts", {
				projectSlug: this.projectSlug,
				originId: getBrowserClientId(),
			});
			refreshed = true;
		} catch {
			// A failed read leaves accounts for the user to choose explicitly.
		}
		const quotas = new Map(
			checked
				.filter((reading) => reading.harness === this.harness)
				.map((reading) => [reading.accountId, reading]),
		);
		if (ticket === this.quotaTicket) this.quotas = quotas;
		// A picker's refresh must not discard the send menu's own fresh result.
		if (sendTicket === this.sendQuotaTicket) this.sendQuotas = quotas;
		return refreshed;
	}

	private accountLimitFor(reading: UsageReading | undefined) {
		const input = { ...(reading ? { reading } : {}), now: clock.now };
		return {
			limit: accountLimit({ ...input, asker: "user" }),
			usageUnknown:
				accountLimit({ ...input, asker: "automatic" }).kind !== "go",
		};
	}

	availabilityOf(
		instanceId: string,
		currentId = composerAccountId(findSession(sessionState.currentId ?? "")),
	): AccountAvailability {
		if (instanceId === currentId) return { kind: "current" };
		const quota = this.quotaOf(instanceId);
		const { limit, usageUnknown } = this.accountLimitFor(quota);
		if (limit.kind === "signed-out") return limit;
		if (limit.kind !== "go")
			return {
				kind: "limited",
				resetsAt:
					limit.kind === "wait-until"
						? new Date(limit.until).toISOString()
						: undefined,
			};
		const { used } = quotaReading(quota, clock.now);
		return {
			kind: "selectable",
			usagePct: !usageUnknown && typeof used === "number" ? used : null,
			usageUnknown,
		};
	}

	sendOptions(currentId: string | undefined) {
		const order = usageState.limits.order;
		const rank = (id: string) => {
			const index = order.indexOf(id);
			return index === -1 ? order.length : index;
		};
		return [...this.configuredAccounts]
			.sort((a, b) => rank(a.id) - rank(b.id))
			.flatMap((account) => {
				if (account.id === currentId) return [];
				const reading =
					this.sendQuotas === undefined
						? this.readingOf(account.id)
						: this.sendQuotas.get(account.id);
				const { limit, usageUnknown } = this.accountLimitFor(reading);
				if (limit.kind !== "go") return [];
				const windows = reading
					? this.harness === "codex"
						? reading.windows
						: planUsageWindows(reading)
					: [];
				const fullest = windows.reduce<UsageWindow | undefined>(
					(best, window) =>
						best === undefined ||
						window.utilization > best.utilization ||
						(window.utilization === best.utilization &&
							window.kind === "five_hour")
							? window
							: best,
					undefined,
				);
				return [
					{
						id: account.id,
						name: account.name,
						usageEligible: account.usageEligible,
						usageUnknown,
						fullest,
					},
				];
			});
	}

	suggestedAccount(currentId: string): string | undefined {
		if (this.quotas === undefined) return undefined;
		return this.configuredAccounts
			.filter((account) => {
				const choice = this.availabilityOf(account.id, currentId);
				return choice.kind === "selectable" && !choice.usageUnknown;
			})
			.reduce<(typeof this.configuredAccounts)[number] | undefined>(
				(best, account) =>
					best === undefined ||
					(usageDisplay(this.quotaOf(account.id), "off", clock.now).binding
						?.utilization ?? 100) <
						(usageDisplay(this.quotaOf(best.id), "off", clock.now).binding
							?.utilization ?? 100)
						? account
						: best,
				undefined,
			)?.id;
	}

	get switchingTo(): string | null {
		return (
			this.inFlightTarget ??
			(this.handoff.kind === "previewing" ? this.handoff.to : null)
		);
	}

	get switching(): boolean {
		return this.inFlightTarget !== null;
	}

	shouldAccountSpin(
		sessionId: string | null,
		instanceId: string | undefined,
	): boolean {
		const switchingTo = this.switchingTo;
		const session = findSession(sessionId ?? "");
		return (
			switchingTo !== null &&
			this.handoff.kind !== "idle" &&
			this.handoff.sessionId === sessionId &&
			(instanceId === switchingTo || instanceId === composerAccountId(session))
		);
	}

	get pendingHandoff() {
		return this.handoff.kind === "pending" || this.handoff.kind === "switching"
			? this.handoff
			: undefined;
	}

	/** Callable from any control, independently of the account menu's lifetime. */
	async beginSwitch(
		sessionId: string,
		targetId: string,
		sourceId?: string,
	): Promise<void> {
		const session = findSession(sessionId);
		const recovery = session?.limitRecovery;
		const from = sourceId ?? composerAccountId(session);
		if (!from) return;
		if (this.availabilityOf(targetId, from).kind !== "selectable") return;
		const ticket = ++this.previewTicket;
		const context: SwitchContext = {
			requestId: ticket,
			sessionId,
			from,
			to: targetId,
			limit:
				recovery &&
				!recovery.switched &&
				!recovery.continued &&
				recovery.instanceId === from
					? recovery
					: undefined,
		};
		this.handoff = { kind: "previewing", ...context };
		try {
			const summary = await rpc("PreviewContinuation", {
				sessionId,
				instanceId: targetId,
				originId: getBrowserClientId(),
			});
			if (ticket === this.previewTicket)
				this.handoff = { kind: "pending", ...context, summary };
		} catch (error) {
			if (ticket !== this.previewTicket) return;
			this.handoff = { kind: "idle" };
			showAccountSwitchRefusal(targetId, error);
		}
	}

	cancel(): void {
		this.previewTicket++;
		this.handoff = { kind: "idle" };
	}

	// Mounted pickers retain their live source props; standalone callers use the preview.
	async confirm(): Promise<void> {
		if (this.handoff.kind !== "pending" || this.switching) return;
		const handoff = this.handoff;
		this.handoff = { ...handoff, kind: "switching" };
		this.inFlightTarget = handoff.to;
		try {
			await switchSessionAccount({
				sessionId: handoff.sessionId,
				instanceId: handoff.to,
				expectedInstanceId: handoff.from,
			});
		} finally {
			this.inFlightTarget = null;
			this.cancel();
		}
	}
}

const projects = new Map<string, ClaudeAccounts>();

export function getClaudeAccounts(
	projectSlug: string,
	harness: "claude" | "codex" = "claude",
): ClaudeAccounts {
	const key = `${harness}:${projectSlug}`;
	let accounts = projects.get(key);
	if (!accounts) {
		accounts = new ClaudeAccounts(projectSlug, harness);
		projects.set(key, accounts);
	}
	return accounts;
}
