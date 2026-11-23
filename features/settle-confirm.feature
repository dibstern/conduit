Feature: Every manual Settle asks before changing a session

Scenario Outline: Header Settle asks and confirming preserves navigation and Undo
  Given the viewport is a <viewport>
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using header
  Then settle confirmation shows Settle this session? with action Settle
  And settle confirmation consequence move is Moves to Settled, and you go back to your sessions.
  And settle confirmation has no servers consequence
  And settle confirmation has no worktree consequence
  And settle confirmation is a <placement>
  And no settle confirmation write has happened
  And settle confirmation evidence is saved as open
  When I accept settle confirmation using button
  Then settle confirmation wrote true for 1 session
  And the session list is open
  And the settle confirmation toast offers Undo

Examples:
  | viewport | placement |
  | phone    | sheet     |
  | desktop  | center    |

Scenario Outline: Cancel leaves every manual entry point unchanged
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using <entry>
  Then settle confirmation shows Settle this session? with action Settle
  And no settle confirmation write has happened
  When I cancel settle confirmation using <cancel>
  Then settle confirmation cancellation preserves the session and URL

Examples:
  | entry          | cancel |
  | header         | button |
  | row menu       | button |
  | row key        | Escape |
  | transcript key | Escape |
  | global key     | Escape |
  | global alias   | Escape |

Scenario: Escape in a subagent session cancels without going to the parent
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the mock relay replays a session family with a parent
  And the settle confirmation fixture is plain
  When I request settle confirmation using header
  Then settle confirmation shows Settle this session? with action Settle
  When I cancel settle confirmation using Escape
  Then settle confirmation cancellation preserves the session and URL

Scenario Outline: Menu and shortcut confirmation settles with Enter
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using <entry>
  Then settle confirmation shows Settle this session? with action Settle
  And no settle confirmation write has happened
  When I accept settle confirmation using Enter
  Then settle confirmation wrote true for 1 session
  And the settle confirmation toast offers Undo

Examples:
  | entry          |
  | row menu       |
  | row key        |
  | transcript key |
  | global key     |
  | global alias   |

Scenario: Repeating the shortcut keeps one confirm and sends one write
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using global key
  And I press the global settle shortcut again
  Then settle confirmation shows Settle this session? with action Settle
  And no settle confirmation write has happened
  When I accept settle confirmation using Enter
  Then settle confirmation wrote true for 1 session

Scenario Outline: A settle swipe holds the row while asking
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using <entry>
  Then settle confirmation shows Settle this session? with action Settle
  And the settle confirmation swipe row stays open
  And settle confirmation evidence is saved as swipe
  And no settle confirmation write has happened
  And the screen region visually matches <baseline> at 98 percent
  When I cancel settle confirmation using button
  Then the settle confirmation swipe row slides back
  And settle confirmation cancellation preserves the session and URL

Examples:
  | entry       | baseline                  |
  | full swipe  | settle-confirm-swipe-full |
  | swipe tray  | settle-confirm-swipe-tray |

Scenario: Confirming a settle swipe settles the row
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using full swipe
  Then the settle confirmation swipe row stays open
  When I accept settle confirmation using button
  Then settle confirmation wrote true for 1 session
  And the settle confirmation toast offers Undo

Scenario Outline: Single-session copy includes only applicable consequences
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is <fixture>
  When I request settle confirmation using header
  Then settle confirmation shows Settle this session? with action Settle
  And settle confirmation session titles are <title>
  And settle confirmation <servers> servers consequence
  And settle confirmation <worktree> worktree consequence

Examples:
  | fixture | title               | servers | worktree |
  | plain   | Confirmation target | has no  | has no   |
  | servers | Confirmation target | has a   | has no   |
  | worktree| Confirmation target | has no  | has a    |
  | all     | Confirmation target | has a   | has a    |
  | untitled| New Session         | has no  | has no   |

Scenario Outline: Server and worktree copy names the consequences
  Given the viewport is a <viewport>
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is all
  When I request settle confirmation using header
  Then settle confirmation consequence servers is Stops 2 servers.
  And settle confirmation consequence worktree is Its worktree checkout-one can be removed once merged and clean. The branch is kept.
  And the screen region visually matches <baseline> at 98 percent

Examples:
  | viewport | baseline                   |
  | phone    | settle-confirm-all-phone   |
  | desktop  | settle-confirm-all-desktop |

Scenario: A non-open session does not promise navigation
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request settle confirmation using other row menu
  Then settle confirmation consequence move is Moves to Settled.
  When I accept settle confirmation using button
  Then settle confirmation wrote true for 1 session
  And settle confirmation keeps the open session URL

Scenario Outline: Bulk Settle asks once with selection totals
  Given the viewport is a <viewport>
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is bulk
  When I request settle confirmation using bulk bar
  Then settle confirmation shows Settle 5 sessions? with action Settle 5
  And settle confirmation session titles are Confirmation target|Second session|Third session|and 2 more
  And settle confirmation consequence move is They move to Settled.
  And settle confirmation consequence servers is Stops 3 servers in 2 sessions.
  And settle confirmation consequence worktree is Their worktrees can be removed once merged and clean. Branches are kept.
  And settle confirmation evidence is saved as bulk
  And settle confirmation is a <placement>
  And no settle confirmation write has happened
  And the screen region visually matches <baseline> at 98 percent
  When I accept settle confirmation using button
  Then settle confirmation wrote true for 5 sessions
  And the settle confirmation toast offers Undo

Examples:
  | viewport | placement | baseline                    |
  | phone    | sheet     | settle-confirm-bulk-phone   |
  | desktop  | center    | settle-confirm-bulk-desktop |

Scenario: Cancelling bulk Settle preserves the selection without a toast
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is bulk
  When I request settle confirmation using bulk bar
  Then settle confirmation shows Settle 5 sessions? with action Settle 5
  When I cancel settle confirmation using button
  Then settle confirmation cancellation preserves the session and URL
  And the settle confirmation bulk selection remains
  When I press bulk Settle again
  Then settle confirmation shows Settle 5 sessions? with action Settle 5

Scenario: Bulk copy omits servers and worktrees when none apply
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is bulk plain
  When I request settle confirmation using bulk bar
  Then settle confirmation shows Settle 2 sessions? with action Settle 2
  And settle confirmation session titles are Confirmation target|Second session
  And settle confirmation has no servers consequence
  And settle confirmation has no worktree consequence

Scenario Outline: Undo never asks for confirmation
  Given the viewport is a desktop
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is <fixture>
  When I request settle confirmation using <entry>
  And I accept settle confirmation using button
  Then settle confirmation wrote true for <count> sessions
  When I undo the confirmed settle
  Then settle confirmation wrote false for <count> sessions
  And no settle confirmation is open

Examples:
  | fixture | entry    | count |
  | plain   | header   | 1     |
  | bulk    | bulk bar | 5     |

Scenario Outline: Un-settle never asks
  Given the viewport is a <viewport>
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is settled
  When I request settle confirmation using <entry>
  Then settle confirmation wrote false for 1 session
  And no settle confirmation is open

Examples:
  | viewport | entry  |
  | phone    | header |
  | desktop  | header |

Scenario Outline: Delete shares the responsive confirm presentation
  Given the viewport is a <viewport>
  And the conduit app is served with the long-transcript mockup
  And the settle confirmation fixture is plain
  When I request deletion from the settle confirmation row menu
  Then settle confirmation is a <placement>
  When I cancel settle confirmation using button
  Then settle confirmation cancellation preserves the session and URL

Examples:
  | viewport | placement |
  | phone    | sheet     |
  | desktop  | center    |
