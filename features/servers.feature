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

Scenario Outline: Settle, Archive and Delete say how many servers they stop, and the toast says it is stopping them
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the session has <count> detected servers
  When I open the session's menu in the list
  Then the menu's Settle reads <settle>
  And the menu's Archive reads <archive>
  And the menu's Delete reads <delete>
  When I <action> the session from its menu
  Then a toast reads <toast>

Examples:
  | count | settle                   | archive                   | delete                   | action  | toast                                                          |
  | 2     | Settle · stops 2 servers | Archive · stops 2 servers | Delete · stops 2 servers | settle  | Moved “Claude session” to Settled · Stopping 2 servers         |
  | 1     | Settle · stops 1 server  | Archive · stops 1 server  | Delete · stops 1 server  | archive | Stopping 1 server                                              |

Scenario Outline: Stop asks first, reads Stopping… until the scan finds the server gone, and shows a failed Stop on the row
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the session has 2 detected servers
  When I press ⌥5
  And I stop the server on port <port>
  Then the confirm asks <question>
  When I confirm the stop
  Then the daemon is asked to stop pid <pid> on port <port>
  And the server on port <port> reads Stopping…
  And the right-pane region visually matches <baseline> at <threshold> percent
  When the server on port <port> exits
  Then the Servers pane lists <remaining>
  When I stop the server on port <other>
  And the daemon will fail the Stop with <failure>
  And I confirm the stop
  Then the server on port <other> shows <failure> and offers Stop again

Examples:
  | port | question                 | pid  | baseline             | threshold | remaining              | other | failure                                                 |
  | 5173 | Stop vite on port 5173?  | 4101 | servers-pane-stopping | 98        | next on 3000 for 1h 5m | 3000  | The server on port 3000 is still running after SIGKILL |

Scenario Outline: An idle session's row keeps its idle glyph and gains the server badge, counting only several, and the badge opens Servers
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the session has <count> detected servers
  Then the session's row keeps its idle glyph and shows a server badge <reading>
  And the session-list region visually matches <baseline> at <threshold> percent
  When I tap the session's server badge
  Then the Servers pane lists <servers>

Examples:
  | count | reading       | baseline                 | threshold | servers                                     |
  | 1     | with no count | session-row-server-badge | 98        | vite on 5173 for 6m                         |
  | 2     | counting 2    | session-row-server-count | 98        | vite on 5173 for 6m, next on 3000 for 1h 5m |

Scenario Outline: On the phone, Servers is the second view card while servers run and opens a full-screen Servers view
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  And the viewport is a phone
  And the session has <count> detected servers
  When I open the overflow session sheet
  Then the view cards read <cards> at today's size
  And the Servers card's corner badge reads <count>
  And the session-sheet region visually matches <sheet_baseline> at <threshold> percent
  When I choose the Servers view card
  Then the Servers pane lists <servers>
  And each server's Open, Copy link and Stop are thumb-sized
  And the right-pane region visually matches <view_baseline> at <threshold> percent
  When I open the overflow session sheet
  Then the Servers card's corner badge is hidden
  When I close the session sheet with its close button
  And the session's servers all exit
  And I open the overflow session sheet
  Then the view cards read <cards_after> at today's size

Examples:
  | count | cards                               | sheet_baseline           | servers                                     | view_baseline      | threshold | cards_after                 |
  | 2     | Chat, Servers, Terminal, Diff, Files | phone-view-cards-servers | vite on 5173 for 6m, next on 3000 for 1h 5m | phone-servers-view | 98        | Chat, Terminal, Diff, Files |
