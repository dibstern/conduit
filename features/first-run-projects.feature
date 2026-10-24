Feature: Add recently used repositories on first run

Background:
  Given the conduit app is served with the connected mockup
  And first-run project suggestions are available

Scenario Outline: Desktop lists recently used repositories with the newest three ticked
  Given the viewport is a desktop
  When I open the app without projects
  Then the first-run repositories are conduit, api, notes, docs in that order
  And the first-run conduit repository shows "2h ago"
  And the first-run api repository shows "yesterday"
  And the first-run notes repository shows "3d ago"
  And the first-run ticked repositories are conduit, api, notes
  And the first-run Add button says "Add 3 projects" and is enabled
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                   | threshold |
  | first-run-projects-desktop | 98        |

Scenario Outline: Unticking repositories updates the count and disables adding at zero
  Given the viewport is a desktop
  When I open the app without projects
  And I toggle the first-run conduit repository
  Then the first-run Add button says "Add 2 projects" and is enabled
  When I toggle the first-run api repository
  Then the first-run Add button says "Add 1 project" and is enabled
  When I toggle the first-run notes repository
  Then the first-run ticked repositories are empty
  And the first-run Add button says "Add 0 projects" and is disabled
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                 | threshold |
  | first-run-projects-empty | 98        |

Scenario Outline: Adding saves each repository in order and waits for the entire batch
  Given the viewport is a desktop
  And first-run project saves pause after the first project
  When I open the app without projects
  And I click the first-run Add button
  Then first run remains open while the remaining projects wait
  And the screen region visually matches <baseline> at <threshold> percent
  When the remaining first-run project saves complete
  Then first-run projects were saved as conduit, api, notes in that order
  And the normal app replaces first run
  When all first-run projects are removed later
  Then the normal app replaces first run

Examples:
  | baseline                  | threshold |
  | first-run-projects-saving | 98        |

Scenario Outline: Browsing joins a picked folder to the same ticked repositories
  Given the viewport is a desktop
  When I open the app without projects
  And I find another first-run folder
  Then the first-run folder search starts at home without new-folder actions
  When I pick personal-site for first run
  Then the first-run repositories are conduit, api, notes, docs, personal-site in that order
  And the first-run ticked repositories are conduit, api, notes, personal-site
  And the first-run Add button says "Add 4 projects" and is enabled
  And no first-run project has been saved
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | first-run-projects-browse | 98        |

Scenario Outline: A rejected save stays ticked with its error while later saves continue
  Given the viewport is a desktop
  And saving the first-run api repository is rejected
  When I open the app without projects
  And I click the first-run Add button
  Then first-run projects were saved as conduit, api, notes in that order
  And the first-run repositories are api in that order
  And the first-run ticked repositories are api
  And the first-run api repository shows "/Users/dev/src/api no longer exists."
  And the first-run Add button says "Add 1 project" and is enabled
  And the screen region visually matches <baseline> at <threshold> percent
  When I toggle the first-run api repository
  Then the first-run Add button says "Continue" and is enabled
  When I click the first-run Add button
  Then the normal app replaces first run

Examples:
  | baseline                   | threshold |
  | first-run-projects-failure | 98        |

Scenario Outline: Phone shows compact times and full-width actions and adds projects by tap
  Given the viewport is a phone
  When I open the app without projects
  Then the first-run repositories are conduit, api, notes, docs in that order
  And the first-run conduit repository shows "2h"
  And the first-run api repository shows "1d"
  And the first-run notes repository shows "3d"
  And first-run phone rows and actions match the approved layout
  And the screen region visually matches <baseline> at <threshold> percent
  When I tap the first-run Add button
  Then first-run projects were saved as conduit, api, notes in that order
  And the normal app replaces first run

Examples:
  | baseline                 | threshold |
  | first-run-projects-phone | 98        |
