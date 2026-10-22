<!--
  AccountDot — a Claude account's identity colour, fixed for the life of the
  account by default because it is derived from the instance ID. Usage accounts
  use their group order to avoid collisions. It says which account,
  never how the account is doing: amber and
  red stay out of the palette because they mean a limit everywhere else, and a
  limited account shows that through red text and dimmed rows instead.

  The hues are the theme-invariant fills and project accents, so a dot is the
  same colour in both themes, like a project square.
-->
<script module lang="ts">
	const SIZE_CLASSES = { 6: "size-[6px]", 7: "size-[7px]", 8: "size-[8px]", 9: "size-[9px]" } as const;
</script>

<script lang="ts">
	import { accountColorClass } from "../../utils/account-color.js";
	import { orderedUsageAccounts } from "../../stores/usage.svelte.js";

	let {
		instanceId,
		size = 8,
		"data-testid": testId = "account-dot",
		class: className = "",
	}: {
		instanceId: string;
		size?: keyof typeof SIZE_CLASSES | undefined;
		"data-testid"?: string;
		/** Layout only (margin, alignment); the colour and shape are the dot's. */
		class?: string | undefined;
	} = $props();
</script>

<span
	aria-hidden="true"
	data-testid={testId}
	data-account={instanceId}
	class="inline-block shrink-0 rounded-full {SIZE_CLASSES[size]} {accountColorClass(instanceId, orderedUsageAccounts())} {className}"
></span>
