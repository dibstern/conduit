Feature: Branch session diff by size tier and base

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

Scenario Outline: A re-list relabels and re-fetches a pair whose mode changed
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <path> diff shows its patch
  When the <path> mode changes from <mode_before> to <mode_after>
  And I select the Files right pane tab
  And I select the Diff right pane tab
  Then the <path> diff is labelled "<mode_label>"
  And the <path> patch was requested <requests> times

Examples:
  | count | path       | mode_before | mode_after | mode_label      | requests |
  | 1     | file-01.ts | 100644      | 100755     | 100644 → 100755 | 2        |

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

Scenario Outline: A revision pushed while a listing runs lists again once that listing lands
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <first_path> diff shows its patch
  And the diff is live
  When the next diff listing is held
  And the <first_path> pair changes
  And the diff's current revision is pushed
  And the held diff listing has been asked for
  And the <second_path> pair changes
  And the diff's current revision is pushed
  And the held diff listing lands
  Then the diff was listed <lists> times
  And the last diff listing asked for the pushed revision
  And the <second_path> patch was requested <requests> times

Examples:
  | count | first_path | second_path | lists | requests |
  | 2     | file-01.ts | file-02.ts  | 3     | 2        |

Scenario Outline: Picking a diff base shares it with the session and re-lists against it
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  And the project has branches <first_branch> and <second_branch>
  When I open the Diff right pane
  Then the diff compares against <default_ref>
  When I pick <second_branch> as the diff base
  Then the diff base was set to <second_branch>
  And the diff was last listed against <second_branch>
  And the diff compares against <second_branch>
  When I pick Automatic as the diff base
  Then the diff base was set to automatic
  And the diff was last listed against automatic
  And the diff compares against <default_ref>

Examples:
  | count | first_branch | second_branch | default_ref |
  | 1     | main         | release       | main        |

Scenario Outline: A base that cannot be compared falls back with a visible notice
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> <size> unstaged files
  And the diff base <wanted> is <reason>, so the diff falls back to <ref>
  When I open the Diff right pane
  Then the diff compares against <ref>
  And the diff notice reads "<notice>"
  And the right-pane region visually matches <baseline> at <threshold> percent

Examples:
  | count | size  | wanted      | reason  | ref  | notice                                                                               | baseline                  | threshold |
  | 1     | long  | release     | missing | main | release was not found, so this compares against main.                                | session-diff-base-missing | 98        |
  | 0     | small | origin/main | shallow | HEAD | This clone is shallow, so origin/main has no shared history. Comparing against HEAD. | session-diff-base-shallow | 98        |

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

Scenario Outline: A settled turn's footer opens the files its run changed, labelled when another session shared the folder
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the <turn_id> turn changed <first_path> and <second_path> in a <sharing> folder
  And the panel choice session has a settled turn
  When I expand the surfaced turn
  Then the turn footer shows "<entry>"
  When I open the turn's changed files
  Then the turn diff lists <first_path> and <second_path>
  And the <first_path> diff shows its patch
  And the turn diff <label> labelled as shared with other sessions
  And the messages region visually matches <baseline> at 98 percent

Examples:
  | turn_id        | first_path | second_path  | sharing | entry           | label  | baseline            |
  | surfacing-user | src/app.ts | src/util.ts  | shared  | 2 files changed | is     | turn-diff-shared    |
  | surfacing-user | src/app.ts | src/util.ts  | private | 2 files changed | is not | turn-diff-private   |

Scenario Outline: A turn without a capture says Not captured and links to the Diff pane
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the <turn_id> turn was not captured
  And the panel choice session has a settled turn
  When I expand the surfaced turn
  Then the turn footer says Not captured
  And the messages region visually matches <baseline> at 98 percent
  When I open the branch diff from the turn footer
  Then the Diff right pane is selected

Examples:
  | turn_id        | baseline               |
  | surfacing-user | turn-diff-not-captured |

Scenario Outline: An evicted turn still lists its files and line counts, marked Pruned, without a patch
  Given message surfacing is inactive at Most
  And the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the <turn_id> turn changed <first_path> by <insertions> and <deletions> lines and <second_path>, then was pruned
  And the panel choice session has a settled turn
  When I expand the surfaced turn
  Then the turn footer shows "<entry>"
  And the turn footer says Pruned
  When I open the turn's changed files
  Then the turn diff lists <first_path> and <second_path>
  And the <first_path> diff is marked Pruned with +<insertions> −<deletions> and no patch

Examples:
  | turn_id        | first_path | second_path | insertions | deletions | entry           |
  | surfacing-user | src/app.ts | src/util.ts | 12         | 4         | 2 files changed |
