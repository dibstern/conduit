Feature: New terminals carry the composer's account

Background:
  Given the conduit app is served with the connected mockup
  And the configured Claude accounts are Claude and Personal with default Personal
  And new drafts use a Claude model

Scenario: a draft terminal uses the default account
  When I start a new session
  And I open a new terminal tab
  Then the terminal create request carries the Personal account for a draft

Scenario: a draft terminal uses an explicit account pick
  When I start a new session
  And I open the model picker
  And I select the claude Account card
  And I close the model picker
  And I open a new terminal tab
  Then the terminal create request carries the Claude account for a draft

Scenario: a resumed terminal uses the server's latest effective account
  Given a deleted-account session is published on Personal
  When I view the deleted-account session
  And the deleted-account session is published on Claude after a default change
  And I open a new terminal tab
  Then the terminal create request carries the Claude account for the viewed session

Scenario: another terminal tab uses the resumed session's updated account
  Given a deleted-account session is published on Personal
  When I view the deleted-account session
  And I open a new terminal tab
  Then the terminal create request carries the Personal account for the viewed session
  When the deleted-account session is published on Claude after a default change
  And I add another terminal tab
  Then the terminal create request carries the Claude account for the viewed session

Scenario: a terminal without a session leaves the default to the server
  When I return to the session list for a terminal
  And I open a new terminal tab
  Then the terminal create request leaves the account and session unspecified
