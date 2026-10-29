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

Scenario Outline: Each folder's files group under its own heading, and an unavailable folder errors alone
  Given the conduit app is served with the long-transcript mockup
  And the session diff has folders <first_folder> with <first_path>, <second_folder> with <second_path>, and <gone_folder> unavailable
  When I open the Diff right pane
  Then the <first_folder> diff group is headed <first_name> and lists <first_path>
  And the <second_folder> diff group is headed <second_name> and lists <second_path>
  And the <gone_folder> diff group is headed <gone_name> and shows "<error>"
  And the <first_path> diff shows its patch
  And the <second_path> diff shows its patch
  And the right-pane region visually matches <baseline> at <threshold> percent

Examples:
  | first_folder     | first_path | first_name | second_folder  | second_path   | second_name | gone_folder        | gone_name | error                                  | baseline             | threshold |
  | /workspace/myapp | src/app.ts | myapp      | /workspace/api | src/server.ts | api         | /workspace/feature | feature   | This folder's changes are unavailable. | session-diff-folders | 98        |

Scenario Outline: Submodule, LFS, symlink, mode-only, renamed, CRLF and non-UTF-8 files are labelled, with no broken patch
  Given the conduit app is served with the long-transcript mockup
  And the session has unstaged edge cases: submodule <submodule_path>, LFS <lfs_path>, symlink <link_path>, mode change <script_path> from <mode_before> to <mode_after>, rename <old_path> to <moved_path>, CRLF <crlf_path> and Latin-1 <latin1_path>
  When I open the Diff right pane
  Then the <submodule_path> diff is labelled "<submodule_label>"
  And the <submodule_path> diff reads "<submodule_body>" without a patch
  And the <lfs_path> diff is labelled "<lfs_label>"
  And the <lfs_path> diff reads "<lfs_body>" without a patch
  And the <script_path> diff is labelled "<mode_label>"
  And the <script_path> diff reads "<unchanged_body>" without a patch
  And the <moved_path> diff reads "<unchanged_body>" without a patch
  And the <link_path> diff is labelled "<link_label>"
  And the <link_path> diff shows its patch
  And the <crlf_path> diff shows its patch
  And the <crlf_path> diff is labelled "<crlf_label>"
  And the <latin1_path> diff shows its patch
  And the <latin1_path> diff is labelled "<latin1_label>"
  And the right-pane region visually matches <baseline> at <threshold> percent

Examples:
  | submodule_path | submodule_label | submodule_body            | lfs_path       | lfs_label | lfs_body           | link_path    | link_label | script_path      | mode_before | mode_after | mode_label       | old_path   | moved_path    | unchanged_body      | crlf_path       | crlf_label | latin1_path      | latin1_label        | baseline                | threshold |
  | vendor/lib     | Submodule       | Commit 5555555 → 6666666  | assets/art.psd | Git LFS   | Stored in Git LFS. | current      | Symlink    | scripts/build.sh | 100644      | 100755     | 100644 → 100755  | old/doc.md | docs/guide.md | No content changes. | windows/run.bat | CRLF       | legacy/names.txt | Not UTF-8 (Latin-1) | session-diff-edge-cases | 98        |
