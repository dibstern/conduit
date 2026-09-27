Feature: Phone session bar

Scenario: The session owns the top bar on a phone
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then the session bar title is above the transcript
  And the global header is not rendered

Scenario: Back returns to the session list
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I tap back to the session list
  Then the session list is open

# The collapse is a walk through the state machine rather than four separate
# scenarios: the interesting claims are all about transitions, and a transition
# needs the step before it to have actually happened.
#
# The bar is asserted expanded at the bottom before any scrolling, which is the
# arrival rule: the controls are visible at least once, and only the first user
# scroll hands over to the collapse rule. The jump-to-latest assertions are here
# to prove the scroll steps actually moved the transcript -- without them, a
# scroll that silently did nothing also leaves the bar expanded, and the
# scenario would pass for the wrong reason.
Scenario Outline: The bar collapses at the bottom and the chevron brings it back
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then the session bar is expanded
  When I scroll the transcript back to the bottom
  Then the session bar is expanded
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  And the session bar is expanded
  When I scroll the transcript back to the bottom
  Then the jump-to-latest control is not visible
  And the session bar is collapsed
  And the session-bar region visually matches <baseline> at <threshold> percent
  When I tap the chevron to show the bar
  Then the session bar is expanded
  And the transcript is pinned to the bottom

Examples:
  | baseline                | threshold |
  | session-bar-collapsed   | 98        |
