Feature: Composer matches the final design (docs/plans/2026-10-02-composer-final-designs.html)

Scenario Outline: phone idle composer is one row with the design's controls
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  Then the composer has 1 row
  And the composer placeholder reads Ask Claude…
  And the placeholder sits on the controls row
  And the composer has no standalone agent selector
  And the model button is 32 pixels tall and reads S5
  And the effort meter is visible
  And send is a 32 pixel square in the off colours
  And the attach button has no border
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | composer-final-idle-phone  | 98        |

Scenario Outline: desktop idle composer shows name chips and the short placeholder
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  Then the composer has 1 row
  And the composer placeholder reads Ask Claude…
  And the placeholder sits on the controls row
  And the composer has no standalone agent selector
  And the model chip reads Sonnet 5 · 200K with a chevron
  And the effort chip reads Default
  And send is a 32 pixel square in the off colours
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                    | threshold |
  | composer-final-idle-desktop | 98        |

Scenario Outline: working composer shows a solid stop with a small square
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When the open session starts working
  Then the composer placeholder reads Ask Claude…
  And stop is a 32 pixel square filled with the text colour around a 10 pixel square
  And send is hidden while the field is empty
  And the composer region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                       | threshold |
  | phone    | composer-final-working-phone   | 98        |
  | desktop  | composer-final-working-desktop | 98        |

Scenario Outline: the picker root carries the agent and switches it
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  And the composer picker has the Claude catalog
  When I open the model picker
  Then the picker root rows are harness, model, context, effort, agent
  And the model-picker region visually matches <baseline> at <threshold> percent
  When I view Agent choices in the picker
  Then the picker lists agents Planner, Reviewer
  When I choose agent Reviewer in the picker
  Then the relay is asked to switch the agent to reviewer
  And the picker agent row reads Reviewer

Examples:
  | viewport | baseline                           | threshold |
  | phone    | composer-final-picker-root-phone   | 98        |
  | desktop  | composer-final-picker-root-desktop | 98        |
