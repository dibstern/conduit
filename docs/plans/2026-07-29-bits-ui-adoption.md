# Bits UI adoption — design system Phase 2 reversal

**Status:** decided 2026-07-29. Supersedes the "hand-rolled, no headless library" decision
in `~/.ccs/instances/personal/plans/eager-twirling-sifakis.md` ("Decisions taken" #2).

**Tracked in Beads:** `conduit-test-de3` (epic, rationale), `conduit-test-de3.3.8`
(consolidation — **blocks** `conduit-test-de3.3.4`), `conduit-test-de3.3.4` (Menu/Dropdown/
Popover, rewritten for Bits).

## The decision

Conduit **adopts Bits UI** for interactive/overlay primitives. The original plan chose to
hand-roll them and explicitly listed "adding an external component library" as a non-goal.
That is reversed.

Rationale (user's): sunk cost in the Phase-1 hand-rolled a11y core is irrelevant to a
forward-looking decision. Bits supplies breadth conduit has not built and would otherwise own
indefinitely — Select, Combobox, submenus, typeahead, and the fiddly collision/flip cases —
with hardened accessibility, against an ongoing maintenance burden on hand-rolled ARIA and
keyboard models.

**Verified compatible:** `bits-ui` 2.18.1, `peerDependencies.svelte ^5.33.0`; repo
`package.json` has `svelte ^5.53.3`.

## Split of ownership

**Bits owns** (do not hand-roll, do not re-implement):
positioning + collision/flip, dismissal (Escape / outside-click), focus trap + restore,
roving focus, and listbox/menu ARIA — for **Dialog, DropdownMenu, Popover, Select, Combobox,
Tooltip**.

**Conduit owns:** design-token styling, the wrapper API surface and conventions, and the
per-primitive `story + asserting play() + green addon-a11y` gate.

**Stays hand-rolled** (no a11y machinery, Bits adds nothing): `Button`, `Badge`/`Pill`,
`Card`/`Surface`, the Field set (`TextInput`/`Textarea`/`Select` wrapper/`Field`).

> ⚠️ The Field set's `Select` is a styled native `<select>`. If it is ever upgraded to a
> custom listbox, it moves to Bits `Select` — do not hand-roll that upgrade.

## Do not

- **Do not add `@floating-ui/dom`.** Bits bundles its own positioning. (An interim decision to
  take floating-ui standalone was made and then superseded within the same session — it is void.)
- **Do not ship two dismissal models.** This is the whole risk of a partial adoption; see below.
- **Do not** re-open the hand-rolled-vs-library question without new information.

## Work, in order

### 1. `de3.3.8` — consolidation (must land first)

Phase 1 shipped a hand-rolled a11y core on `ds/phase-1-a11y`
(`components/ui/actions/use-focus-trap.svelte.ts`, `use-dismiss.svelte.ts`,
`use-roving-focus.svelte.ts`, each with unit tests). Phase 2c shipped `Modal.svelte`
(`a5d7325e`) on top of it, using `use:focusTrap` + `use:dismiss`.

Bits provides all three behaviours internally. Leaving both in place gives the design system
two dismissal models, two focus-restore contracts and two keyboard conventions — which defeats
the epic's consistency goal and undermines the Phase 5 "versioned component API" governance.

- Re-base `Modal` as a styled wrapper over **Bits `Dialog`**, preserving its current public API
  where sensible: controlled `open` + `onclose` (never self-mutating), `title` XOR `ariaLabel`
  compile-enforced accessible name, `size` variants, tokenized backdrop with `--z-modal`,
  `showClose`, `dismissible`.
- Then retire `use-focus-trap` / `use-dismiss` / `use-roving-focus`, **or** narrow them to only
  the components Bits does not cover. Audit every consumer before deleting.
- Decide the fate of `components/shared/use-click-outside.svelte.ts` at the same time.
- Keep Modal's existing stories, asserting `play()` tests (focus trap/restore + Escape) and a11y
  checks green **through** the swap — they are the safety net for this refactor.

**Done when:** exactly one dismissal/focus model exists in `components/ui`, and no hand-rolled
action is left imported by nothing.

### 2. `de3.3.4` — Menu / Dropdown / Popover (blocked by the above)

Thin **styled wrappers** over Bits `DropdownMenu` / `Popover` (and `Select`/`Combobox` where
they fit). Consolidates the ~8–12 bespoke dropdowns (`FileMenu`, `CommandMenu`,
`ProjectSwitcher`, `ModelSelector`, `ThemePicker`, `DirectoryAutocomplete`, …).

Conventions to carry over from the `Modal` precedent, where Bits allows:

| Concern | Convention |
|---|---|
| Open state | Controlled: `open` + `onclose`; component never mutates `open`. Not `$bindable`. |
| Trigger | **Consumer owns the trigger element**; the wrapper wires `aria-expanded`/`aria-controls`/`aria-haspopup` + ids onto it. Trigger-shaped props (`triggerVariant`, `triggerAriaLabel`) belong in feature-level wrappers *above* the primitive, never in it. |
| Layering | `--z-dropdown` / `--z-popover` tokens (Phase 0). No numeric `z-[N]` — the design-token lint hard-fails it. |
| Selection | Selecting closes and restores focus to the trigger by default; `closeOnSelect={false}` to opt out. |

## Evidence behind the trigger/positioning conventions

From the competitor `~/src/personal/conduit-competitors/t3code`, which solves this well:

- It uses `@base-ui/react` ^1.4.1, whose `Positioner` wraps `@floating-ui/react-dom`. Flip and
  collision are delegated **entirely** — zero hits for `collisionAvoidance`/`collisionPadding`
  across `apps/` and `packages/`. It only consumes results as CSS vars
  (`--available-width`, `--available-height`, `--transform-origin`).
- Its primitives are **pure passthrough** with zero trigger props —
  `menu.tsx:15` `function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props)`;
  consumers pass their own element, e.g.
  `GitActionsControl.tsx:1735` `<MenuTrigger render={<Button aria-label="Git action options" … />}>`.
  Svelte 5 equivalent: expose a `trigger` snippet receiving attributes to spread, or an
  attachment the consumer applies to their own element.
- **Worth avoiding, from the same repo:** the two places it hand-rolled positioning are its
  weakest overlay code — `ChatComposer.tsx:111` (`getBoundingClientRect` + scroll/resize
  listeners + `ResizeObserver`, and **no flipping at all** — always opens upward) and
  `contextMenuFallback.ts:72` (*clamps* to the viewport rather than flipping). It also
  duplicates its Portal/Positioner/Popup triple across six files with uncoordinated
  z-indices (`z-[60]`, `z-50`, `z-[70]`, `z-[10000]`) — exactly what conduit's Phase-0 z tokens
  prevent. Keep one shared surface and one z scale.

## Coordination note

`ds/phase-2a-button` (worktree `conduit-wt-de32`) was, at the time of this decision, still
marching through Phase 2 hand-rolling primitives — `1f2457c6` Button, `3145e6c2` Field set,
`a5d7325e` Modal, `5c7ff6c3` relocate Icon/BlockGrid/ConduitLogo/Toggle. Menu/Dropdown/Popover
and Tooltip were still ahead of it in that phase. Anything it builds for those two is work
`de3.3.8` exists to undo — check where that branch actually got to before starting.

## Verification (per the epic's standing gate)

```bash
pnpm check
pnpm lint                      # incl. scripts/check-design-tokens.mjs — no numeric z-[N]
pnpm test:unit
pnpm check:storybook           # every story renders
pnpm test:storybook-visual     # update baselines only on intentional change
pnpm acceptance:visual         # MANDATORY if the composer/input area is touched
```

Primitives' `play()` tests must assert keyboard nav + focus trap/restore + ARIA — not merely
render.

## Open risks

- **Bundle size and API churn** from a substantial new dependency; Bits tracks Svelte 5
  closely, so pin and watch upgrades.
- **Token/styling fit** — Bits is headless, but its data-attribute and part structure will
  shape how token classes are applied; expect the wrapper layer to be thicker than a bare
  re-export.
- **Governance wording** — Phase 5's "versioned component API" now means conduit's *wrapper*
  API, layered on Bits' API. Say so explicitly in the contribution guide.
