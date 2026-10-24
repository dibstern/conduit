Feature: Add a project by ticking its folders

Background:
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And the Add project dialog has folder suggestions
  And I open the Add project dialog

Scenario Outline: Ticking two folders keeps their rows and adds chips in tick order
  When I toggle the conduit folder row
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
  When I toggle the conduit folder row
  And I toggle the conduit folder row
  Then the conduit folder row is unticked
  And the project has no folder chips
  And no project has been saved from the dialog
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                    | threshold |
  | add-project-dialog-unticked | 98        |

Scenario Outline: Removing the main chip unticks its row and promotes the next folder
  When I toggle the conduit folder row
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
  When I toggle the conduit folder row
  And I toggle the api folder row
  And I make api the main project folder
  Then the project folder chips are api, conduit with api as Main
  And the screen region visually matches <baseline> at <threshold> percent
  When I save the Add project dialog
  Then one project is saved with folders api, conduit in that order

Examples:
  | baseline                       | threshold |
  | add-project-dialog-main-first | 98        |
