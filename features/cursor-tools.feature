Feature: Cursor tools use the transcript's existing activity rows

Scenario Outline: inspect Cursor tool activity while output streams and after completion
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the Cursor turn relay is ready
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  And I type Render Cursor tools into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And the Cursor shell starts with command printf cursor-tools
  And I expand the Cursor activity log
  And I expand the Cursor shell row
  Then the Cursor shell row keeps the base projected status
  When the Cursor shell streams stdout first stdout chunk
  Then the Cursor shell output contains first stdout chunk
  When the Cursor shell streams stderr stderr warning
  Then the Cursor shell output contains first stdout chunk
  And the Cursor shell output contains stderr warning
  When the Cursor shell finishes with exit code 7
  Then the Cursor shell row is an error
  And the Cursor shell exit code is 7
  When the Cursor relay publishes file changes
  Then the Cursor edit row shows old value replaced by new value with 1 added and 1 removed
  And the Cursor write row shows its content and 2 added lines without a removed count
  And the Cursor delete row shows its path and 23 bytes without invented lines
  When I scroll the transcript down by 200 pixels
  And I scroll the transcript back to the bottom
  Then the transcript is pinned to the bottom
  And the jump-to-latest control is not visible
  And the messages region visually matches cursor-tools-file-changes at <threshold> percent
  When the Cursor relay publishes exploration tools
  Then all Cursor exploration tools have compact rows
  When the Cursor relay publishes MCP, todos and a plan
  Then the Cursor MCP row identifies docs and lookup
  And the Cursor todo panel contains Review the patch and 1/2
  And the Cursor plan renders the heading Cursor implementation plan
  When the Cursor relay publishes computer actions and media
  Then the Cursor computer row lists click, type, scroll and screenshot
  And the Cursor computer screenshot is attached
  And the Cursor generated image is attached to its generic row
  And the Cursor recording is attached to its generic row
  When I scroll the transcript back to the bottom
  Then the transcript is pinned to the bottom
  And the jump-to-latest control is not visible
  And the messages region visually matches cursor-tools-media at <threshold> percent
  When the Cursor relay publishes unknown and truncated tools
  Then the unknown Cursor tool shows its arguments and result
  And the truncated Cursor output is marked as truncated
  When the Cursor task reports progress Reviewing the page
  Then the running Cursor turn shows progress Reviewing the page
  And the Cursor task remains a generic row
  When the Cursor relay completes the turn
  Then the Cursor composer is idle
  And every Cursor tool row remains available
  And the Cursor read row is completed

Examples:
  | tier  | threshold |
  | wide  | 98        |
  | phone | 98        |

Scenario Outline: an expanded shell keeps streaming after its full command loads
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  And the harness logo is viewed in the <tier> tier
  And the Cursor turn relay is ready
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  And I type Render Cursor tools into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And the Cursor shell starts with a preview of a long command
  And I expand the Cursor activity log
  And I expand the Cursor shell row
  Then the Cursor shell loads its full command before output arrives
  And the Cursor shell row keeps the base projected status
  When the Cursor shell streams stdout output after full command loads
  Then the Cursor shell output contains output after full command loads
  When the Cursor shell streams stderr warning after full command loads
  Then the Cursor shell output contains output after full command loads
  And the Cursor shell output contains warning after full command loads
  When the Cursor shell finishes with exit code 0
  Then the Cursor shell row is completed
  And the Cursor shell exit code is 0
  And the Cursor shell output contains output after full command loads
  And the Cursor shell output contains warning after full command loads

Examples:
  | tier  |
  | wide  |
  | phone |
