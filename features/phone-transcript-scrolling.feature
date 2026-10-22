Feature: Phone transcript scrolling

Scenario: A long path in an error notice stays within the phone transcript
  Given the viewport is a phone
  And the conduit app is served with the long-path-error mockup
  Then the transcript does not scroll sideways

Scenario Outline: Jump to latest appears away from the bottom and hides on return
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript back to the bottom
  Then the jump-to-latest control is not visible
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  And the layout region visually matches <baseline> at <threshold> percent
  When I scroll the transcript back to the bottom
  Then the jump-to-latest control is not visible

Examples:
  | baseline                  | threshold |
  | transcript-scrolled-up    | 98        |

# Idle on purpose: a turn in progress already follows. A message from another
# device lands while nothing is running, and must still follow a reader who
# was parked at the bottom.
Scenario: A message from another device follows a transcript parked at the bottom
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  Then the jump-to-latest control is visible
  When I scroll the transcript back to the bottom
  Then the jump-to-latest control is not visible
  When another device sends the message Sent from my laptop while the phone watches.
  Then the transcript is pinned to the bottom

# Rows that render a beat after a follow scroll, but before its scroll event,
# must not read as the reader scrolling away.
Scenario: Late-rendering rows do not detach a transcript that is following
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the transcript is pinned to the bottom
  And the transcript grows by 130 pixels just after First from my laptop. lands
  When another device sends the message First from my laptop.
  And another device sends the message Second from my laptop.
  Then the transcript is pinned to the bottom
