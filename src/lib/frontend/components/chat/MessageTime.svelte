<!-- The send time shown in a message card header.
     Renders nothing when the message has no `createdAt`: live messages stamp it
     on arrival and history carries it from the event store, but rows persisted
     before conduit rendered times have none, and a blank is better than a lie. -->

<script lang="ts">
	import { formatClockTime } from "../../utils/format.js";
	import { clock } from "../../stores/clock.svelte.js";
	import Popover from "../ui/Popover.svelte";
	import Button from "../ui/Button.svelte";

	let { createdAt }: { createdAt?: number | undefined } = $props();
	const today = $derived(new Date(clock.now).setHours(0, 0, 0, 0));
	const date = $derived(createdAt == null ? undefined : new Date(createdAt));
	const fullDate = $derived(date?.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }));
	const label = $derived.by(() => {
		if (!date) return "";
		const now = new Date(today);
		const days = (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
			- Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000;
		const day = days === 0 ? "Today" : days === 1 ? "Yesterday" : days > 1 && days < 7
			? `${days} days ago`
			: date.toLocaleDateString(undefined, {
				day: "numeric", month: "short",
				...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
			});
		return `${day} · ${formatClockTime(createdAt)}`;
	});
</script>

{#if date}
	<Popover ariaLabel="Message timestamp" side="top" class="px-3 py-2 text-xs">
		{#snippet trigger({ props })}
			<Button {...props} variant="ghost" size="content" tone="dimmer" hoverFill="none" title={fullDate}
				class="text-mono-xs font-mono font-normal tabular-nums shrink-0 rounded">
				<time datetime={date.toISOString()}>{label}</time>
			</Button>
		{/snippet}
		{fullDate}
	</Popover>
{/if}
