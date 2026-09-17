# Primitive API reference

This reference covers the 27 UI components in `src/lib/frontend/components/ui/`. Recipe strings and component defaults come from this checkout. Each entry links to the component and its recipe owner; inline recipes live in the component itself. Where there is no purpose doc comment, the entry describes the rendered markup and says so.

Tables quote axis-specific classes. Shared base classes still apply unless the entry says otherwise. **Emits nothing** means that member adds no classes for that axis, not that the component has no styling. Template interpolations and concatenated literals are expanded where needed. A `class` prop is not an axis replacement unless explicitly implemented that way.

The [app stylesheet](../../src/lib/frontend/style.css) sets the root font size to 12px. Rem utilities compute to 0.75 times their usual 16px-root pixel values. Literal pixel utilities and the app's pixel-valued text-size tokens do not scale this way. Class strings below retain their exact source spelling.

The entries enumerate locally declared closed unions, booleans and required-prop constraints. Several wrappers also inherit Svelte HTML attributes or Bits content/part props. Those imported declarations are absent because dependencies are not installed in this checkout, so their complete union/boolean inventories and dependency defaults could not be verified. They are not reconstructed from memory. Native passthrough noted below is not an exhaustive DOM/ARIA reference; `default: unclear` identifies a delegated default that the local wrapper leaves unset.

## Controls

### Button

[Button.svelte](../../src/lib/frontend/components/ui/Button.svelte) is the primitive action control; it renders a button or an anchor when `href` is set.

`variant` defaults to `secondary`. The three recipe slots below concatenate in order. `tone` and `hoverFill` replace their respective slots. Source: [button-recipes.ts](../../src/lib/frontend/components/ui/button-recipes.ts), `VARIANT_RECIPES`.

| `variant` | Chrome | Tone | Hover fill |
| --- | --- | --- | --- |
| `primary` | `bg-accent` | `text-bg` | `hover:bg-accent-hover` |
| `secondary` | `border border-border` | `text-text` | `hover:bg-text/5` |
| `ghost` | emits nothing | `text-text-secondary hover:text-text` | `hover:bg-text/5` |
| `ghost-accent` | emits nothing | `text-accent` | `hover:bg-accent/5` |
| `danger` | `bg-error` | `text-bg` | `hover:bg-error/90` |
| `success-soft` | `border border-success/20 bg-success/10` | `text-success` | `hover:bg-success/15` |
| `danger-outline` | `border border-border bg-transparent` | `text-error` | `hover:bg-error/[0.08]` |
| `accent-soft` | `bg-accent/10` | `text-accent` | `hover:bg-accent/20` |
| `toolbar` | `data-[active]:text-accent` | `text-text-dimmer hover:text-text` | `hover:bg-[rgba(var(--overlay-rgb),0.04)]` |
| `pill` | `gap-1 h-6 px-2 rounded-full text-xs font-medium font-brand border border-border bg-bg-alt duration-100` | `text-text-muted hover:text-text-secondary` | `hover:bg-bg` |
| `pill-warning` | `gap-1 h-6 px-2 rounded-full text-xs font-medium font-brand border border-warning/30 bg-warning-bg duration-100` | `text-warning` | emits nothing |

The following maps also come from [button-recipes.ts](../../src/lib/frontend/components/ui/button-recipes.ts).

| Prop | Default | Member | Classes |
| --- | --- | --- | --- |
| `tone` | omitted; uses variant's tone | `inherit` | emits nothing |
| | | `default` | `text-text` |
| | | `secondary` | `text-text-secondary hover:text-text` |
| | | `muted` | `text-text-muted hover:text-text` |
| | | `muted-soft` | `text-text-muted hover:text-text-secondary` |
| | | `dimmer` | `text-text-dimmer hover:text-text` |
| | | `accent` | `text-accent` |
| | | `error` | `text-error` |
| | | `success` | `text-success` |
| `hoverFill` | omitted; uses variant's hover fill | `none` | emits nothing |
| | | `text` | `hover:bg-text/5` |
| | | `overlay` | `hover:bg-[rgba(var(--overlay-rgb),0.04)]` |
| | | `overlay-soft` | `hover:bg-[rgba(var(--overlay-rgb),0.03)]` |
| | | `alt` | `hover:bg-bg-alt` |
| | | `surface` | `hover:bg-bg-surface` |
| | | `sidebar` | `hover:bg-sidebar-hover` |
| | | `base` | `hover:bg-bg` |
| | | `success-faint` | `hover:bg-success/[0.06]` |
| | | `accent-bg` | `hover:bg-accent-bg` |
| `disabledStyle` | `dim` | `dim` | `disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:cursor-not-allowed` |
| | | `faint` | `disabled:opacity-30 disabled:cursor-default aria-disabled:opacity-30 aria-disabled:cursor-default` |
| | | `ghosted` | `disabled:opacity-25 disabled:cursor-default aria-disabled:opacity-25 aria-disabled:cursor-default` |
| | | `undimmed` | `disabled:opacity-100 disabled:cursor-default aria-disabled:opacity-100 aria-disabled:cursor-default` |
| | | `none` | emits nothing |

Inline recipes and defaults in [Button.svelte](../../src/lib/frontend/components/ui/Button.svelte):

