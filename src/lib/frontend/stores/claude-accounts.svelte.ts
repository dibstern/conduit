import type {
	HandoffSummary,
	LimitRecovery,
	UsageReading,
} from "../../contracts/limit-recovery.js";
import {
	previewContinuationRpc,
	quotaForAccountsRpc,
} from "../transport/ws-rpc-client.js";
import {
	showAccountSwitchRefusal,
	switchSessionAccount,
} from "../utils/account-switch.js";
import {
	accountQuota,
	limitedQuota,
	type PlanUsageWindow,
	planUsageWindows,
	quotaBlocksSwitch,
	quotaHeadroom,
	quotaReading,
	usageDisplay,
} from "../utils/continuation.js";
import { getBrowserClientId } from "./client-identity.js";
import {
	getDriverTraits,
	getInstanceById,
	instanceState,
} from "./instance.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import {
	composerAccountId,
	orderedUsageAccounts,
	usageState,
} from "./usage.svelte.js";

export type AccountAvailability =
	| { kind: "current" }
	| { kind: "limited"; resetsAt: string | undefined }
	| { kind: "selectable"; usagePct: number | null };

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

	constructor(readonly projectSlug: string) {}

	get configuredAccounts() {
		return instanceState.instances.filter(
			(instance) => getDriverTraits(instance.driver)?.usageHarness === "claude",
		);
	}

	get accounts() {
		return this.configuredAccounts;
	}

	nameOf(instanceId: string | undefined, fallback = "Claude"): string {
		return getInstanceById(instanceId ?? "")?.name ?? fallback;
	}

	hasAlternative(instanceId: string | undefined): boolean {
		return this.configuredAccounts.some((account) => account.id !== instanceId);
	}

	readingOf(instanceId: string | undefined): UsageReading | undefined {
		return usageState.readings.find(
			(reading) =>
				reading.accountId === instanceId && reading.harness === "claude",
		);
	}

	quotaOf(instanceId: string): UsageReading | undefined {
		return accountQuota(this.quotas, instanceId);
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
			checked = await quotaForAccountsRpc({
				projectSlug: this.projectSlug,
				originId: getBrowserClientId(),
			});
			refreshed = true;
		} catch {
			// A failed check reads as unknown, with no measured send candidates.
		}
		const quotas = new Map(
			checked.map((reading) => [reading.accountId, reading]),
		);
		if (ticket === this.quotaTicket) this.quotas = quotas;
		// A picker's refresh must not discard the send menu's own fresh result.
		if (sendTicket === this.sendQuotaTicket) this.sendQuotas = quotas;
		return refreshed;
	}

	availabilityOf(
		instanceId: string,
		currentId = composerAccountId(findSession(sessionState.currentId ?? "")),
	): AccountAvailability {
		if (instanceId === currentId) return { kind: "current" };
		const quota = this.quotaOf(instanceId);
		if (quotaBlocksSwitch(quota))
			return {
				kind: "limited",
				resetsAt: usageDisplay(quota, "off").binding?.resetsAt,
			};
		const { used } = quotaReading(quota);
		return {
			kind: "selectable",
			usagePct: typeof used === "number" ? used : null,
		};
	}

	suggestedAccount(currentId: string): string | undefined {
		if (this.quotas === undefined) return undefined;
		return this.configuredAccounts
			.filter(
				(account) =>
					this.availabilityOf(account.id, currentId).kind === "selectable",
			)
			.reduce<(typeof this.configuredAccounts)[number] | undefined>(
				(best, account) =>
					best === undefined ||
					quotaHeadroom(this.quotaOf(account.id)) >
						quotaHeadroom(this.quotaOf(best.id))
						? account
						: best,
				undefined,
			)?.id;
	}

	/** The send menu requires measured headroom and retains the switch order. */
	sendOptions(currentId: string | undefined) {
		return orderedUsageAccounts().flatMap((reading) => {
			const quota =
				this.sendQuotas === undefined
					? reading
					: this.sendQuotas.get(reading.accountId);
			const instance = this.configuredAccounts.find(
				(account) => account.id === reading.accountId,
			);
			if (
				reading.accountId === currentId ||
				!instance ||
				quota?.harness !== "claude" ||
				quota.status !== "available" ||
				quotaBlocksSwitch(quota)
			)
				return [];
			const fullest = planUsageWindows(quota).reduce<
				PlanUsageWindow | undefined
			>(
				(best, window) =>
					best === undefined ||
					window.utilization > best.utilization ||
					(window.utilization === best.utilization &&
						window.kind === "five_hour")
						? window
						: best,
				undefined,
			);
			return fullest === undefined || fullest.utilization >= 100
				? []
				: [{ id: instance.id, name: this.nameOf(instance.id), fullest }];
		});
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
			const summary = await previewContinuationRpc({
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

	fromQuota(
		handoff: Pick<SwitchContext, "from" | "limit">,
	): UsageReading | undefined {
		return handoff.limit
			? limitedQuota(handoff.limit)
			: this.quotaOf(handoff.from);
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

export function getClaudeAccounts(projectSlug: string): ClaudeAccounts {
	let accounts = projects.get(projectSlug);
	if (!accounts) {
		accounts = new ClaudeAccounts(projectSlug);
		projects.set(projectSlug, accounts);
	}
	return accounts;
}
