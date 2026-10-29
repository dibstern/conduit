Feature: Review comments from the diff into the composer

Scenario Outline: A comment on a diff line becomes a composer chip, and removing the chip drops it
  Given the conduit app is served with the long-transcript mockup
  And the session has <count> small unstaged files
  When I open the Diff right pane
  Then the <path> diff shows its patch
  When I comment "<comment>" on <side> line <line> of the <path> diff
  Then the review sent for <path> quotes "<excerpt>" from <side> lines <line> to <line>
  And the composer shows a review chip <chip> saying "<comment>"
  And the composer region visually matches <baseline> at <threshold> percent
  When I remove the review chip <chip>
  Then the composer shows no review chip

Examples:
  | count | path       | side      | line | comment              | excerpt                   | chip         | baseline               | threshold |
  | 1     | file-01.ts | additions | 2    | Why change this line | +// changed file-01.ts | file-01.ts:2 | review-comment-chip | 98        |
