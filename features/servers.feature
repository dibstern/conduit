Feature: A session's dev servers show on the views rail and in the Servers pane

Scenario: The rail has no Servers button while the session has no servers
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  Then the views rail has no Servers button

Scenario Outline: The rail counts the servers and the pane lists each one with a plain localhost link
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the session has <count> detected servers
  Then the Servers rail button counts <count>
  When I hover the Servers rail button
  Then the rail tooltip reads <tooltip>
  When I press ⌥5
  Then the Servers pane lists <servers>
  And each server opens its plain localhost link in a new tab
  And the right-pane region visually matches <baseline> at <threshold> percent
  When I copy the link of the server on port <port>
  Then a Link copied toast shows and the clipboard contains http://localhost:<port>
  When the session's servers all exit
  Then the views rail has no Servers button
  And the Servers pane says no servers are running

Examples:
  | count | tooltip                | servers                                            | port | baseline             | threshold |
  | 2     | Servers · 2 running ⌥5 | vite on 5173 for 6m, next on 3000 for 1h 5m         | 5173 | servers-pane-desktop | 98        |
