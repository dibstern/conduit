---
name: svelte5-inspect
description: Svelte 5 debugging with $inspect(). Use when the user asks about Svelte DevTools, debugging components, or inspecting reactive state. Also use when debugging Svelte 5 issues where static code analysis is insufficient: reactive chains not propagating ($derived → $effect → render but UI not updating), $state values stale or unexpected at runtime, components receiving wrong props, or $effects firing too often or not at all.
---

# Svelte 5: Debugging with $inspect()

The Svelte DevTools browser extension does NOT support Svelte 5. Do not recommend installing it.

## $inspect(...values)

Built-in Svelte 5 rune that logs reactive values to the console whenever they change. Dev-mode only — automatically stripped from production builds.

```svelte
<script>
  let count = $state(0);
  let user = $state({ name: 'Alice' });

  $inspect(count);           // logs: "init" 0, then "update" 1, 2...
  $inspect(user);            // deep-tracks object mutations
  $inspect(count, user);     // multiple values in one call
</script>
```

## Custom handling with .with()

Replace the default console.log with any callback:

```svelte
$inspect(count).with((type, ...values) => {
  // type is "init" or "update"
  if (type === 'update') debugger;    // break on change
});
```

Common patterns:
- `$inspect(val).with(() => { debugger })` — breakpoint on any change
- `$inspect(val).with(console.trace)` — log with stack trace

## Rules

- Only works inside reactive contexts (component `<script>`, `$effect`, `$derived`)
- Only runs in dev mode — zero cost in production
- Tracks deeply: mutating a property on a `$state` object triggers it
- Cannot be used in `.ts` files — Svelte compiler rune only

## When to ask the developer to add $inspect()

You can read every `.svelte` file, but you cannot see runtime state. When the bug lives in the gap between what the code says and what actually happens in the browser, ask the developer to add `$inspect()` and report back what the console shows.

**Ask when:**

- **Reactive chain not propagating** — you see `$derived` → `$effect` → render but the UI isn't updating. `$inspect()` pinpoints which link in the chain breaks.
- **Stale or unexpected values** — a `$state` variable should be X but the UI shows Y. Static analysis can't distinguish timing issues, overwrites from elsewhere, or deep reactivity misses.
- **Component receiving wrong props** — you suspect the parent passes stale data but can't prove it without runtime evidence.
- **Effect firing too often or not at all** — `$effect` dependencies are implicit in Svelte 5, so you can't always predict the trigger pattern from code alone.
- **After your first fix attempt didn't work** — if you patched the code and the user says it's still broken, don't guess again. Ask for `$inspect()` output to get evidence.

**How to ask:**

Be specific. Don't say "add some inspect calls." Say exactly what to inspect and where:

> Add `$inspect(messages, isLoading)` inside `ChatPanel.svelte` and tell me what the console shows when you send a message.

This gives you the runtime evidence to diagnose instead of guess.
