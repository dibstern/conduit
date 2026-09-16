# ADR-0003: Feature components do not own control appearance, and a ratchet proves it

- Status: accepted
- Date: 2026-09-16
- Context: conduit-test-de3.35 (approved design), conduit-test-de3.35.1
  (this decision's implementation), the de3.5 phase-4 migration it supersedes

## Context

The design-system migration kept stalling in the same place. A primitive
would land, a handful of consumers would adopt it, and then the next
consumer would need something the primitive did not offer, so it would keep
its bespoke markup "for now". Nothing failed. The review that should have
caught it was a human reading a diff and deciding whether one more
exception was reasonable, which it always is, one at a time.

The result was measurable once we bothered to measure it: 138 native
controls across 45 feature components against 12 files importing
`ui/Button`. Worse, `ui/MenuItem`, `ui/Menu`, `ui/MenuGroup`,
`ui/MenuRadioGroup`, `ui/MenuRadioItem` and `ui/MenuSeparator` were all
complete and had **zero** consumers. The primitives were not the
bottleneck. Adoption was, and nothing in the build noticed.

A style guide does not fix this, because a style guide is advice and
advice loses to a deadline. The only thing that survives is a check that
fails.

## Decision

Features own business operations, content, and surrounding layout. Styled
controls own appearance and interaction behaviour. `pnpm lint` enforces
the boundary via `scripts/check-component-ownership.mjs`, which counts five
kinds of violation across `src/lib/frontend/components/**` and
`src/lib/frontend/style.css`:

| Rule | What it catches |
| --- | --- |
| `native-control-bypass` | A raw `<button>`/`<select>`/`<textarea>`/`<input>` in a feature component |
| `anchor-wearing-button-recipe` | An `<a>` hand-styled to look like a button |
| `appearance-override` | A Tailwind `!` important override in a feature's class list |
| `private-recipe-import` | A feature importing a named export from `components/ui/` |
| `component-class-recipe` | A control or badge recipe living in the global `style.css` |

`components/ui/`, `__fixtures__/` and `*.stories.ts` are exempt: those are
the design system itself, and its test scaffolding.

### The ratchet is the load-bearing part

Every violation that existed when the check landed is recorded in
`scripts/component-ownership-exceptions.json` with an exact count, so the
gate is green on day one. It then fails in **both** directions:

- A count that goes **up** fails as a new violation, naming the file, the
  rule, and the delta.
- A count that goes **down** also fails, with a different message telling
  you to re-run with `--update` to lock in the gain.

The second half is what makes this a ratchet rather than a wall. Without
it the list rots: someone removes the last bespoke button from a file, the
allowance stays at 3, and three new ones can be added later for free. The
failure is deliberately a little annoying, and the fix is one command.

The number in that file is therefore the migration backlog, exactly, and it
is a number rather than an opinion. It should only ever go down.

## Static-analysis limits

This is regex over source text, not a Svelte AST. Know what it cannot do
before you trust it:

- **It counts tags, not intent.** A `<button>` inside a primitive-shaped
  wrapper in a feature directory is a violation even if it is morally a
  primitive. Move it to `components/ui/` or accept the entry.
- **It cannot see through indirection.** A class string built at runtime
  from variables, or a control rendered by a `{@html}` block, is invisible.
  The `appearance-override` rule reads `class="..."`, `class='...'`,
  `class={...}` and `.ts` string literals that look like class lists, and
  nothing else.
- **`appearance-override` is the rule most likely to be wrong**, because
  a bare `!` means four different things in Svelte source. It deliberately
  requires the token to look like a Tailwind utility and to be followed by
  whitespace or a quote, which excludes TypeScript non-null assertions,
  `!==`, `!important` in a `<style>` block, and `{!foo}`. Conservative by
  design: a missed override is a smaller problem than a rule people learn
  to ignore.
- **`component-class-recipe` matches on naming convention** (`-btn`,
  `-button`, `-toggle`, `-badge`, `-item`, plus three named exceptions).
  A control recipe named something else will not be caught. Layout,
  animation, markdown and diff-table classes legitimately live in
  `style.css` and are not in scope.
- **There is no per-line waiver.** Unlike `check-design-tokens.mjs`, which
  takes an inline comment marker, exceptions here are per file and per rule
  in one manifest. That is intentional: the whole point is a single number
  you can watch fall, and inline waivers scatter it across 45 files where
  nobody can total it.

When the checker is wrong, fix the rule or record the exception. Do not
reshape the code to dodge the regex.

## Consequences

Adding a control to a feature component now requires either using a
primitive or consciously adding a line to the exception manifest, which is
visible in review in a way that one more `<button>` never was.

The counts also make batch planning honest. The single largest group is
roughly thirty chat cards that each have one disclosure toggle sharing a
near-identical recipe, which is one mechanical batch rather than thirty
decisions, but only once a disclosure affordance exists to migrate onto.
That gap is now obvious from the numbers instead of being discovered
halfway through.
