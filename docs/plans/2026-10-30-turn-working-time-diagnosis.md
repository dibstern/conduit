# Turn working time: evidence and fix

Investigated at `14d0a679` for `conduit-test-zxahh`. The per-project stores
have migrated to `~/.config/conduit/events.db`. All live queries used
`sqlite3 -readonly`; no live data was changed.

## Reproduction

The diagnostic replay reads messages in `(created_at, id)` order, parts in
`sort_order`, and the same timing fields and synchronous approval intervals
selected by `read-query-effect.ts`. It then calls `messageRowsToHistory`,
`historyToChatMessages`, `segmentTurns`, and `workingTime`. Transcript ranges
end at the next user message, rather than at a persisted `turn_id`: resumed
output can lack that ownership while still belonging to the displayed turn.

Session `ses_003b6997cc02487ba6857a647d16a308`, prompt
`19eae387-ec97-4a33-9294-a2e4cebd5607`:

- Prompt/requested time: `1793265581997`.
- Persisted end: `1793265582022`, only **25 ms** later. The bare completion
  names the prior assistant message, as SDK-local commands can do.
- The frontend groups 32 subsequent activity segments under this prompt.
- The minimized regression retains the first three assistant messages,
  their first thinking parts, actual completion stamps and token presence.
  Content and intermediate steps are omitted.

| Assistant message | First part | Completion | Counted activity |
| --- | ---: | ---: | ---: |
| `msg_011CgWHDGcGNEC7hkXeevzep` | 1793265582792 | 1793265647312 | 65,315 ms from prompt |
| `msg_011CgWHLiTxcyQLGGEYf7vJB` | 1793265683718 | 1793265687608 | 3,890 ms |
| `msg_011CgWJ3Yzqjv2JCoqJWXaSQ` | 1793266237688 | 1793266495853 | 258,165 ms |

This subset spans **913,856 ms**. The two actual idle gaps total **586,486 ms**;
there are no approval waits or opening compactions in this range. Expected
working time is **327,370 ms**. The old calculation returns **25 ms**.

An independent linked-wake example is session
`ses_ebfb8b2d4ab4480f8dc3c2511f63c99c`, turn
`078c81f0-bacf-42ef-994b-76aed35a0e9d`. Its three segments span
`1793256011407` through `1793256747624`. Idle gaps total **507,002 ms**;
expected activity is **229,215 ms**. The persisted end is `1793256090700`,
so the old counter returns **79,293 ms**. All messages have the correct
parent/turn ownership and share run `d68d75a2-2796-429c-b5a2-213850ee596f`.

## Cause and ownership

`workingTime` chooses `turnTiming.endedAt` before either the live clock or
segment stamps. A present end prevents inspection of every later segment.
Neither the preface start clamp nor wait subtraction causes the primary
reproduction: both are absent. Removing gap subtraction would count real
idle time and would still leave the 25 ms end bound in place.

The server already extends correctly owned completed wakes, introduced in
`75400e50`. The stored early ends alone do not demonstrate a remaining
projector-code defect. A server-only change also cannot cover live wakes
before completion or old unowned output without guessing ownership. Changing
durable completion boundaries affects later prompts' queue-start clamps too.

The frontend owns the composite displayed turn. Use `now` while it is live;
allow confirmed segment endings to extend its persisted end when settled.
Keep the persisted end for unfinished activity when the session is no longer
processing. If no persisted end exists, retain the existing stamped-activity
fallback. Preserve opening-compaction exclusion, gap/wait union and `until`.

## Failure modes considered before implementation

- A live resumed segment could remain frozen behind an old persisted end.
- An extended end could accidentally include idle gaps or count overlapping
  approval waits twice.
- A late background-tool update could extend a settled or interrupted turn.
  Confirmed segment ends must take precedence over unfinished part stamps.
- Settled turns could continue growing with `now` after their final result.
- An `until` cut inside an excluded gap could become negative or count idle.
- Missing stamps or opening compactions could lose their existing behavior.
- Approval intervals created after an old persisted end can be absent from
  server timing. Hand-back gaps cover synchronous questions; permission waits
  inside resumed segments require server-supplied intervals. This existing
  source-data limitation is separate from the demonstrated end-bound bug.

The regression checks settled time, economics, clipping inside the second
gap, a live wake advancing by one second, and unfinished non-live activity.
Existing turn tests cover approval unions, compactions, missing stamps and
background completions behind a result.

## Verification

Commands ran with `npm_config_verify_deps_before_run=false`; `pnpm check`
and visual acceptance also used `pnpm_config_verify_deps_before_run=false`.

- `pnpm install --frozen-lockfile`: passed.
- `pnpm exec vitest run --project unit test/unit/handlers/turns.test.ts -t 'counts captured activity'`:
  failed before the fix with expected `327370`, received `25`.
- `pnpm exec vitest run --project unit test/unit/handlers/turns.test.ts test/unit/frontend/activity-timings.test.ts`:
  142 tests passed after the fix.
- `pnpm check`: passed; Svelte reported zero errors and zero warnings.
- `pnpm exec biome check src/lib/frontend/utils/turns.ts test/unit/handlers/turns.test.ts`:
  passed with one pre-existing unused `skillName` import warning.
- `ACCEPTANCE_PORT=43197 pnpm acceptance:visual turn-opening`: passed all 28
  scenarios and 16 comparisons against existing visual baselines. Artifacts
  are generated under `acceptance/visual/artifacts/`.
- The original read-only full-data replay now returns `229215` for the
  independently measured linked-wake example, previously `79293`.
- Independent review found no material issues and checked a resumed approval
  interval, a late background update, live advancement and a cutoff in a gap.
