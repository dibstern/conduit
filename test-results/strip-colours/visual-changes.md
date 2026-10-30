# Strip colour verification

Follow-up to c3d5fee8 on `tlr/strip-colours`. No baseline was recaptured or modified. Comparisons below are against the existing committed baselines, not against c3d5fee8.

## Result

- 15 focused acceptance examples pass. Before the fix, all 10 question exposure/target examples failed: exposed width was 0px and hit width was 8px. The four compaction examples already passed on c3d5fee8. A further chip-target regression was reproduced and fixed during review.
- The diagnostic audit exercised 233 examples: 232 pass and the pre-existing paged-skill reveal locator fails. It compared 199 screenshots covering 177 named viewport/shot states: 81 have nonzero differences, 29 exceed the unchanged visual gate, and 96 match exactly. The two phone `turn-log-question`/`turn-log-plan` shots now differ by exactly 500 pixels and are within the gate, reducing the previous 31 failures to 29.
- The regular `turn-opening` visual gate passes. `turn-activity` still fails its first intended changed shot; `turn-reveal` stops on the existing paged-skill locator failure. The complete visual gate is not green.

## Fix and evidence

Question bands reserve 18px, excluding human waiting time from proportional work widths. A 12px face plus its 1px ring leaves 4px of the question's own band exposed. The 10px glyph is larger than the previous 8px glyph. Six faces occupy 72px of the 336px dense phone strip, versus 114px for 19px faces. The 90-step fixture still has six separate markers, two compaction seams and at least 2px ordinary bands. The minimum measured face gap is 6.55px, or 4.55px between rings.

Transparent pseudo-elements provide 24px by 24px targets. Pointer routing chooses the nearest question face in an overlap, with ties going left. Direct clicks on painted work bands still open their own rows. In the open Jev layout, the transparent target extends downward to clear the message chips above it. Mouse and synthetic touch assertions cover expanded targets and both sides of adjacent-target midpoints; existing acceptance cases cover keyboard question navigation. Trusted mouse pointer capture is exercised; native iOS touch behavior was not tested.

The whole-turn check found no indexing bug. `MessageList` passes `turnLog(turn).segment`, whose activity flattens all Turn segments, into `TurnActivity` and `ActivityStrip`. Acceptance compares the complete strip order with the complete log, checks work-popover ordinals across both compaction seams and all hand-back boundaries, and clicks bands before/between/after those boundaries to verify focused, visible log rows. The four cases cover 90-step multi-segment and 12-step single-segment compacted turns with Jev on and off. No production change to `ActivityStrip` was needed.

All `turn-qa-*`, `turn-log-*` and `turn-waiting-*` shots are owned by `features/turn-activity.feature`; running that feature covers the requested scoped Q&A/hand-back features.

## Verification commands

Commands ran in this worktree. Each acceptance run used port 43211. Logs are under `regression-logs/`; generated PNG/JSON evidence remains local and ignored by git.

```sh
env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 pnpm acceptance:functional turn-activity
# Before fix: exit 1, waiting exposed width 0px. red.log.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 CONDUIT_BASE_URL=http://localhost:43211 STRIP_EVIDENCE=red pnpm exec tsx test-results/strip-colours/regressions.ts
# Before fix against c3d5fee8's frontend build: 4 pass, 10 fail. red-final.log and red-regressions.json.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 CONDUIT_BASE_URL=http://localhost:43211 STRIP_EVIDENCE=green pnpm exec tsx test-results/strip-colours/regressions.ts
# After fix: 15 pass, 0 fail. green-final-verified.log and green-regressions.json.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 CONDUIT_BASE_URL=http://localhost:43211 pnpm exec tsx test-results/strip-colours/chips-red.ts
# Restore only the centered target in browser CSS: exit 1, painted message-chip click opens Q&A.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 CONDUIT_BASE_URL=http://localhost:43211 pnpm exec tsx acceptance/generated/turn-reveal.acceptance.ts test-results/strip-colours/chip-ir.json
# Shifted target: exit 0, painted message-chip click selects its message. chips-green.log.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 STRIP_EVIDENCE=review-fixed pnpm acceptance:visual turn-activity
# Exit 1: turn-qa-navigation-active-desktop-offers, 1700 differing pixels, limit 500.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 STRIP_EVIDENCE=review-fixed pnpm acceptance:visual turn-opening
# Exit 0: all opening assertions and screenshots pass.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 STRIP_EVIDENCE=review-fixed pnpm acceptance:visual turn-reveal
# Exit 1: existing paged-skill reveal locator, also present in logs/original-reveal.log.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 CONDUIT_BASE_URL=http://localhost:43211 STRIP_EVIDENCE=review-fixed pnpm exec tsx test-results/strip-colours/audit-regression.ts
env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false ACCEPTANCE_PORT=43211 CONDUIT_BASE_URL=http://localhost:43211 STRIP_EVIDENCE=review-fixed AUDIT_RERUN=1 pnpm exec tsx test-results/strip-colours/audit-regression.ts
# Diagnostic only: preserves screenshot failures and continues behavior checks.
# Final results: 232/233 examples pass; 199 comparisons, 29 named states over the gate.
# Rerun corrected diagnostic viewport/screen selectors and checked the updated chip assertion.

env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false pnpm check:frontend
env npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false pnpm check:svelte
# Both exit 0; Svelte reports 0 errors and 0 warnings.

node scripts/check-class-token-drop.mjs
# Exit 0, no undeclared class-token drops.
```