| Prop | Default | Member | Classes |
| --- | --- | --- | --- |
| `size` | `md` | `sm` | `h-8 px-3 text-xs gap-1.5 rounded-lg font-medium`; with `iconOnly`, `h-8 w-8 rounded-lg font-medium` |
| | | `md` | `h-9 px-4 text-sm gap-2 rounded-lg font-medium`; with `iconOnly`, `h-9 w-9 rounded-lg font-medium` |
| | | `content` | emits nothing, including with `iconOnly` |
| `align` | `center` | `center` | `justify-center` |
| | | `start` | `justify-start` |
| | | `between` | `justify-between` |
| `layout` | `center` | `center` | `inline-flex items-center whitespace-nowrap select-none` |
| | | `baseline` | `inline-flex items-baseline whitespace-nowrap select-none` |
| | | `flow` | emits nothing; also suppresses every `align` member |
| `type` | `button` | `button`, `submit`, `reset` | each emits nothing; forwarded as the native button `type`, absent on the anchor branch |

Booleans and constraints: `iconOnly=false`; `true` requires `ariaLabel: string` and forbids a children snippet, while `false` permits optional `ariaLabel` and children. `loading=false` renders a spinner and sets `aria-busy` and `aria-disabled`. `disabled=false` sets native button disability. `ariaDisabled=false` sets `aria-disabled`. Any of these last three states suppresses the component's click callback and removes `hover:` tokens from its assembled variant recipe. `href` selects the anchor branch without a type-level prohibition on `disabled`; the source warns about that combination in development. Native navigation is not cancelled by `handleClick`.

Trap: use `size="content"` with `pill` and `pill-warning`. Their own geometry conflicts with the default `md` size. Appending a competing `class` utility does not reliably override a recipe.

Bits-ui: no.

No axis for focus ring width or colour, fixed by `focus-visible:ring-2 focus-visible:ring-text`; transition property is fixed by `transition-colors`. Radius and font weight are coupled to size or pill variant, without independent axes.

### TextButton

[TextButton.svelte](../../src/lib/frontend/components/ui/TextButton.svelte) is a button whose entire affordance is a colour step on hover.

All recipes and defaults are inline in that file.

| Prop | Default | Member | Classes |
| --- | --- | --- | --- |
| `tone` | `muted` | `muted` | `text-text-muted hover:text-text` |
| | | `dimmer` | `text-text-dimmer hover:text-text` |
| | | `accent` | `text-accent hover:text-accent/80` |
| `underline` | `none` | `none` | emits nothing |
| | | `hover` | `hover:underline` |
| | | `always` | `underline` |
| `type` | `button` | `button`, `submit`, `reset` | each emits nothing; forwarded as native `type` |

Booleans and constraints: `disabled=false` sets native disability and removes the tone's hover class. It does not remove `hover:underline`. `children` is required; there is no discriminated prop union.

Bits-ui: no.

No axis for disabled opacity or cursor, fixed by `disabled:opacity-50 disabled:cursor-not-allowed`; focus ring width and colour are fixed by `focus-visible:ring-2 focus-visible:ring-text`.

### Toggle

[Toggle.svelte](../../src/lib/frontend/components/ui/Toggle.svelte) is a labeled toggle switch row; the entire row is one button.

Closed string-union props: none. Booleans: `checked=false` drives `aria-checked`, the track's `bg-brand-a` versus `bg-text-dimmer`, its inline checked shadow, and the thumb's `translate-x-4` versus emits nothing. `disabled=false` sets native disability and the row's `disabled:cursor-not-allowed disabled:opacity-50`. `label` is required; there is no discriminated prop union.

Bits-ui: no.

No axis for track size or shape, fixed by `w-9 h-5 rounded-full`; thumb size or shape, fixed by `w-4 h-4 rounded-full`; label scale, fixed by `text-sm`; description scale, fixed by `text-xs`. Row spacing defaults to the inline recipe `gap-3 px-3.5 py-2.5 border-none bg-transparent`. Trap: `class` replaces that entire fallback string when supplied, unlike the additive class contract on Button.

### Checkbox

[Checkbox.svelte](../../src/lib/frontend/components/ui/Checkbox.svelte) is the bare native checkbox, styled.

Closed string-union props declared by this component: none. Booleans: bindable `checked=false`; `invalid=false`, combined with the enclosing Field's invalid state. Native `required` is combined with Field's required state using OR; a caller cannot clear a required Field. Remaining native input attributes, including `disabled`, are forwarded without component defaults. No discriminated prop union.

Bits-ui: no.

No axis for accent, focus ring or disabled appearance. [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts), `CHOICE_BASE_CLASSES`, hardcodes `shrink-0 accent-accent cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-offset-1 aria-invalid:outline-error disabled:opacity-50 disabled:cursor-not-allowed`. The invalid outline also has no independent axis.

### Radio

[Radio.svelte](../../src/lib/frontend/components/ui/Radio.svelte) is the bare native radio, styled.

Closed string-union props declared by this component: none. Boolean `checked=false` is controlled, not bindable; callers supply `checked`, handle `onchange`, and share a `name` across the group. Native `required` is combined with Field's required state using OR. Remaining native input attributes, including `disabled`, are forwarded without component defaults. No discriminated prop union. The component omits `aria-invalid` from its native attribute type and has no `invalid` prop.

Bits-ui: no.

No axis for accent, focus ring or disabled appearance. It uses the same `CHOICE_BASE_CLASSES` string from [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts) quoted under Checkbox. Its shared recipe includes invalid-outline utilities, although Radio does not expose an invalid prop.

### SegmentedControl

