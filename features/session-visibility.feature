Feature: Session transitions keep conversation context visible

Background:
  Given the conduit app is served with the connected mockup

Scenario: Sent message stays visible when the relay switches session on first send
  When I type keep this message visible into the composer
  And I send the composer message
  And the mock relay replays the sent message in a new session
  Then the transcript shows keep this message visible

Scenario: Subagent session shows its parent link
  When the mock relay replays a session switch with parentID
  Then the subagent parent link is visible
