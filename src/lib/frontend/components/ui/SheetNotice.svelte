<!--
  SheetNotice — a toast shown as a centred pill inside an open sheet, so a
  notification raised while the sheet covers the screen is still seen and its
  actions still reachable. Actions are menu items: the sheet is a menu, and
  its keyboard navigation must reach them.
-->
<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { ToastVariant } from "../../types.js";
	import Icon from "./Icon.svelte";

	const VARIANT_ICON = {
		default: { name: "circle-alert", class: "text-text-secondary" },
		success: { name: "check", class: "text-success" },
		warn: { name: "triangle-alert", class: "text-warning" },
		error: { name: "circle-x", class: "text-error" },
		pinned: { name: "pin", class: "text-status-pinned" },
	} as const;

	let { message, body, emphasis, variant = "default", actions = [] }: {
		message: string;
		body?: string | undefined;
		emphasis?: string | undefined;
		variant?: ToastVariant;
		actions?: readonly { label: string; run: () => void }[];
	} = $props();
	const icon = $derived(VARIANT_ICON[variant]);
	const at = $derived(body && emphasis ? body.indexOf(emphasis) : -1);
</script>

<!-- A menu may only own groups and items (axe checks inside groups too), so
     the pill is a group that is itself the live region. -->
<div
	role="group"
	aria-label="Notification"
	aria-live={variant === "error" ? "assertive" : "polite"}
	data-variant={variant}
	data-testid="session-sheet-toast"
	class="mx-auto mt-[10px] mb-[2px] flex min-h-[40px] w-max max-w-full items-center gap-[8px] rounded-[20px] bg-popover-bg py-[5px] pr-[16px] pl-[14px] text-[13.5px] font-medium text-text shadow-dropdown ring-1 ring-border"
>
	<span aria-hidden="true" class="shrink-0 {icon.class}"><Icon name={icon.name} size={15} /></span>
	<div class="min-w-0 break-words">
		<span>{message}</span>
		{#if body}
			<p class="text-[12.5px] font-normal text-text-secondary">
				{#if emphasis && at >= 0}
					{body.slice(0, at)}<b class="font-semibold text-success">{emphasis}</b>{body.slice(at + emphasis.length)}
				{:else}
					{body}
				{/if}
			</p>
		{/if}
	</div>
	{#each actions as action (action)}
		<DropdownMenu.Item
			closeOnSelect={false}
			textValue={action.label}
			onSelect={action.run}
			class="ml-[6px] shrink-0 cursor-pointer rounded-[14px] bg-accent/14 px-[10px] py-[5px] font-semibold text-accent outline-hidden last:-mr-[10px] data-[highlighted]:ring-1 data-[highlighted]:ring-accent"
		>{action.label}</DropdownMenu.Item>
	{/each}
</div>
