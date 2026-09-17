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
