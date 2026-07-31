Feature: Model drift is visible only with complete mismatch evidence

Scenario Outline: Drifted turn shows composer and transcript warnings
  Given the conduit app is served with the drifted-model mockup
  Then the composer model drift indicator reads ⚠ Running Fable 5 — you selected Opus
  And the turn model drift marker reads ⚠ Ran Fable 5, not Opus
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline         | threshold |
  | model-drift-dark | 98        |

Scenario: Drifted turn falls back to the raw model id
  Given the conduit app is served with the raw-id-model-drift mockup
  Then the composer model drift indicator reads ⚠ Running claude-unlisted-5 — you selected Opus
  And the turn model drift marker reads ⚠ Ran claude-unlisted-5, not Opus

Scenario: Normal turn renders no drift UI
  Given the conduit app is served with the matching-model mockup
  Then no composer model drift indicator is rendered
  And no turn model drift marker is rendered

Scenario: Partial drift evidence renders no drift UI
  Given the conduit app is served with the partial-model-drift mockup
  Then no composer model drift indicator is rendered
  And no turn model drift marker is rendered