[SegmentedControl.svelte](../../src/lib/frontend/components/ui/SegmentedControl.svelte) is a strip of mutually exclusive options that sets a value.

`variant` is `underline | pill | field`, default `field`. Exact recipes are in the shared table below. `value: T` and `options: readonly SegmentedOption<T>[]` are required, with caller-defined `T extends string`, not a closed primitive union. There are no top-level boolean props. Each option has `disabled?: boolean`, omitted by default and forwarded to bits. `label` is required. No discriminated prop union.

Bits-ui: `RadioGroup.Root` and `RadioGroup.Item`. The component's doc comment assigns radiogroup/radio ARIA, roving tabindex and arrow keys to bits. The wrapper fixes `orientation="horizontal"` and item `type="button"`.

No axis for padding, gap, type scale, radius or border independently of `variant`; the recipe hardcodes those dimensions as shown below.

### Tabs

[Tabs.svelte](../../src/lib/frontend/components/ui/Tabs.svelte) is a strip of options where picking one swaps the panel below it.

`variant` is `underline | pill | field`, default `underline`. Exact recipes are in the shared table below. `value: T` and `options: readonly SegmentedOption<T>[]` are required, with caller-defined `T extends string`, not a closed primitive union. There are no top-level boolean props. Each option has `disabled?: boolean`, omitted by default and forwarded to bits. `label` is required. No discriminated prop union.

Bits-ui: `Tabs.Root`, `Tabs.List` and `Tabs.Trigger`. The component's doc comment assigns roving focus, arrow/Home/End handling and ARIA role wiring to bits. This wrapper renders no `Tabs.Content`; the doc comment explicitly says `aria-controls` is absent.

No axis for padding, gap, type scale, radius or border independently of `variant`; the recipe hardcodes those dimensions as shown below.

Shared `variant` recipes for SegmentedControl and Tabs, from [segmented-styles.ts](../../src/lib/frontend/components/ui/segmented-styles.ts). Every option receives `item` followed by `selected` or `unselected`.

| Member | Part | Classes |
| --- | --- | --- |
| `underline` | list | `flex border-b border-border px-5 gap-1 font-brand` |
| | item | `px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer bg-transparent` |
| | selected | `border-brand-a text-text` |
| | unselected | `border-transparent text-text-muted hover:text-text` |
| `pill` | list | `diff-toggle-bar flex items-center gap-1 px-3 py-1 mb-1` |
| | item | `text-xs px-2 py-1 rounded border cursor-pointer font-sans transition-colors duration-100` |
| | selected | `bg-accent/20 border-accent/40 text-accent font-medium` |
| | unselected | `bg-transparent border-border text-text-dimmer hover:text-text hover:border-border-subtle` |
| `field` | list | `flex gap-1.5` |
| | item | `flex-1 px-3 py-1.5 text-xs rounded border transition-colors cursor-pointer` |
| | selected | `border-brand-a text-text bg-brand-a/10` |
| | unselected | `border-border text-text-muted hover:text-text` |

## Fields

The field components have no component-level purpose doc comment; their opening lines below describe the markup they render. Their shared recipes are in [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts). TextInput, Textarea and Select always include `"disabled:opacity-50 disabled:cursor-not-allowed"` (`FIELD_BASE_CLASSES`).

### Field

[Field.svelte](../../src/lib/frontend/components/ui/Field.svelte) renders a wrapper with an optional label, required marker, and error or hint around its child control.

- **Closed string unions:** none declared by the primitive.
- **Boolean / constraints:** `required` defaults to `false`; it adds the label's `*` and publishes `required` to child controls through [field-context.ts](../../src/lib/frontend/components/ui/field-context.ts). No discriminated union. `children` is required. A truthy `error` takes precedence over `hint`, publishes the error description ID, and sets context `invalid`.
- **Bits:** no bits-ui wrapper; label/control and description IDs are wired by Field's own context.
- **No axis for:** wrapper direction or gap (`"flex flex-col gap-1.5"`); label type scale, weight or colour (`"text-sm font-medium text-text"`); error/hint type scale (`"text-xs text-error"` / `"text-xs text-text-secondary"`). These are inline class recipes in Field.svelte.
- **Inherited attributes:** `HTMLAttributes<HTMLDivElement>`, excluding `class` and `id`; `id` targets the child control, not the wrapper.

### TextInput

[TextInput.svelte](../../src/lib/frontend/components/ui/TextInput.svelte) renders a native text-like input and consumes Field's accessibility context. Its `type` comment limits it to text-like inputs: checkbox, radio and file are separate primitives.

| Prop | Default | Member → exact recipe emission |
| --- | --- | --- |
| `type` | `"text"` | `text`, `search`, `email`, `url`, `tel`, `password`, `number`: each **emits nothing**; forwarded to the native `type` attribute in TextInput.svelte. |
| `size` | `"md"` | `sm` → `"h-8 px-2.5 text-xs"`; `md` → `"h-9 px-3 text-sm"`; `content` → **emits nothing** (`""`). [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts), `CONTROL_SIZE_CLASSES`. |
| `chrome` | `"bordered"` | See the complete `FIELD_CHROME_CLASSES` mapping below. |

`chrome` resolves to these exact strings in [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts), with concatenated source literals shown joined:

| Member | Exact class string |
| --- | --- |
| `bordered` | `"block w-full rounded-md border border-border bg-input-bg text-text transition-colors placeholder:text-text-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text focus-visible:border-accent aria-invalid:border-error"` |
| `bare` | `"outline-none"` |
| `focus-only` | `"outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text"` |

