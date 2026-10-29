Feature: Shared Files and Diff pane

Scenario Outline: Desktop tabs share a width and restore the selected tab after reload
  Given the conduit app is served with the long-transcript mockup
  When I open the Files right pane
  And I resize the right pane to its minimum width
  Then the right-pane region visually matches right-pane-desktop-files at <threshold> percent
  When I select the Diff right pane tab
  Then the Diff right pane is selected
  And the right pane keeps its minimum width
  And the right-pane region visually matches <baseline> at <threshold> percent
  When I reload the right pane session
  Then the Diff right pane is selected
  And the right pane keeps its minimum width
  When I select the Files right pane tab
  Then the Files right pane is selected
  When I close the right pane
  Then the right pane is closed and chat is available

Examples:
  | baseline                | threshold |
  | right-pane-desktop-diff | 98        |

Scenario Outline: Phone tabs fill the screen and close back to chat
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I open the Files right pane
  Then the Files right pane is selected
  And the right pane fills the phone screen
  And the right-pane region visually matches right-pane-phone-files at <threshold> percent
  When I preview a file in the right pane
  Then exactly one file preview is visible
  When I select the Diff right pane tab
  Then the Diff right pane is selected
  And the right-pane region visually matches <baseline> at <threshold> percent
  When I select the Files right pane tab
  Then exactly one file preview is visible
  When I press Escape in the right pane
  Then the Files right pane is selected
  And the file tree is visible without a preview
  When I close the right pane
  Then the right pane is closed and chat is available

Examples:
  | baseline              | threshold |
  | right-pane-phone-diff | 98        |
