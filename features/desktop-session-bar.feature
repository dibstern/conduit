Feature: Desktop merged session bar

Scenario Outline: The merged bar contains the global actions
  Given the conduit app is served with the long-transcript mockup
  Then the desktop session bar remains one row
  When I enable the desktop Debug action
  And I open the session overflow menu
  Then the desktop overflow lists Share, Settings and Debug panel in order
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | desktop-session-bar-overflow | 98        |

Scenario: Scrolling to the bottom keeps the desktop bar in one row
  Given the conduit app is served with the long-transcript mockup
  When I scroll the transcript up by 400 pixels
  And I scroll the transcript back to the bottom
  Then the desktop session bar remains one row
