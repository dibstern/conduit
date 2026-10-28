Feature: Turn activity reads as a chronological log

Scenario Outline: Two skills appear where they happened with their own time column
  Given message surfacing is <jev> at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has two skills in a settled turn
  When I open the plain turn log
  Then the log shows both skills in order with sparkles, Skill, coloured names and times
  And the messages region visually matches turn-log-skills-settled-<jev>-<viewport> at 98 percent

Examples:
  | viewport | jev      |
  | desktop  | active   |
  | phone    | active   |
  | desktop  | inactive |
  | phone    | inactive |

Scenario Outline: Skills need no picker in a live or settled turn
  Given message surfacing is <jev> at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn log has two skills in a <phase> turn
  Then skill events have no separate picker or chapter list
  When I open the plain turn log
  Then skill events have no separate picker or chapter list
  And the turn head counts 2 skills
  And the activity strip keeps every step at full strength
  And the log shows both skills in order with sparkles, Skill, coloured names and times
  And the messages region visually matches turn-log-skills-<phase>-<jev>-<viewport> at 98 percent

Examples:
  | viewport | jev      | phase   |
  | desktop  | active   | settled |
  | phone    | active   | settled |
  | desktop  | inactive | settled |
  | phone    | inactive | settled |
  | desktop  | active   | live    |
  | phone    | active   | live    |
  | desktop  | inactive | live    |
  | phone    | inactive | live    |