- **Boolean / constraints:** `invalid=false` is OR-ed with Field context's `invalid`; `autofocus=false` runs `element?.focus()` from an effect when true. Inherited `required` has no local prop initializer; `Boolean(rest.required)` is OR-ed with Field context's `required` and rendered as `true` or omitted. No discriminated union. `element` is bindable to the actual input.
- **Bits:** no bits-ui wrapper; native `<input>` plus local Field context.
- **No axis for:** disabled opacity/cursor (`FIELD_BASE_CLASSES` above); independent bordered radius (`rounded-md`), border width (`border`) or focus-ring width (`focus-visible:ring-2`). `chrome` selects an entire recipe; there are no separate controls for those dimensions within it. `size` couples height, horizontal padding and type scale.
- **Trap:** `bare` is not an empty recipe: it emits `outline-none`. It supplies no focus indicator or visual invalid treatment; `size="content"` is the separate escape hatch for height, padding and type scale. The source comment says to pair them when the surrounding row supplies the affordance.
- **Inherited attributes:** `HTMLInputAttributes`, excluding `class`, native numeric `size`, `type`, `value`, `aria-invalid`, and `autofocus`; unconsumed attributes pass through `...rest`.

### Textarea

[Textarea.svelte](../../src/lib/frontend/components/ui/Textarea.svelte) renders a native textarea and consumes Field's accessibility context.

| Prop | Default | Member → exact recipe emission |
| --- | --- | --- |
| `size` | `"md"` | `sm` → `"px-2.5 py-1.5 text-xs"`; `md` → `"px-3 py-2 text-sm"`; `content` → **emits nothing** (`""`). [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts), `TEXTAREA_SIZE_CLASSES`. |
| `chrome` | `"bordered"` | `bordered` → `"block w-full rounded-md border border-border bg-input-bg text-text transition-colors placeholder:text-text-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text focus-visible:border-accent aria-invalid:border-error"`; `bare` → `"outline-none"`; `focus-only` → `"outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-text"`. [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts), `FIELD_CHROME_CLASSES`. |

- **Boolean / constraints:** `invalid=false` is OR-ed with Field context's `invalid`. Inherited `required` has no local prop initializer; `Boolean(rest.required)` is OR-ed with Field context's `required` and rendered as `true` or omitted. No discriminated union. `element` is bindable to the actual textarea. Unlike TextInput, this component declares no custom `autofocus` prop or focus effect.
- **Bits:** no bits-ui wrapper; native `<textarea>` plus local Field context.
- **No axis for:** disabled opacity/cursor (`FIELD_BASE_CLASSES`); independent bordered radius (`rounded-md`), border width (`border`) or focus-ring width (`focus-visible:ring-2`). `size` couples horizontal padding, vertical padding and type scale; the textarea recipe emits no fixed height.
- **Trap:** `bare` still emits `outline-none`; it supplies no focus indicator or visual invalid treatment. The `chrome` comment recommends pairing it with `size="content"` when the surrounding row supplies the affordance.
- **Inherited attributes:** `HTMLTextareaAttributes`, excluding `class`, `value`, and `aria-invalid`; unconsumed attributes pass through `...rest`.

### Select

[Select.svelte](../../src/lib/frontend/components/ui/Select.svelte) renders a native select with child options and consumes Field's accessibility context.

| Prop | Default | Member → exact recipe emission |
| --- | --- | --- |
| `size` | `"md"` | `sm` → `"h-8 px-2.5 text-xs"`; `md` → `"h-9 px-3 text-sm"`. [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts), `CONTROL_SIZE_CLASSES`. |

The component always adds `FIELD_CHROME_CLASSES.bordered` from [field-styles.ts](../../src/lib/frontend/components/ui/field-styles.ts): `"block w-full rounded-md border border-border bg-input-bg text-text transition-colors placeholder:text-text-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text focus-visible:border-accent aria-invalid:border-error"`.

- **Boolean / constraints:** `invalid=false` is OR-ed with Field context's `invalid`. Inherited `required` has no local prop initializer; `Boolean(rest.required)` is OR-ed with Field context's `required` and rendered as `true` or omitted. `multiple` is explicitly excluded from the public native attribute type. No discriminated union. `children` is required. `value` is bindable with no initial value; the source comment records an undefined default to retain the native first-option selection.
- **Bits:** no bits-ui wrapper; native `<select>` plus local Field context.
- **No axis for:** chrome, width, radius, border width/colour, background, text colour or focus-ring width: the bordered recipe is unconditional. Disabled opacity/cursor are also fixed by `FIELD_BASE_CLASSES`. `size` couples height, padding and type scale; Select exposes neither `size="content"` nor an independent padding axis.
- **Inherited attributes:** `HTMLSelectAttributes`, excluding `class`, native numeric `size`, `value`, `multiple`, and `aria-invalid`; unconsumed attributes pass through `...rest`.

## Floating

The floating recipes below live in [floating-styles.ts](../../src/lib/frontend/components/ui/floating-styles.ts). A `class` prop appends classes; it does not replace recipe utilities. Conflicting utilities are a trap: their order in the stylesheet decides the winner.

The [Bits adoption ownership contract](../plans/2026-07-29-bits-ui-adoption.md) assigns positioning/collision, dismissal, focus trap/restore, roving focus and menu/listbox ARIA to Bits. The entries below identify the actual wrapped parts; installed dependency code is unavailable in this checkout, so inherited Bits prop defaults and runtime guarantees are not asserted.

