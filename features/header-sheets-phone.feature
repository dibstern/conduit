Feature: Phone header sheets drop down and dismiss upwards

Scenario Outline: The task drop-down springs back from a short pull and dismisses on a long pull
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a working goal
  And the session has 4 live background tasks
  And the background task launcher details are available
  When I click the background tasks row
  Then the task sheet rests below the phone header with scrim below it
  When I drag the task sheet up by 16 pixels
  Then the task sheet rests below the phone header with scrim below it
  When I drag inside the task sheet down by 80 pixels
  Then the task sheet rests below the phone header with scrim below it
  When I drag the task sheet up by 180 pixels
  Then the background tasks pull-down is closed
  When I click the background tasks row
  Then the task sheet rests below the phone header with scrim below it
  And the layout region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                               | threshold |
  | header-sheets-tasks-reopened-phone      | 98        |

Scenario: An upward drag scrolls a long task list until its bottom
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 24 live background tasks with long descriptions
  When I click the background tasks row
  Then the task sheet rests below the phone header with scrim below it
  When I drag inside the task sheet up by 180 pixels
  Then the task sheet rests below the phone header with scrim below it
  And the task sheet body has scrolled

Scenario: The task drop-down's scrim covers the composer
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 4 live background tasks
  When I click the background tasks row
  Then the composer is covered by the drop-down's scrim

Scenario: The Side Threads drop-down's scrim covers the composer
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And the session has 3 Side Threads
  When I click the Side Threads control
  Then the composer is covered by the drop-down's scrim

Scenario: The goal details drop-down's scrim covers the composer
  Given the conduit app is served with the connected mockup
  And the viewport is a phone
  And the composer status clock is frozen
  And a session already exists on the Claude harness
  And goal details are available for a stuck goal
  When I click the session goal subtitle
  Then the composer is covered by the drop-down's scrim

Scenario: The session drop-down's scrim covers the composer
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I open the overflow session sheet
  Then the composer is covered by the drop-down's scrim

Scenario: The skills drop-down's scrim covers the composer
  Given the viewport is a phone
  And the session loaded the skills "release-notes by you in turn 1"
  And the conduit app is served with the long-transcript mockup
  When I open the skills chip
  Then the composer is covered by the drop-down's scrim
