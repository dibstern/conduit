Feature: Unstaged session diff by size tier

Scenario Outline: Small diffs load on their own, long ones on a click, and too-large files open in Files
  Given the conduit app is served with the long-transcript mockup
  And the session has unstaged changes: <auto_path> small, <on_demand_path> long, <binary_path> binary and <too_large_path> of <too_large_bytes> bytes
  When I open the Diff right pane
  Then the diff lists <binary_path>, <too_large_path>, <auto_path> and <on_demand_path>
  And the <auto_path> diff shows its patch
  And the <binary_path> diff is marked binary without a patch
  And the <on_demand_path> diff waits for a click
  And the <too_large_path> diff shows <too_large_size> without a patch
  And the right-pane region visually matches <baseline> at <threshold> percent
  When I load the <on_demand_path> diff
  Then the <on_demand_path> diff shows its patch
  When I open the <too_large_path> diff in Files
  Then the Files right pane is selected
  And the file preview shows <too_large_path>

Examples:
  | auto_path  | on_demand_path   | binary_path     | too_large_path | too_large_bytes | too_large_size | baseline           | threshold |
  | src/app.ts | src/generated.ts | assets/logo.png | data/dump.json | 1258291         | 1.2 MB         | session-diff-tiers | 98        |

Scenario Outline: Small diffs below the fold load as they scroll into view
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <first_path> diff shows its patch
  And the <last_path> patch has not been requested
  When I scroll the diff to <last_path>
  Then the <last_path> diff shows its patch

Examples:
  | count | first_path | last_path  |
  | 30    | file-01.ts | file-30.ts |

Scenario Outline: A collected listing re-lists without an error
  Given the conduit app is served with the long-transcript mockup
  And the session has unstaged changes: <auto_path> small, <on_demand_path> long, <binary_path> binary and <too_large_path> of <too_large_bytes> bytes
  And the first <auto_path> patch is gone
  When I open the Diff right pane
  Then the <auto_path> diff shows its patch
  And the diff was listed <lists> times
  And the diff shows no error

Examples:
  | auto_path  | on_demand_path   | binary_path     | too_large_path | too_large_bytes | lists |
  | src/app.ts | src/generated.ts | assets/logo.png | data/dump.json | 1258291         | 2     |

Scenario Outline: A hidden Diff pane does not list, and showing it again re-lists
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  And I select the Files right pane tab
  Then the diff was listed <first_lists> times
  When I select the Diff right pane tab
  Then the diff was listed <shown_lists> times

Examples:
  | count | first_lists | shown_lists |
  | 1     | 1           | 2           |

Scenario Outline: A listing that lands after a session switch stays with its session
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the "<other>" session
  And I open the Files right pane
  And I open the "<first>" session
  And the next diff listing is held
  And I open the Diff right pane
  And I open the "<other>" session
  And the held diff listing lands
  And the next diff listing is held
  And I select the Diff right pane tab
  And the held diff listing lands
  Then the <path> diff shows its patch
  And every diff patch was requested with its own session's revision
  And the diff shows no error

Examples:
  | count | first                 | other                 | path       |
  | 1     | Fix model selector UI | Add dark mode support | file-01.ts |