The compiler/build commands also ran through the acceptance scripts. The final commit runs the full local pre-commit gate with both dependency-verification environment flags false, stdin from `/dev/null`, no `--no-verify`, and `core.hooksPath=.beads/hooks` for this invocation. The configured absolute hooks path points to the excluded main checkout, so the identical hook from this worktree is used. A local PATH wrapper constrains all hook Beads calls to `bd --readonly --sandbox`; no Beads state writes or pushes are authorized.

## Review

Sol reviewed the five code/test/waiver paths in two rounds and approved the final production change. Its one material finding was the open Jev chip/expanded-target collision, reproduced by pointer and fixed by moving that target downward. The existing transparent strip container already overlaps the lowest approximately 1.5px of the chip; the new regression samples 3px above the chip bottom to isolate the added target collision. That pre-existing strip-container behavior is unchanged.

Astra inspected all 31 baseline/current/diff crops, four dense 390px phone screenshots, and full phone waiting views. It observed exposed settled question colour, legible question glyphs, separate dense markers and no unintended transcript, layout or control changes. Four extra timeline crops bring the waiting strip into view; all four pass the follow-up visual review for exposed colour and a legible question mark. Animation and invisible target routing are established by the acceptance assertions, not the static review.

## Changed shots

Every nonzero named state is listed below with its intent. The actual/diff files are in `final-audit/<feature>/<viewport>/`; the original baseline is `acceptance/visual/baselines/<viewport>/<shot>.png`. The 31 reviewed crops are indexed in `astra-review/index.json`. `final-audit-results.json` contains all comparisons and behavior results, including exact zero matches.

### Above the existing gate

| Viewport | Shot | Differing pixels | Why retained |
| --- | --- | ---: | --- |
| desktop | turn-log-async-desktop | 2189 | Expose both answered and async-question band colours without assigning human waiting time a share of model work. |
| desktop | turn-log-plan-desktop | 952 | The answered hand-back retains its own coloured band around the compact question face; work widths continue to exclude human waits. |
| desktop | turn-log-question-desktop | 952 | The answered hand-back retains its own coloured band around the compact question face; work widths continue to exclude human waits. |
| desktop | turn-log-waiting-desktop | 2351 | Expose the waiting accent band around its marker and the earlier answered question colour. The live pulse is separately asserted. |
| desktop | turn-qa-history-active-desktop | 1387 | Both answered question and plan steps expose their own band colour; compact faces leave the surrounding work visible. |
| desktop | turn-qa-history-inactive-desktop | 1395 | Both answered question and plan steps expose their own band colour; compact faces leave the surrounding work visible. |
| desktop | turn-qa-navigation-active-desktop-offers | 1700 | Keep human waits compressed while showing question colour around the legible question face and preserving the other work bands. |
| desktop | turn-qa-navigation-inactive-desktop-offers | 880 | Keep human waits compressed while showing question colour around the legible question face and preserving the other work bands. |
| desktop | turn-qa-pin-active-desktop-1 | 1388 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| desktop | turn-qa-pin-active-desktop-2 | 1388 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| desktop | turn-qa-pin-inactive-desktop-1 | 1396 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| desktop | turn-qa-pin-inactive-desktop-2 | 1393 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| desktop | turn-qa-plan-approved-active-desktop | 2351 | Retain visible question/plan band colour after approval, with a compact 12px question face and compressed human waits. |
| desktop | turn-qa-plan-approved-inactive-desktop | 1557 | Retain visible question/plan band colour after approval, with a compact 12px question face and compressed human waits. |
| desktop | turn-show-hand-back-desktop | 1700 | Q&A keeps the same whole-turn strip, with exposed question colour and a compact face beside readable work bands. |
| desktop | turn-waiting-qa-active-desktop | 1080 | Expose the waiting accent band around its marker and the earlier answered question colour. The live pulse is separately asserted. |
| desktop | turn-waiting-qa-inactive-desktop | 1046 | Expose the waiting accent band around its marker and the earlier answered question colour. The live pulse is separately asserted. |
| phone | turn-log-async-phone | 1228 | Expose both answered and async-question band colours without assigning human waiting time a share of model work. |
| phone | turn-log-waiting-phone | 1278 | Expose the waiting accent band around its marker and the earlier answered question colour. The live pulse is separately asserted. |
| phone | turn-qa-history-active-phone | 677 | Both answered question and plan steps expose their own band colour; compact faces leave the surrounding work visible. |
| phone | turn-qa-history-inactive-phone | 661 | Both answered question and plan steps expose their own band colour; compact faces leave the surrounding work visible. |
| phone | turn-qa-navigation-active-phone-offers | 1014 | Keep human waits compressed while showing question colour around the legible question face and preserving the other work bands. |
| phone | turn-qa-pin-active-phone-1 | 677 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| phone | turn-qa-pin-active-phone-2 | 678 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| phone | turn-qa-pin-inactive-phone-1 | 659 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| phone | turn-qa-pin-inactive-phone-2 | 662 | Selecting either Q&A entry retains the whole chronological strip; its compact question markers leave coloured band edges visible. |
| phone | turn-qa-plan-approved-active-phone | 1278 | Retain visible question/plan band colour after approval, with a compact 12px question face and compressed human waits. |
| phone | turn-qa-plan-approved-inactive-phone | 711 | Retain visible question/plan band colour after approval, with a compact 12px question face and compressed human waits. |
| desktop | turn-reveal-earlier-hand-back | 1678 | Revealing the earlier message retains the whole-turn strip and its compact hand-back marker, exposed question colour and minimum work bands. |

