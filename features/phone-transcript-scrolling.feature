Feature: Phone transcript scrolling

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
