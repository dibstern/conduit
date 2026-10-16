Feature: Cursor subagents stream into their own read-only child sessions

Scenario Outline: open a running Cursor task and return to its parent
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
  And I type Inspect the routing implementation into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And the Cursor relay starts a <mode> subagent with live child steps
  And I expand the Cursor activity log
  Then the Cursor subagent card shows its description, type, SDK model and SDK mode
  And the transcript is pinned to the bottom
  And the messages region visually matches cursor-subagent-card-<tier>-<mode> at <threshold> percent
  When I open the Cursor subagent's child session
  Then the Cursor child shows its own live text, thinking and tool steps
  And the transcript is pinned to the bottom
  And the messages region visually matches cursor-subagent-child-<tier>-<mode> at <threshold> percent
  And the Cursor child is read-only with no composer
  When the Cursor child streams another live update
  Then the Cursor child shows the updated text exactly once
  And the Cursor child is read-only with no composer
  When I return from the Cursor child to its parent
  Then the Cursor parent still shows its task and running composer

Examples:
  | tier  | mode       | threshold |
  | wide  | foreground | 98        |
  | phone | foreground | 98        |
  | wide  | background | 98        |
  | phone | background | 98        |