### Nonzero comparisons within the existing gate

| Viewport | Shot | Differing pixels | Why retained |
| --- | --- | ---: | --- |
| 393x900 | turn-show-menu-393 | 50 | Retain the existing responsive summary/menu rendering; this small difference was already recorded before this follow-up. |
| 768x900 | turn-panel-summary-768 | 51 | Retain the existing responsive summary/menu rendering; this small difference was already recorded before this follow-up. |
| phone | turn-card-folded-read-retry-phone | 23 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-card-live-fold-now-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-card-unread-sticks-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-collapsed-category-dots-phone | 72 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-collapsed-keyboard-phone | 21 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-full-log-pins-answer-phone | 61 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-full-log-pins-key-phone | 61 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-hover-step-collapsed | 62 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-jev-off-collapsed-live-phone | 18 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-jev-off-collapsed-settled-phone | 18 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-jev-off-open-live-phone | 18 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-jev-off-open-settled-phone | 18 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-live-collapsed-phone | 41 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-live-default-settled-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-live-streaming-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-log-plan-phone | 500 | The answered hand-back retains its own coloured band around the compact question face; work widths continue to exclude human waits. |
| phone | turn-log-question-phone | 500 | The answered hand-back retains its own coloured band around the compact question face; work widths continue to exclude human waits. |
| phone | turn-log-skills-live-active-phone | 4 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-log-skills-live-inactive-phone | 4 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-log-skills-settled-active-phone | 4 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-log-skills-settled-inactive-phone | 4 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-pin-chips-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-qa-navigation-inactive-phone-offers | 428 | Keep human waits compressed while showing question colour around the legible question face and preserving the other work bands. |
| phone | turn-show-resume-folded-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-show-resume-picked-phone | 67 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-strip-cancel-phone | 23 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-strip-centred-phone | 18 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-usage-live-active-phone | 216 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-usage-live-inactive-phone | 104 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-usage-settled-active-phone | 158 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-usage-settled-inactive-phone | 92 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| desktop | turn-opening-compacted-first-step | 419 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-compacted-reload | 419 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-compacted-working | 223 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-compacting | 175 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-compaction-failed | 175 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-compaction-stopped | 175 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-midturn-compaction | 419 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-sending | 223 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| desktop | turn-opening-working | 419 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-compacted-first-step | 393 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-compacted-reload | 393 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-compacted-working | 206 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-compacting | 174 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-compaction-failed | 174 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-compaction-stopped | 174 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-opening-midturn-compaction | 393 | Inherited opening-state rendering difference, with the same pixel count as the pre-change run; this question-free state is unchanged by this follow-up. |
| phone | turn-reveal-hidden-phone | 59 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-reveal-reply-activity | 41 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |
| phone | turn-reveal-user | 41 | Retain c3d5fee8's visible phone work bands, gaps and anchored indicators. This question-free state is unchanged by the question fix. |

## Residual risks

The unchanged baselines leave 29 intentional visual-gate failures. The paged-skill reveal locator remains a pre-existing behavior-gate failure. Synthetic touch does not establish native iOS behavior. The lower approximately 1.5px chip/strip overlap described above remains unchanged. No baselines, other worktrees, or runtime configuration were modified; nothing was pushed.
