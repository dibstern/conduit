<!--
  Surface — a structural <div> shell with independent padding and elevation.

  Phase 4 migration targets:
  - card: QuestionCard, PermissionCard, SettingsPanel toggle rows and visibility
    groups, setup StatusBox, SubagentBackBar, TerminalPanel
  - inset: tool results, diff viewers, permission input, system details
  - floating: dropdown/menu shells, context menus, ProjectSwitcher, InfoPanels,
    NotifSettings, ThemePicker, and ui/Modal.svelte's panel
  - plain: User/Assistant/System/Thinking message shells

  Explicitly not Surface: interactive card-shaped <label>/<button>/<a> controls,
  grouped tool shells with partial radii, InputArea's composite form shell,
  paste thumbnails or QR backings, PlanMode's CSS collapse contract, or
  DebugPanel's deliberately exceptional styling.
-->
<script module lang="ts">
	type SurfaceVariant = "card" | "inset" | "floating" | "plain";
	type SurfacePadding = "none" | "sm" | "md" | "lg";
	type SurfaceElevation = "none" | "menu" | "panel" | "modal";

	const VARIANT_CLASSES: Record<SurfaceVariant, string> = {
		card: "bg-bg-surface border border-border",
		inset: "bg-code-bg border border-border-subtle",
		floating: "bg-bg-alt border border-border",
		plain: "bg-bg-surface",
	};

	const PADDING_CLASSES: Record<SurfacePadding, string> = {
		none: "",
		sm: "px-3 py-2",
		md: "px-4 py-3",
		lg: "px-5 py-4",
	};

	const ELEVATION_CLASSES: Record<SurfaceElevation, string> = {
		none: "",
		menu: "shadow-menu",
		panel: "shadow-panel",
		modal: "shadow-modal",
	};

	const BASE_CLASSES = "rounded-panel";
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	type SurfaceProps = {
		variant?: SurfaceVariant;
		padding?: SurfacePadding;
		elevation?: SurfaceElevation;
		class?: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLDivElement>, "class">;

	let {
		variant = "card",
		padding = "md",
		elevation = "none",
		class: className,
		children,
		...rest
	}: SurfaceProps = $props();

	const surfaceClass = $derived(
		[
			BASE_CLASSES,
			VARIANT_CLASSES[variant],
			PADDING_CLASSES[padding],
			ELEVATION_CLASSES[elevation],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<div {...rest} class={surfaceClass}>{@render children()}</div>
