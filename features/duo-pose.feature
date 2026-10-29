Feature: Conduit recognises the iPhone Duo's pose in the installed app

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: Each measured Duo pose marks the layout
  When the viewport is a duo <pose>
  Then the layout pose is <marker>
  And the layout is <layout>

Examples:
  | pose               | marker                 | layout  |
  | folded portrait    | duo-folded-portrait    | compact |
  | folded landscape   | duo-folded-landscape   | compact |
  | unfolded landscape | duo-unfolded-landscape | wide    |
  | unfolded portrait  | duo-unfolded-portrait  | compact |

Scenario Outline: Look-alikes keep today's layout
  When the viewport is <viewport>
  Then the layout pose is <marker>
  And the layout is <layout>

Examples:
  | viewport                                           | marker  | layout  |
  | a duo folded portrait in a Safari tab              | phone   | compact |
  | a duo unfolded landscape in a Safari tab           | desktop | wide    |
  | an installed landscape iPhone with 59pt side insets | desktop | wide    |

Scenario: The pose follows folding and rotation but not the keyboard
  When the viewport is a duo folded portrait
  Then the layout pose is duo-folded-portrait
  When the keyboard opens, taking 300 pixels of the visual viewport
  Then the layout pose is duo-folded-portrait
  When the viewport is a duo folded landscape
  Then the layout pose is duo-folded-landscape
  When the viewport is a duo unfolded landscape
  Then the layout pose is duo-unfolded-landscape
  When the viewport is a duo unfolded portrait
  Then the layout pose is duo-unfolded-portrait
