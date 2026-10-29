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

Scenario Outline: A hidden Diff pane does not list across session switches, and showing it again re-lists
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the "<other>" session
  And I open the Files right pane
  And I open the "<first>" session
  And I open the Diff right pane
  And I select the Files right pane tab
  Then the diff was listed <first_lists> times
  When I open the "<other>" session
  And I open the "<first>" session
  And I open the "<other>" session
  Then the diff was listed <first_lists> times
  When I select the Diff right pane tab
  Then the diff was listed <shown_lists> times

Examples:
  | count | first                 | other                 | first_lists | shown_lists |
  | 1     | Fix model selector UI | Add dark mode support | 1           | 2           |

Scenario Outline: A hidden Diff pane fetches no patch until it is shown again
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  And the first <path> patch is gone
  And the next <path> patch reply is held
  When I open the Diff right pane
  And the next diff listing is held
  And the held diff patch lands
  And I select the Files right pane tab
  And the held diff listing lands
  Then the <path> patch was requested <hidden_requests> times
  When I select the Diff right pane tab
  Then the <path> diff shows its patch
  And the <path> patch was requested <shown_requests> times

Examples:
  | count | path       | hidden_requests | shown_requests |
  | 1     | file-01.ts | 1               | 2              |

Scenario Outline: A Gone that lands after a newer listing retries without another re-list
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  And the first <path> patch is gone
  And the next <path> patch reply is held
  When I open the Diff right pane
  Then the <path> patch was requested <first_requests> times
  When I select the Files right pane tab
  And I select the Diff right pane tab
  Then the diff was listed <lists> times
  When the held diff patch lands
  Then the <path> diff shows its patch
  And the diff was listed <lists> times

Examples:
  | count | path       | first_requests | lists |
  | 1     | file-01.ts | 1              | 2     |

Scenario Outline: A pair that stays gone shows its error after one re-list
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  And every <path> patch is gone
  When I open the Diff right pane
  Then the <path> diff shows its error
  And the diff was listed <lists> times
  And the <path> patch was requested <requests> times

Examples:
  | count | path       | lists | requests |
  | 1     | file-01.ts | 2     | 2        |

Scenario Outline: A re-list fetches only the pair that changed
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <last_path> diff shows its patch
  When the <changed_path> pair changes
  And I select the Files right pane tab
  And I select the Diff right pane tab
  Then the <changed_path> patch was requested <changed_requests> times
  And the <same_path> patch was requested <same_requests> times
  And the <last_path> patch was requested <same_requests> times

Examples:
  | count | same_path  | changed_path | last_path  | changed_requests | same_requests |
  | 3     | file-01.ts | file-02.ts   | file-03.ts | 2                | 1             |

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

Scenario Outline: A row that comes into view as the pane hides loads once the pane is shown
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  And row observations can be held
  When I open the Diff right pane
  Then the <first_path> diff shows its patch
  When row observations are held
  And I scroll the diff to <last_path>
  Then the <last_path> row was seen while observations are held
  When I select the Files right pane tab
  And the held row observations land
  Then the <last_path> patch was requested <hidden_requests> times
  When I select the Diff right pane tab
  And I scroll the diff to <last_path>
  Then the <last_path> diff shows its patch

Examples:
  | count | first_path | last_path  | hidden_requests |
  | 30    | file-01.ts | file-30.ts | 0               |


Scenario Outline: An external change pushes a revision that re-lists once and fetches only the changed pair
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <last_path> diff shows its patch
  And the diff is live
  When the <changed_path> pair changes
  And the diff's current revision is pushed
  Then the diff was listed <lists> times
  And the last diff listing asked for the pushed revision
  And the <changed_path> patch was requested <changed_requests> times
  And the <same_path> patch was requested <same_requests> times
  And the <last_path> patch was requested <same_requests> times

Examples:
  | count | same_path  | changed_path | last_path  | lists | changed_requests | same_requests |
  | 3     | file-01.ts | file-02.ts   | file-03.ts | 2     | 2                | 1             |

Scenario Outline: A pushed revision the view already shows is skipped
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <path> diff shows its patch
  And the diff is live
  When the diff's current revision is pushed
  Then the diff was listed <lists> times
  And the <path> patch was requested <requests> times

Examples:
  | count | path       | lists | requests |
  | 1     | file-01.ts | 1     | 1        |

Scenario Outline: A reconnect compares revisions and fetches only the pairs that changed
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <last_path> diff shows its patch
  And the diff is live
  When the connection drops and the diff subscribes again
  Then the diff was listed <unchanged_lists> times
  When the <changed_path> pair changes
  And the connection drops and the diff subscribes again
  Then the diff was listed <changed_lists> times
  And the <changed_path> patch was requested <changed_requests> times
  And the <same_path> patch was requested <same_requests> times
  And the <last_path> patch was requested <same_requests> times

Examples:
  | count | same_path  | changed_path | last_path  | unchanged_lists | changed_lists | changed_requests | same_requests |
  | 3     | file-01.ts | file-02.ts   | file-03.ts | 1               | 2             | 2                | 1             |

Scenario Outline: A hidden Diff pane closes its live feed and showing it opens one again
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the diff is live
  When I select the Files right pane tab
  Then the diff is not live
  When the <path> pair changes
  And I select the Diff right pane tab
  Then the diff is live
  And the diff was listed <lists> times
  And the <path> patch was requested <requests> times

Examples:
  | count | path       | lists | requests |
  | 1     | file-01.ts | 2     | 2        |