Shared fixed recipes (interpolations expanded from that file):

- Surface base: `"border border-border bg-bg-alt py-1 focus-visible:outline-hidden data-[side=top]:shadow-menu data-[side=bottom]:shadow-dropdown data-[side=left]:shadow-panel data-[side=right]:shadow-panel"`.
- Portaled surface: surface base + `"rounded-lg z-[var(--z-popover)]"`.
- Detached surface: surface base + `"z-[var(--z-dropdown)]"`.
- Item base: `"flex cursor-default select-none items-center text-sm hover:bg-bg focus:bg-bg focus:outline-hidden data-[disabled]:pointer-events-none data-[disabled]:opacity-50"`.
- Item padding: `"px-3 py-1.5"`.

### Menu

[Menu.svelte](../../src/lib/frontend/components/ui/Menu.svelte) has no component-purpose doc comment; it renders the `DropdownMenu` root, trigger, portal and content.

| Prop | Default | Members and class emission |
| --- | --- | --- |
| `side` | **default: unclear**; destructured without a default at `Menu.svelte:57`, omitted when undefined, delegated to bits-ui | `top`, `right`, `bottom`, `left`: each emits nothing directly; shared surface selectors map the resulting `data-side` to `"data-[side=top]:shadow-menu"`, `"data-[side=right]:shadow-panel"`, `"data-[side=bottom]:shadow-dropdown"`, `"data-[side=left]:shadow-panel"` respectively ([recipe](../../src/lib/frontend/components/ui/floating-styles.ts)). All four selectors are emitted together. |
| `align` | `start` (`FLOATING_POSITIONING_DEFAULTS.align`) | `start`, `center`, `end`: each emits nothing; forwarded as a positioning option. |

Boolean: `open = false` is bindable; changes update `open` and call `onopenchange`. No component-defined discriminated constraint.

Bits: wraps `DropdownMenu.Root`, `.Trigger`, `.Portal`, `.Content`; delegates positioning and menu interaction to these components, forces `loop: true`, and supplies its own content ID and initial-focus handler.

**No axis for:** surface radius (`rounded-lg`), vertical padding (`py-1`), border/background, elevation selectors or stacking tier; content overflow is fixed to `"max-h-[var(--bits-dropdown-menu-content-available-height)] overflow-y-auto"` in the [recipe](../../src/lib/frontend/components/ui/floating-styles.ts).

### MenuItem

[MenuItem.svelte](../../src/lib/frontend/components/ui/MenuItem.svelte) has no component-purpose doc comment; it renders a dropdown item as an anchor when `href !== undefined`, otherwise a `div`.

| Prop | Default | Members → exact recipe classes |
| --- | --- | --- |
| `variant` | `default` | `default` → `"text-text"`; `danger` → `"text-error"` ([recipe](../../src/lib/frontend/components/ui/floating-styles.ts)). |
| `density` | `default` | `default` → `"gap-2 px-3 py-1.5"` (source expression: `` `gap-2 ${FLOATING_ITEM_PADDING_CLASSES}` ``); `touch` → `"gap-2.5 px-4 py-3"` ([recipe](../../src/lib/frontend/components/ui/floating-styles.ts)). |

Booleans: `disabled = false`, `closeOnSelect = true`, both forwarded to Bits. Discriminants: `variant: "danger"` permits `icon` (default `"trash-2"`); the default variant forbids `icon`. The danger branch renders the icon in `"shrink-0"`. The `href` branch accepts anchor attributes; the other branch permits only `href?: undefined` and uses div attributes.

Bits: wraps `DropdownMenu.Item`, forwarding disabled state, selection callback and close-on-select policy; item interaction and ARIA props come from Bits' child snippet.

**No axis for:** padding or gap independently of density; typography (`text-sm`), hover/focus fill (`hover:bg-bg focus:bg-bg`), and disabled opacity (`data-[disabled]:opacity-50`) are fixed in the [item base](../../src/lib/frontend/components/ui/floating-styles.ts). Padding through `class` is the trap: the recipe still emits its own, and stylesheet order decides the winner. Use `density`.

### MenuGroup

[MenuGroup.svelte](../../src/lib/frontend/components/ui/MenuGroup.svelte) has no component-purpose doc comment; it renders a required `label` above grouped children.

No component-defined closed string unions, booleans or discriminated constraints. `label` is required.

Bits: wraps `DropdownMenu.Group` and `.GroupHeading`, using Bits' group/heading props; the heading's rendered `div` overrides its role to `presentation`.

**No axis for:** heading padding (`"px-3 py-1.5"`, [recipe](../../src/lib/frontend/components/ui/floating-styles.ts)), typography and colour (`"text-xs font-medium text-text-muted"`, inline component recipe).

### MenuRadioGroup

[MenuRadioGroup.svelte](../../src/lib/frontend/components/ui/MenuRadioGroup.svelte) has no component-purpose doc comment; it binds a string value across radio items.

No component-defined closed string unions, booleans or discriminated constraints. `value` is an unrestricted string, bindable with default `""`.

Bits: wraps `DropdownMenu.RadioGroup`, binding selection value and forwarding its change callback and element props.

**No axis for:** none evidenced by a hardcoded visual recipe; this wrapper emits no fixed class string.

### MenuRadioItem

