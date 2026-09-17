Feature: Phone session bar

Scenario: The session owns the top bar on a phone
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  Then the session bar title is above the transcript
  And the global header is not rendered

Scenario: Back returns to the session list
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When I tap back to the session list
  Then the session list is open
