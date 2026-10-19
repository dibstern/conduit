Feature: The project tree groups sessions under one header per project

# Atlas has eight sessions, the newest user message; Beacon two; Comet one and
# the newest registration; Delta none. The daemon's saved manual order is
# Delta, Comet, so Atlas and Beacon, which it has never seen, follow it.
Scenario Outline: Every project in the feed gets a header, newest user message first
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  Then the project tree lists <order>
  And the Atlas project shows 6 sessions
  And the Delta project shows the empty row
  And the session-list region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | order                       | baseline             | threshold |
  | desktop  | Atlas, Beacon, Comet, Delta | project-tree-desktop | 98        |
  | phone    | Atlas, Beacon, Comet, Delta | project-tree-phone   | 98        |

Scenario Outline: Projects sort by last user message, by when they were added, or by the saved order
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  And I sort projects by <sort>
  Then the project tree lists <order>
  When I reload the project tree
  Then the project tree lists <order>

Examples:
  | sort              | order                       |
  | Last user message | Atlas, Beacon, Comet, Delta |
  | Created           | Comet, Beacon, Delta, Atlas |
  | Manual            | Delta, Comet, Atlas, Beacon |

Scenario Outline: Dragging a project saves the order to the daemon
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  And I sort projects by Manual
  And I drag the <moved> project above the <target> project
  Then the daemon saves the project order <order>
  And the project tree lists <order>
  And the session-list region visually matches <baseline> at <threshold> percent
  When I reload the project tree
  Then the project tree lists <order>

Examples:
  | moved  | target | order                       | baseline                   | threshold |
  | Beacon | Delta  | Beacon, Delta, Comet, Atlas | project-tree-manual-desktop | 98        |

Scenario Outline: A collapsed project stays collapsed on this device after a reload
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  And I collapse the <project> project
  Then the <project> project is collapsed with 0 sessions shown
  When I reload the project tree
  Then the <project> project is collapsed with 0 sessions shown
  And the <other> project is expanded

Examples:
  | viewport | project | other  |
  | desktop  | Atlas   | Beacon |
  | phone    | Beacon  | Atlas  |

Scenario Outline: The open session stays visible under its collapsed project
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  And I show more in the Atlas project
  And I open the "<session>" session from the project tree
  And I collapse the Atlas project
  Then the Atlas project is collapsed with 1 sessions shown
  And the Atlas project shows the "<session>" session
  And the session-list region visually matches <baseline> at <threshold> percent

Examples:
  | session         | baseline                           | threshold |
  | Atlas session 8 | project-tree-open-collapsed-desktop | 98        |

Scenario Outline: Show more and Show less toggle over loaded rows, and a setting picks how many show
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  Then the Atlas project shows 6 sessions
  When I show more in the Atlas project
  Then the Atlas project shows 8 sessions
  When I show less in the Atlas project
  Then the Atlas project shows 6 sessions
  When I set Sessions per project to <rows> in settings
  Then the Atlas project shows <shown> sessions
  And the Atlas project <toggle> a Show more toggle

Examples:
  | rows | shown | toggle  |
  | 3    | 3     | has     |
  | 15   | 8     | has no  |

Scenario Outline: A project's plus button starts a draft in that project
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the sidebar has the project tree fixture
  When I select All projects in the session list
  And I group the sessions by project
  And I start a new session in the <project> project
  Then a draft opens in the <slug> project

Examples:
  | viewport | project | slug   |
  | desktop  | Beacon  | beacon |
  | phone    | Delta   | delta  |
