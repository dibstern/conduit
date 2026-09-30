Feature: Session transitions keep conversation context visible

Background:
  Given the conduit app is served with the connected mockup

Scenario: Sent message stays visible after the browser selects the first-send session
  When I type keep this message visible into the composer
  And I send the composer message
  And the mock relay replays the sent message for the selected session
  Then the transcript shows keep this message visible

Scenario: Subagent session shows its parent link
  When the mock relay replays a session family with a parent
  Then the subagent parent link is visible
