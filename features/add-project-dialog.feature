Feature: Add a project by ticking its folders

Background:
  Given the conduit app is served with the connected mockup
  And the Add project dialog has folder suggestions

Scenario Outline: Ticking two folders keeps their rows and adds chips in tick order
  Given the viewport is a desktop
  When I open the Add project dialog
  And I toggle the conduit folder row
  And I toggle the api folder row
  Then the project folder chips are conduit, api with conduit as Main
  And the conduit folder row is ticked
  And the api folder row is ticked
  And no project has been saved from the dialog
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                  | threshold |
  | add-project-dialog-ticked | 98        |

Scenario Outline: Toggling a ticked row removes its chip
  Given the viewport is a desktop
  When I open the Add project dialog
  And I toggle the conduit folder row
  And I toggle the conduit folder row
  Then the conduit folder row is unticked
  And the project has no folder chips
  And no project has been saved from the dialog
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                    | threshold |
  | add-project-dialog-unticked | 98        |

Scenario Outline: Removing the main chip unticks its row and promotes the next folder
  Given the viewport is a desktop
  When I open the Add project dialog
  And I toggle the conduit folder row
  And I toggle the api folder row
  And I remove the conduit project folder chip
  Then the conduit folder row is unticked
  And the api folder row is ticked
  And the project folder chips are api with api as Main
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                        | threshold |
  | add-project-dialog-chip-removed | 98        |

Scenario Outline: Saving creates one project with all ticked folders and main first
  Given the viewport is a desktop
  When I open the Add project dialog
  And I toggle the conduit folder row
  And I toggle the api folder row
  And I make api the main project folder
  Then the project folder chips are api, conduit with api as Main
  And the screen region visually matches <baseline> at <threshold> percent
  When I save the Add project dialog
  Then one project is saved with folders api, conduit in that order

Examples:
  | baseline                       | threshold |
  | add-project-dialog-main-first | 98        |

Scenario Outline: Desktop path browsing shows breadcrumbs and selects folders into the same chips
  Given the viewport is a desktop
  When I open the Add project dialog
  And I type "~/src/" in the Add project folder search
  Then the folder breadcrumbs are ~, src
  And the folder rows are api, conduit, docs, personal
  And the conduit folder row shows "git · main"
  And the personal folder row shows "2 repos"
  And the folder keyboard hints are visible
  When I toggle the conduit folder row
  Then the conduit folder row is ticked
  And the project folder chips are conduit with conduit as Main
  And no project has been saved from the dialog
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                          | threshold |
  | add-project-dialog-browse-desktop | 98        |

Scenario Outline: Desktop completes a unique path with Tab and returns through a breadcrumb
  Given the viewport is a desktop
  When I open the Add project dialog
  And I type "~/src/per" in the Add project folder search
  Then the folder ghost suffix is "sonal/"
  And the folder search is "~/src/per"
  And the screen region visually matches <ghost_baseline> at <threshold> percent
  When I accept the folder ghost with Tab
  Then the folder search is "~/src/personal/"
  And the folder breadcrumbs are ~, src, personal
  And the folder rows are personal/gym, personal/site
  When I click the src folder breadcrumb
  Then the folder search is "~/src/"
  And the folder breadcrumbs are ~, src
  And the folder rows are api, conduit, docs, personal
  And the screen region visually matches <up_baseline> at <threshold> percent

Examples:
  | ghost_baseline                 | up_baseline                       | threshold |
  | add-project-dialog-browse-ghost | add-project-dialog-browse-crumb-up | 98        |

Scenario Outline: Phone browse buttons open folders and breadcrumbs return without keyboard hints
  Given the viewport is a phone
  When I open the Add project dialog
  Then the Add project dialog is a phone sheet with a handle
  When I tap the conduit folder browse button
  Then the folder search is "~/src/conduit/"
  And the folder breadcrumbs are ~, src, conduit
  And the folder rows are conduit/lib
  And the folder keyboard hints are hidden
  And the screen region visually matches <open_baseline> at <threshold> percent
  When I tap the src folder breadcrumb
  Then the folder search is "~/src/"
  And the folder breadcrumbs are ~, src
  And the folder rows are api, conduit, docs, personal
  And the conduit folder row shows "git · main"
  And the personal folder row shows "2 repos"
  And the folder keyboard hints are hidden
  And the screen region visually matches <up_baseline> at <threshold> percent

Examples:
  | open_baseline                        | up_baseline                        | threshold |
  | add-project-dialog-browse-phone-open | add-project-dialog-browse-phone-up | 98        |

Scenario Outline: Phone opens an inset sheet with a handle
  Given the viewport is a phone
  When I open the Add project dialog
  Then the Add project dialog is a phone sheet with a handle
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                       | threshold |
  | add-project-dialog-phone-sheet | 98        |

Scenario Outline: Tapping the phone scrim returns focus to the opener
  Given the viewport is a phone
  When I open the Add project dialog
  And I tap the Add project sheet scrim
  Then the Add project dialog is closed and focus returns to its opener
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                           | threshold |
  | add-project-dialog-phone-dismissed | 98        |

Scenario Outline: Phone folder chips and Add project stay pinned after scrolling
  Given the viewport is a phone
  And the Add project folder list is long enough to scroll
  When I open the Add project dialog
  And I toggle the conduit folder row
  And I toggle the api folder row
  And I scroll the Add project folder list to the bottom
  Then the project folder chips are conduit, api with conduit as Main
  And the Add project sheet footer is visible above the folder list
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                        | threshold |
  | add-project-dialog-phone-footer | 98        |
