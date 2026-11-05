Feature: Diff selection lives in the URL

Scenario Outline: Diff on a file in Files opens the Diff at that file, and a second Diff scrolls to it again
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I preview <path> in Files
  And I open the previewed file's diff
  Then the Diff right pane is selected
  And the <path> diff is revealed
  And the <path> diff shows its patch
  And the URL holds the <path> diff selection
  And revealing the diff sent the daemon only diff reads
  When I scroll the diff to <top_path>
  Then the <path> diff is out of view
  When I select the Files right pane tab
  And I open the previewed file's diff
  Then the <path> diff is revealed
  And revealing the diff sent the daemon only diff reads

Examples:
  | count | path       | top_path   |
  | 30    | file-15.ts | file-01.ts |

Scenario Outline: A reload restores the revealed file
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I preview <path> in Files
  And I open the previewed file's diff
  And I scroll the diff to <top_path>
  And I reload the right pane session
  Then the Diff right pane is selected
  And the <path> diff is revealed
  And the URL holds the <path> diff selection

Examples:
  | count | path       | top_path   |
  | 30    | file-15.ts | file-01.ts |

Scenario Outline: A diff link opens the Diff pane at its file, and Diff from Files returns to the default scope
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the diff link for <path> in the <scope> scope
  Then the Diff right pane is selected
  And the <path> diff is revealed
  And the <path> diff shows its patch
  When I preview <next> in Files
  And I open the previewed file's diff
  Then the <next> diff is revealed
  And the URL holds the <next> diff selection

Examples:
  | count | path       | scope    | next       |
  | 30    | file-20.ts | unstaged | file-05.ts |
  | 30    | file-20.ts | retired  | file-05.ts |

Scenario Outline: A diff link reveals its file in the folder it names
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files in each of /workspace/myapp and /workspace/lib
  When I open the diff link for <path> in <folder>
  Then the Diff right pane is selected
  And the <path> diff in <folder> is revealed
  And the <path> diff in <other> is out of view

Examples:
  | count | path       | folder          | other           |
  | 30    | file-20.ts | /workspace/lib  | /workspace/myapp |
  | 30    | file-20.ts | /workspace/myapp | /workspace/lib  |

Scenario Outline: Back returns to the previously revealed file, even from Files
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I preview <first> in Files
  And I open the previewed file's diff
  And I preview <second> in Files
  And I open the previewed file's diff
  Then the <second> diff is revealed
  And the <first> diff is out of view
  When I select the Files right pane tab
  And I go back in the browser
  Then the Diff right pane is selected
  And the <first> diff is revealed
  And the URL holds the <first> diff selection

Examples:
  | count | first      | second     |
  | 30    | file-08.ts | file-22.ts |