[MenuRadioItem.svelte](../../src/lib/frontend/components/ui/MenuRadioItem.svelte) has no component-purpose doc comment; it renders a radio item and a check icon when Bits reports `checked`.

No component-defined closed string union. Booleans: `disabled = false`, `closeOnSelect = true`, forwarded to Bits. `value: string` is required; no discriminated constraint.

Bits: wraps `DropdownMenu.RadioItem`, delegates radio state and item props, and reads `checked` from its child snippet.

**No axis for:** density/padding/gap (fixed `"gap-2 px-3 py-1.5"`), font size and hover/focus/disabled appearance (shared item base), radio colours (`"data-[state=unchecked]:text-text data-[state=checked]:text-accent"`), and content distribution (`"justify-between"`). Shared classes come from [floating-styles.ts](../../src/lib/frontend/components/ui/floating-styles.ts); distribution is inline. Unlike MenuItem, this component has no density prop.

### MenuSeparator

[MenuSeparator.svelte](../../src/lib/frontend/components/ui/MenuSeparator.svelte) has no component-purpose doc comment; it renders a separator inside a dropdown menu.

No component-defined closed string unions, booleans or discriminated constraints.

Bits: wraps `DropdownMenu.Separator` and spreads its child props; the wrapper explicitly sets `role="separator"`.

**No axis for:** margin, thickness or colour: the inline recipe is `"my-1 h-px bg-border"`.

### Popover

[Popover.svelte](../../src/lib/frontend/components/ui/Popover.svelte) has no component-purpose doc comment; it renders trigger-controlled, portaled content with `role="dialog"`.

| Prop | Default | Members and class emission |
| --- | --- | --- |
| `side` | **default: unclear**; `Popover.svelte:58` leaves it undefined and delegates it to Bits | `top`, `right`, `bottom`, `left`: each emits nothing directly; the shared surface emits the four placement shadow selectors listed above ([recipe](../../src/lib/frontend/components/ui/floating-styles.ts)). |
| `align` | `start` (`FLOATING_POSITIONING_DEFAULTS.align`) | `start`, `center`, `end`: each emits nothing; positioning option. |

Boolean: `open = false` is bindable; changes update it and call `onopenchange`. Required-prop union: provide `title: string` with no `ariaLabel`, or `ariaLabel: string` with no `title`. Whitespace-only names cause a development warning; a nonblank title renders a heading and supplies `aria-labelledby`.

Bits: wraps `Popover.Root`, `.Trigger`, `.Portal`, `.Content`; delegates floating content mechanics through Bits and configures fixed positioning. The wrapper owns the dialog role, accessible name and background-inert exemption.

**No axis for:** surface radius, padding, border/background, elevation or stacking tier (shared portaled recipe); title padding (`"px-3 py-1.5"`, shared recipe), typography and colour (`"text-sm font-semibold text-text"`, inline recipe).

### Modal

[Modal.svelte](../../src/lib/frontend/components/ui/Modal.svelte) has no component-purpose doc comment; it renders a controlled dialog panel with optional header, footer and close button.

| Prop | Default | Members → exact inline recipe classes |
| --- | --- | --- |
| `size` | `md` | `sm` → `"max-w-80"`; `md` → `"max-w-md"`; `lg` → `"max-w-2xl"` ([source](../../src/lib/frontend/components/ui/Modal.svelte)). |

Booleans: `open` is required and controlled, with no default; dismissal calls required `onclose` instead of mutating it. `dismissible = true` gates Escape and outside-click callbacks. `showClose = true` independently gates the close button: **`dismissible={false}` does not disable that button**. Required-prop union: `title: string` with no `ariaLabel`, or `ariaLabel: string` with no `title`.

Bits: wraps `Dialog.Root`, `.Portal`, `.Overlay`, `.Content`, `.Title`, `.Description`; consumes Bits' dialog/label/description props and dismissal events. The wrapper adds a Tab guard for panels without tabbable descendants and owns background inerting; underlying Bits focus behavior was not independently verified.

**No axis for:** panel width, maximum height, gap, radius, border, background, padding and shadow, fixed by `"relative flex max-h-[85vh] w-[90%] flex-col gap-4 rounded-xl border border-border bg-bg-alt px-6 py-5 shadow-modal"`; backdrop styling is `"fixed inset-0 z-[var(--z-modal)] bg-backdrop backdrop-blur-[2px]"`; footer alignment/gap is `"flex justify-end gap-2"`. All are inline recipes in the component.

### Tooltip

[Tooltip.svelte](../../src/lib/frontend/components/ui/Tooltip.svelte) has no component-purpose doc comment; it renders portaled tooltip content associated with a trigger.

| Prop | Default | Members and class emission |
| --- | --- | --- |
| `side` | **default: unclear**; `Tooltip.svelte:56` leaves it undefined and delegates it to Bits | `top`, `right`, `bottom`, `left`: each emits nothing directly; the shared surface emits the four placement shadow selectors listed above ([recipe](../../src/lib/frontend/components/ui/floating-styles.ts)). |
| `align` | `center` | `start`, `center`, `end`: each emits nothing; positioning option. |

Boolean: `open = false` is bindable. No component-defined discriminated constraint. `delayDuration = 700`; the provider receives fixed `skipDelayDuration = 300` (both milliseconds, source constants). The source warns that changing content `id` while open leaves Bits' trigger description pointing at the old ID; this dependency behavior was not independently verified.

