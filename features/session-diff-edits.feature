Feature: Discard and stage unstaged changes, guarded by what the user saw

Scenario Outline: Discarding a file takes a confirm, and only the confirm writes
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the diff link for <path> in the unstaged scope
  Then the <path> diff offers Stage and Discard
  When I press Discard on the <path> diff
  Then the <path> diff asks to confirm the discard
  And the right-pane region visually matches <baseline> at <threshold> percent
  When I press Cancel on the <path> diff
  Then the <path> diff offers Stage and Discard
  And no diff edit was sent
  When I press Discard on the <path> diff
  And I press Confirm discard on the <path> diff
  Then the daemon was asked to discard <path> as the blob it listed
  And the <path> diff is no longer listed

Examples:
  | count | path       | baseline                     | threshold |
  | 3     | file-02.ts | session-diff-discard-confirm | 98        |

Scenario Outline: An edit of a file that changed since it was listed answers Stale and re-lists in place
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the diff link for <path> in the unstaged scope
  Then the <path> diff shows its patch
  When the <path> pair changes
  And I press Stage on the <path> diff
  Then an error toast titled Could not stage <path> says <message>
  And the diff was listed <lists> times
  And the <path> diff is revealed
  And the <path> diff offers Stage and Discard

Examples:
  | count | path       | message                             | lists |
  | 30    | file-20.ts | file-20.ts changed since it was listed | 2  |

Scenario Outline: An edit while the agent runs answers Busy and changes nothing
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  And the agent is running in the session whose diff is shown
  When I open the diff link for <path> in the unstaged scope
  And I press Discard on the <path> diff
  And I press Confirm discard on the <path> diff
  Then an error toast titled Could not discard <path> says <message>
  And the <path> diff offers Stage and Discard
  And the diff was listed <lists> times

Examples:
  | count | path       | message                    | lists |
  | 3     | file-02.ts | The agent is running       | 1     |

Scenario Outline: A hunk is staged or discarded on its own, from the listing it was shown in
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the diff link for <path> in the unstaged scope
  Then the <path> diff shows its patch
  When I press Stage hunk on the <path> diff
  Then the daemon was asked to stage hunk <hunk> of <path> as the blob it listed
  And the <path> diff is no longer listed
  When I press Discard hunk on the <other> diff
  Then no diff edit was sent after the first
  When I press Confirm discard on the <other> diff
  Then the daemon was asked to discard hunk <hunk> of <other> as the blob it listed

Examples:
  | count | path       | other      | hunk |
  | 3     | file-02.ts | file-03.ts | 0    |
