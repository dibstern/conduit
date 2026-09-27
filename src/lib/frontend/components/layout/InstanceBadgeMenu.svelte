<!--
  InstanceBadgeMenu — which OpenCode instance the current project is bound to,
  and the control to rebind it.

  It sits in both top bars (Header on desktop, SessionBar on phones) because it
  is identity rather than an action: it says where this project's work actually
  runs, so it belongs beside the project's name, not buried in an overflow
  menu. One component so the two bars cannot drift on the rebind call or the
  test IDs.

  Renders nothing when there is only one instance — no choice to offer, and no
  ambiguity to resolve.
-->

<script lang="ts">
	import {
		getInstanceById,
		instanceState,
		instanceStatusColor,
	} from "../../stores/instance.svelte.js";
	import {
		applyProjectMutationResponse,
		projectState,
	} from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { setProjectInstanceRpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import { openSettings } from "./chrome-actions.js";

	let { class: className = "" }: { class?: string } = $props();

	const currentInstance = $derived.by(() => {
		if (instanceState.instances.length <= 1) return undefined;
		const slug = getCurrentSlug();
		const project = slug
			? projectState.projects.find((p) => p.slug === slug)
			: undefined;
		return project?.instanceId ? getInstanceById(project.instanceId) : undefined;
	});

	let open = $state(false);

	function handleSelectInstance(instanceId: string) {
		// Picking an instance rebinds the *current project* to it rather than
		// navigating anywhere; the project is the thing that has an instance.
		const slug = getCurrentSlug();
		if (!slug) return;
		void setProjectInstanceRpc({ projectSlug: slug, slug, instanceId })
			.then(applyProjectMutationResponse)
			.catch(() => undefined);
	}
</script>

{#if currentInstance}
	<!-- Was a hand-rolled dropdown before de3: a bare <button> toggling an
	     absolutely-positioned <div> of bare <button>s, with no aria-expanded,
	     no aria-haspopup, no role, no arrow keys, no Escape and no dismiss on
	     outside click. ui/Menu brings the whole contract (conduit-test-de3.35.6).

	     MenuRadioGroup rather than plain items because exactly one instance is
	     current, which the old markup knew and never said: it rendered every
	     instance identically, so the active one was indistinguishable once the
	     badge itself was covered by the open menu. -->
	<Menu
		bind:open
		ariaLabel="Select instance"
		align="start"
		data-testid="instance-selector-dropdown"
	>
		{#snippet trigger({ props })}
			<Button
				{...props}
				variant="pill"
				size="content"
				class={className}
				title="{currentInstance.name} ({currentInstance.status})"
				data-testid="instance-badge"
			>
				<span
					class={"w-1.5 h-1.5 rounded-full shrink-0 " +
						instanceStatusColor(currentInstance.status)}
					data-testid="instance-status-dot"
				></span>
				{currentInstance.name}
			</Button>
		{/snippet}

		<MenuRadioGroup value={currentInstance.id}>
			{#each instanceState.instances as inst (inst.id)}
				<MenuRadioItem
					value={inst.id}
					onselect={() => handleSelectInstance(inst.id)}
				>
					<span class="flex items-center gap-2">
						<span
							class={"w-1.5 h-1.5 rounded-full shrink-0 " +
								instanceStatusColor(inst.status)}
							data-testid="instance-status-dot"
						></span>
						{inst.name}
					</span>
				</MenuRadioItem>
			{/each}
		</MenuRadioGroup>

		<MenuSeparator />
		<MenuItem onselect={() => openSettings("instances")}>
			Manage Instances
		</MenuItem>
	</Menu>
{/if}