Bits: wraps `Tooltip.Provider`, `.Root`, `.Trigger`, `.Portal`, `.Content`; delegates timing and floating trigger/content wiring, supplying stable trigger/content IDs and `role="tooltip"`.

**No axis for:** radius, vertical padding, border/background, elevation or stacking tier (shared surface), maximum width, horizontal padding, typography or colour (fixed `"max-w-xs px-2 text-xs text-text"`, [recipe](../../src/lib/frontend/components/ui/floating-styles.ts)).

### DetachedListbox

[DetachedListbox.svelte](../../src/lib/frontend/components/ui/DetachedListbox.svelte) is the shared surface for a combobox whose input lives outside the list, per its doc comment.

No component-defined closed string union, boolean or discriminated union. `id` and `ariaLabel` are required. The type excludes `role`, `tabindex`, `aria-activedescendant` and `aria-owns`; the wrapper sets `role="listbox"` and `data-side="top"`.

Bits: none. Per its doc comment, the caller owns open state, options, active index, keyboard handling and dismissal; this surface stays inline.

**No axis for:** placement (`data-side="top"`), corner radius, vertical padding, border/background, shadow or stacking tier (shared detached recipe). `class` only appends.

There used to be a `radius` union here, because CommandMenu and FileMenu wore `rounded-xl` while DirectoryAutocomplete and every portaled surface wore `rounded-lg`. The split ran along which feature owned the file rather than anything a reader could see, and at this app's 12px root it was 9px against 6px, so the union collapsed to the one canonical radius (conduit-test-de3.6).

### Disclosure

[Disclosure.svelte](../../src/lib/frontend/components/ui/Disclosure.svelte) is the expand/collapse header row used by the chat cards, per its doc comment. It belongs here as the expand/collapse control requested alongside floating primitives; it renders an inline button.

| Prop | Default | Members → exact recipe classes |
| --- | --- | --- |
| `look` | `card` | `card` → `"text-xs text-text-dimmer hover:bg-bg-surface"`; `section` → `"text-sm font-medium text-text hover:bg-[rgba(var(--overlay-rgb),0.03)]"`; `row` → `"text-sm hover:bg-[rgba(var(--overlay-rgb),0.03)]"`. Inline `LOOK_CLASSES` interpolates `HOVER_FILL_CLASSES.surface` / `["overlay-soft"]` from [button-recipes.ts](../../src/lib/frontend/components/ui/button-recipes.ts). `row` emits nothing for resting text colour. |
| `density` | `default` | `default` → `"gap-2.5 py-2"`; `compact` → `"gap-2 py-1"`; `tight` → `"gap-1.5 py-2"`; `roomy` → `"gap-2 py-2.5"`; `split` → `"py-2"` (emits nothing for gap). Inline `DENSITY_CLASSES` in [Disclosure.svelte](../../src/lib/frontend/components/ui/Disclosure.svelte). |

Booleans: `expanded` is required, controlled and not bindable; it sets `aria-expanded` and `rotate-90` on the optional chevron. `chevron = true` controls that decorative icon. `selectable = false` emits `"select-none"`; true emits `"select-text"`. Required `onToggle` handles clicks. No discriminated constraint. `ariaControls` is optional (default `undefined`); the doc comment says to supply it when the region is always rendered.

Bits: none; the native button owns its click affordance and the wrapper supplies `aria-expanded`/`aria-controls`.

**No axis for:** full width, horizontal padding, text alignment and transition (`"flex items-center w-full px-3 text-left cursor-pointer transition-colors duration-150"`, inline base); chevron colour, dimensions and transition are fixed by `"text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"`. **Trap:** `tight` has more vertical padding than `compact`; density members are preserved pairings, not an ordered scale.

## Display

### Badge

A passive `<span>` for labels, counts, and tags, per its doc comment. [Source and inline recipes](../../src/lib/frontend/components/ui/Badge.svelte).

| Prop | Default | Member → exact class string |
| --- | --- | --- |
| `variant` | `neutral` | `neutral` → `"bg-bg text-text-dimmer border border-border"`; `accent` → `"bg-accent-bg text-accent"`; `accent-solid` → `"bg-accent text-bg"`; `tag` → `"bg-[rgba(var(--overlay-rgb),0.05)] text-text-dimmer"` |
| `size` | `xs` | `xs` → `"px-1.5 py-0.5 text-xs font-medium"`; `sm` → `"px-2 py-0.5 text-sm font-medium"`; `count` → `"min-w-[18px] h-[18px] px-[5px] text-xs font-semibold leading-none justify-center"` |
| `shape` | `rounded` | `rounded` → `"rounded"`; `pill` → `"rounded-full"` |

All mappings above are in `Badge.svelte`. Every member also receives `BASE_CLASSES`: `"inline-flex items-center gap-1 whitespace-nowrap shrink-0"`.

Booleans/constraints: none declared locally; `children` is required. Inherits span HTML attributes. Bits: no.

No axis for: inter-child gap, wrapping, or shrinking, fixed by `gap-1 whitespace-nowrap shrink-0`; independent font weight or padding, bundled into `size`.

Trap: `size="count"` does not select a shape. The default remains `shape="rounded"`; request `pill` separately when needed.

### Surface

The structural `<div>` shell behind the app's panels, cards and insets, per its doc comment. [Source and inline recipes](../../src/lib/frontend/components/ui/Surface.svelte).

