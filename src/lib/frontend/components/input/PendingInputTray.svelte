<!-- The inputs conduit holds for this session, oldest first, exactly as the
     session-detail stream reports them. The browser keeps no queue of its own:
     a row appears when the server admits a send and leaves when the adapter
     places it in the transcript or someone removes it. Hidden when there are
     none. Remove, Edit, Steer and Resume are server commands; their effect
     comes back through the stream, on every client. Whether Steer shows, and
     whether it is enabled, is the server's call too (the inbox arm). -->
<script lang="ts">
	import type { SteerBlocker } from "../../../contracts/stored-event.js";
	import type { LimitRecovery } from "../../../contracts/limit-recovery.js";
	import type { PendingInput } from "../../stores/chat.svelte.js";
	import { clock } from "../../stores/clock.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { extractDisplayText } from "../../utils/format.js";
	import { usageForecastTime } from "../../utils/continuation.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import ComposerStrip from "../ui/ComposerStrip.svelte";
	import ComposerQueueRow from "../ui/ComposerQueueRow.svelte";
	import Icon from "../ui/Icon.svelte";
	import Tooltip from "../ui/Tooltip.svelte";
	import UsageLimitStrip from "./UsageLimitStrip.svelte";

	let {
		inputs,
		paused = false,
		sendsAt,
		limitRecovery,
		sessionId,
		projectSlug,
		steer,
		onEdit,
		onSteerRefused,
	}: {
		inputs: readonly PendingInput[];
		/** The last turn was stopped or failed, so nothing drains until Resume. */
		paused?: boolean;
		/** The scheduled reset's release time, in Unix milliseconds. */
		sendsAt?: number | undefined;
		limitRecovery?: LimitRecovery | undefined;
		sessionId?: string | undefined;
		projectSlug?: string | undefined;
		/** Steer on queued rows: hidden when undefined, disabled while a prompt is open. */
		steer?: "ready" | "prompt_open" | undefined;
		/** Takes back a queued input that Edit removed. */
		onEdit: (text: string, images: readonly string[]) => void;
		/** The server refused to steer a row, which stays queued. */
		onSteerRefused: (reason: SteerBlocker) => void;
	} = $props();
	const currentSession = $derived(findSession(sessionId ?? sessionState.currentId ?? ""));
	const queueSessionId = $derived(sessionId ?? sessionState.currentId);
	const queueProjectSlug = $derived(projectSlug ?? currentSession?.projectSlug ?? "");
	const limited = $derived(limitRecovery && !limitRecovery.switched);

	/** True when the server applied the command; a row that started is refused. */
	async function act(
		tag: "input.cancel" | "input.sendNow",
		input: PendingInput,
	): Promise<boolean> {
		if (!queueSessionId) return false;
		try {
			const payload = { sessionId: queueSessionId, inputId: input.inputId };
			const response = await (tag === "input.cancel"
				? rpc("input.cancel", payload)
				: rpc("input.sendNow", payload));
			if (response.ok) return true;
			if (response.reason === "already_started")
				showToast("That message already started", { variant: "warn" });
			else onSteerRefused(response.reason);
		} catch (error) {
			toastFailure("Could not update the queue")(error);
		}
		return false;
	}

	async function edit(input: PendingInput) {
		if (await act("input.cancel", input))
			onEdit(extractDisplayText(input.request.text), input.request.images ?? []);
	}
</script>

{#if inputs.length > 0}
	<ComposerStrip
		variant="tray"
		data-testid="pending-input-tray"
		class="flex flex-col gap-[2px]"
	>
		{#if limited && limitRecovery && queueSessionId}
			<UsageLimitStrip {limitRecovery} sessionId={queueSessionId} projectSlug={queueProjectSlug} presentation="tray" />
		{:else if paused}
			<div data-testid="pending-input-paused" class="flex min-h-[30px] items-center gap-[8px] px-[6px] text-[12px] text-text-muted">
				<Icon name="pause" size={14} />
				<span class="flex-1 min-w-0">Paused · you stopped the turn</span>
				<Button variant="secondary" size="composer-chip" icon="play" iconSize={12} touchTarget data-testid="pending-input-resume" class="shrink-0" onclick={() => act("input.sendNow", inputs[0]!)}>Resume</Button>
			</div>
		{/if}
		<ol aria-label="Queued messages" class="flex flex-col gap-[2px]">
			{#each inputs as input (input.inputId)}
				{@const images = input.request.images?.length ?? 0}
				{@const command = input.request.text.trimStart().startsWith("/")}
				<ComposerQueueRow data-testid="pending-input-row" data-input-id={input.inputId}>
					{#snippet badge()}
					<Badge variant="quiet" shape="pill" data-testid="pending-input-state">{input.state === "steering" ? "Steering" : "Queued"}</Badge>
					{/snippet}
					{#snippet text()}
					<span data-testid="pending-input-text" class="flex-1 min-w-0 truncate">{extractDisplayText(input.request.text)}</span>
					{#if images > 0}
						<span
							data-testid="pending-input-images"
							aria-label={images === 1 ? "1 image" : `${images} images`}
							class="flex items-center gap-1 shrink-0 text-text-muted"
						><Icon name="image" size={12} />{images}</span>
					{/if}
					{/snippet}
					{#snippet time()}
					{#if input.state === "queued" && sendsAt !== undefined}
						<time data-testid="pending-input-sends-at" datetime={new Date(sendsAt).toISOString()} class="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-text-muted">sends {usageForecastTime(sendsAt, clock.now)}</time>
					{:else}
						<time datetime={new Date(input.admittedAt).toISOString()} class="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-text-muted">{new Date(input.admittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
					{/if}
					{/snippet}
					{#snippet actions()}
					{#if input.state === "queued"}
						{#if sendsAt !== undefined || limited}
							<Button variant="ghost" size="composer-chip" touchTarget data-testid="pending-input-send-now" class="shrink-0" onclick={() => act("input.sendNow", input)}>Send now</Button>
						{:else if steer}
							<Tooltip>
								{#snippet trigger({ props })}<Button
									{...props}
									variant="ghost" size="composer-chip" touchTarget
									data-testid="pending-input-steer"
									class="shrink-0"
									disabled={steer === "prompt_open"}
									onclick={() => act("input.sendNow", input)}
									>{command ? "Run now" : "Steer"}</Button>{/snippet}
								{steer === "prompt_open" ? "Answer the open prompt before steering" : command ? "Stop the running turn and run this next" : "Send it into the running turn"}
							</Tooltip>
						{/if}
						<Button variant="ghost" size="composer-icon" iconOnly icon="pencil" iconSize={13} touchTarget ariaLabel="Edit queued message" data-testid="pending-input-edit" class="shrink-0" onclick={() => edit(input)} />
						<Button variant="ghost" size="composer-icon" iconOnly icon="x" iconSize={13} touchTarget ariaLabel="Remove queued message" data-testid="pending-input-remove" class="shrink-0" onclick={() => act("input.cancel", input)} />
					{/if}
					{/snippet}
				</ComposerQueueRow>
			{/each}
		</ol>
	</ComposerStrip>
{/if}
