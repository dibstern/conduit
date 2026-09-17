# Contributing to the design system

## Primitive or call-site class

Add a primitive when the same class list appears at three or more call sites,
or when focus, dismissal, roving tabindex or ARIA is easy to get subtly wrong.
Keep business content and surrounding layout at the call site. Repetition of
appearance alone does not justify combining controls with different meanings.

[DetachedListbox](../../src/lib/frontend/components/ui/DetachedListbox.svelte)
is a concrete example: FileMenu, CommandMenu and DirectoryAutocomplete share
its named, non-focusable listbox surface, while their inputs keep focus and
own `aria-activedescendant`. A second tab stop would break that relationship.
[Surface](../../src/lib/frontend/components/ui/Surface.svelte) similarly owns
card styling; its `padding="none"` emits no padding, allowing a call site's
existing spacing to have one owner during migration. This is not permission
to recreate control recipes in features. See [ADR-0003](../adr/0003-feature-components-do-not-own-control-appearance.md).

## The REPLACE contract

An appearance prop must be a closed union that replaces a slot in the recipe.
Never append a string to override that slot. Two utilities from the same
Tailwind group compete in stylesheet emission order, not class attribute
order. This repo deliberately has no tailwind-merge.

In [floating-styles.ts](../../src/lib/frontend/components/ui/floating-styles.ts),
`FLOATING_SURFACE_RADIUS_CLASSES` supplies exactly `lg: "rounded-lg"` or
`xl: "rounded-xl"`. The detached-listbox base contains no radius;
`DetachedListbox` selects `FLOATING_SURFACE_RADIUS_CLASSES[radius]` once.
That is why `radius="xl"` does not need an important override.

[button-recipes.ts](../../src/lib/frontend/components/ui/button-recipes.ts)
splits variants into `chrome`, `tone` and `hoverFill`.
[Button](../../src/lib/frontend/components/ui/Button.svelte) chooses
`tone === undefined ? recipe.tone : TONE_CLASSES[tone]`. The requested tone
replaces the default instead of emitting two resting text colours.

`MENU_ITEM_DENSITY_CLASSES` in the same file is the contract learned the hard
way. AttachMenu's rows are thumb targets and wore `gap-2.5 px-4 py-3`; the
migration onto `MenuItem` dropped all three and the rows lost 27% of their
height. Passing them back as a `class` string would not have worked, because
the recipe's own `gap-2 px-3 py-1.5` would still be emitted and which one won
would depend on stylesheet order. So `density` is a two-member union that
replaces the whole group, and `touch` is a deliberate product state rather
than an accident of migration.

## Tokens, including the font-size trap

Use the token layer in [style.css](../../src/lib/frontend/style.css) for
colours, spacing utilities and z-index. It imports Tailwind's scale and defines
the house colours, fonts and layer variables. For example, the floating recipe
uses `border-border bg-bg-alt py-1` and `z-[var(--z-popover)]`, rather than a
new literal colour or layer number. Existing literal exceptions are not a new
design vocabulary.

The root font-size is **12px**. A rem-based utility renders at 0.75 times the
pixel value documented for a 16px root; 1rem is 12px here. This does not scale
px-valued tokens: `--text-sm` is explicitly 11px. Both `--font-sans` and
`--font-mono` use the same JetBrains Mono stack. Adding `font-mono` to content
already inheriting the default font changes nothing. It can still change
content inheriting `font-brand`, which is Chakra Petch.

## Ownership with bits-ui

Check bits-ui first for a new interactive primitive. For Dialog, DropdownMenu,
Popover, Select, Combobox and Tooltip built on bits-ui, let it own the relevant
positioning, dismissal, focus management, roving tabindex and menu/dialog ARIA.
Conduit owns token styling, the wrapper surface and stories with assertions.
Do not introduce a second dismissal or focus model.

The existing [Menu](../../src/lib/frontend/components/ui/Menu.svelte) and
[MenuItem](../../src/lib/frontend/components/ui/MenuItem.svelte) wrap
DropdownMenu; [Modal](../../src/lib/frontend/components/ui/Modal.svelte) wraps
Dialog. Modal supplements the empty-tabbable-list case, and overlay wrappers
use background-inert support. Those fixes supplement the bits model.

Button, Badge/Pill, Card/Surface and the Field set stay hand-rolled. For example,
[Field](../../src/lib/frontend/components/ui/Field.svelte) connects label,
hint and error IDs through context, while
[Badge](../../src/lib/frontend/components/ui/Badge.svelte) renders a passive
`span`. Today's [Select](../../src/lib/frontend/components/ui/Select.svelte)
is a native `select` in that Field set, not a bits Select wrapper. Existing
detached comboboxes retain the input-owned model described above; do not claim
they already delegate all behaviour to bits-ui.

[use-dismiss](../../src/lib/frontend/actions/use-dismiss.svelte.ts) is the
existing non-bits dismissal exception. Its header names PermissionModeSelector,
InstanceModelPicker and ProjectSwitcher and explains why this feature behaviour
lives outside design-system internals. Reuse the documented exception where
applicable; do not invent another dismissal implementation.

## Accessibility checklist

- Give every control an accessible name. `SegmentedControl` requires `label`
  and passes it to `RadioGroup.Root` as `aria-label`.
- Show a keyboard focus ring with `focus-visible:`. Button uses
  `focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text`.
  Exercise real focus with `el.focus()` and keyboard interaction in `play()`;
  a forced visual state alone cannot prove focus movement. The addon is not
  universally unable to show this variant: Button's `FocusVisible` story uses
  `pseudo: { focusVisible: ["button"] }`. Its comment explains why the boolean
  form incorrectly paints descendants too.
- Assert keyboard operation. `SegmentedControl`'s `ArrowKeysMoveSelection`
  story calls `.focus()`, presses ArrowRight and checks `aria-checked`.
- Distinguish disabled from busy. Button's loading state sets `aria-busy` and
  `aria-disabled`, stays focusable and guards activation. Native disabled is
  for unavailable controls.
- Verify role pairing, not just individual roles. The finding recorded in
  [SegmentedControl](../../src/lib/frontend/components/ui/SegmentedControl.svelte)
  is that bits' `ToggleGroup type="single"` puts `role="radio"` on items but
  leaves the root `role="group"`, an invalid radio grouping. This control uses
  RadioGroup for `radiogroup` / `radio` / `aria-checked`; its story asserts the
  group name and item state. Items explicitly use `type="button"` to avoid
  accidental form submission.

## Stories and baselines

Every primitive needs a story, an asserting `play()` and reviewed visual
baselines on both darwin and linux. A rendered example without an assertion
does not prove interaction. In
[Field.stories.ts](../../src/lib/frontend/components/ui/Field.stories.ts),
`WithError` checks the label target, `aria-invalid`, error text and
`aria-describedby` relationship.

[SegmentedControl.stories.ts](../../src/lib/frontend/components/ui/SegmentedControl.stories.ts)
has semantic and keyboard assertions, with committed desktop and mobile PNGs
for both platforms under `test/visual/components.spec.ts-snapshots/`. Capture
a state that distinguishes the story; duplicate pictures can conceal missing
coverage. Follow the strict check and recapture rules in [gates.md](gates.md).
