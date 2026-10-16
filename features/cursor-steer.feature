Feature: Cursor steers a running turn and returns declined input to the queue

Scenario Outline: a delivered Cursor steer leaves the tray and is labelled in the transcript
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
  And I type Keep working into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And I type Use the staging database into the composer
  And I steer the composer message with the keyboard
  Then the relay is asked to steer Use the staging database
  When the Cursor relay holds the steer Use the staging database
  Then pending-input row 1 is Steering Use the staging database
  When the Cursor relay delivers the steer Use the staging database
  Then the pending-input tray is not visible
  And the last user message is labelled Steered
  And the Cursor transcript contains Use the staging database exactly once

Examples:
  | tier  |
  | wide  |
  | phone |

Scenario Outline: a declined Cursor steer returns ahead of queued input and runs next
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
  And I type Keep working into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And I type Use the staging database into the composer
  And I steer the composer message with a modified click
  Then the relay is asked to steer Use the staging database
  When the Cursor relay holds the steer Use the staging database
  And the mock relay queues Run Linux checks afterwards
  And the Cursor relay declines the steer Use the staging database
  Then the pending-input tray has 2 rows
  And pending-input row 1 reads Use the staging database
  And pending-input row 2 reads Run Linux checks afterwards
  When the Cursor relay completes the turn
  And the Cursor relay starts the requeued input Use the staging database
  Then the pending-input tray has 1 row
  And pending-input row 1 reads Run Linux checks afterwards
  And the Cursor transcript contains Use the staging database exactly once
  And the last Cursor user message has no Steered label

Examples:
  | tier  |
  | wide  |
  | phone |

Scenario Outline: a Cursor shell handed off during steering says it moved to the background
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
  And I type Keep working into the composer
  And I send the composer message
  Then the relay creates a Cursor session with model composer-2.5
  When the Cursor relay starts the sent turn
  And the Cursor relay reports a shell moved to the background
  And I expand the Cursor activity log
  Then the collapsed Cursor shell says Moved to background
  When I expand the backgrounded Cursor shell
  Then the Cursor shell detail explains the background handoff
  And the backgrounded Cursor shell does not claim an exit code

Examples:
  | tier  |
  | wide  |
  | phone |