| Prop | Default | Member → exact class string |
| --- | --- | --- |
| `variant` | `card` | `card` → `"bg-bg-surface border border-border"`; `quiet` → `"bg-bg-surface border border-border-subtle"`; `plain` → `"bg-bg-surface"`; `bare` → `""`, **emits nothing**; `raised` → `"bg-bg-alt border border-border"`; `inset` → `"bg-code-bg border border-border-subtle"` |
| `padding` | `none` | `none` → `""`, **emits nothing**; `sm` → `"px-3 py-2"`; `md` → `"px-4 py-3"`; `lg` → `"px-5 py-4"` |
| `radius` | `panel` | `none` → `""`, **emits nothing**; `sm` → `"rounded"`; `md` → `"rounded-lg"`; `lg` → `"rounded-xl"`; `panel` → `"rounded-panel"` |
| `elevation` | `none` | `none` → `""`, **emits nothing**; `menu` → `"shadow-menu"`; `menu-lg` → `"shadow-menu-lg"`; `panel` → `"shadow-panel"`; `modal` → `"shadow-modal"`; `dropdown` → `"shadow-dropdown"` |

All mappings above are in `Surface.svelte`; there is no additional base class recipe.

Booleans/constraints: none declared locally; `children` is required. Inherits div HTML attributes. Bits: no.

No axis for: independent border width or border colour, bundled into `variant`.

Trap: `none` removes that axis's emission; it does not emit a reset utility. `raised` selects background/border, not elevation. Background's empty member is `bare`, despite the development collision warning recommending `variant="none"`, which is not a valid member.

### Icon

No component-purpose doc comment. The template renders the Lucide component selected by the local name map. [Source](../../src/lib/frontend/components/ui/Icon.svelte).

Closed string unions: none. `name` is an open `string`, not a union of map keys; `size` is a number, default `16`. The template's fixed class is `"lucide"`, followed by `class`, default `""`. It renders nothing when the lookup finds no component.

Booleans/constraints: none; `name` is required. Bits: no; imports from `@lucide/svelte`.

No axis for: none established by a local recipe. The shared [stylesheet](../../src/lib/frontend/style.css) fixes `.lucide` to `vertical-align: middle` and `flex-shrink: 0`; neither has a dedicated Icon prop.

### BlockGrid

No component-purpose doc comment. The template labels the two-row grid `"Conduit loading indicator"`. [Source and inline styling](../../src/lib/frontend/components/ui/BlockGrid.svelte).

| Prop | Default | Member → emission |
| --- | --- | --- |
| `mode` | `static` | `static` → **emits nothing** as a mode-specific class; sets each block's inline opacity with `staticOpacity`. `animated` → **emits nothing** as a mode-specific class; sets inline `pixel-cascade-a` / `pixel-cascade-b` animations with duration `2.4s`, stagger spread `1.6s`. `fast` → **emits nothing** as a mode-specific class; uses those same animations with duration `1.4s`, stagger spread `1.0s`. |

All members receive the fixed wrapper class `"inline-grid"` in `BlockGrid.svelte`. Mode changes inline styles, not a Tailwind recipe. Stagger step is spread divided by `cols - 1` when `cols > 1`, otherwise zero; the lower row reverses the delay order.

Boolean: `glow`, default `false`, appends an inline drop-shadow filter only when true and `mode !== 'static'`. No discriminated required-prop constraints. Bits: no.

No axis for: row count, fixed to `repeat(2, ...)`; row colours, fixed to `var(--color-brand-a)` and `var(--color-brand-b)`; independent block radius, calculated as `Math.max(0.5, blockSize / 4)` in pixels. Block size, gap and column count do have numeric props.

### ConduitLogo

No component-purpose doc comment. The template combines the `conduit` wordmark and BlockGrid. [Source and inline recipe](../../src/lib/frontend/components/ui/ConduitLogo.svelte).

`size`, default `standard`, selects `CONFIGS` in `ConduitLogo.svelte`. Literal pixel values below are unaffected by root-font scaling.

| Member | Exact text class | BlockGrid configuration | Wrapper gap |
| --- | --- | --- | --- |
| `standard` | `"text-2xl"` | `blockSize: 3.5`, `gap: 1.5`, `cols: 10`, `glow: true` | `"4px"` |
| `loading` | `"text-[28px]"` | `blockSize: 8`, `gap: 3`, `cols: 10`, `glow: true` | `"6px"` |
| `sidebar` | `"text-[14px]"` | `blockSize: 2`, `gap: 1`, `cols: 10`, `glow: false` | `"3px"` |
| `inline` | `"text-base"` | `blockSize: 2`, `gap: 0.75`, `cols: 5`, `glow: false` | `"2px"` |

The text's fixed classes are `"font-medium tracking-[0.14em] text-text font-brand"`; the wrapper's are `"flex flex-col items-center"`. `blockSize` and BlockGrid `gap` are literal pixels. The checked-in theme sets `text-2xl` to 24px and `text-base` to 12px, so neither is reduced by the root font size.

Booleans: `animated`, default `false`, selects BlockGrid `static` when false, `fast` when true with `size="inline"`, and `animated` for other true cases. `showText`, default `true`, controls whether the wordmark span renders. No discriminated required-prop constraints. Bits: no; delegates the grid to BlockGrid.

No axis for: layout direction or alignment, fixed by `flex-col items-center`; text weight, tracking, colour or font family, fixed by the text classes; independent grid dimensions/glow or wrapper gap, bundled into `size`.
