Feature: A tool row its run ended reads as ended by the run, not as failed

Scenario: A step the run ended is neutral, between a done step and a failed one
  Given the conduit app is served with the connected mockup
  And the viewport is a desktop
  And a session already exists on the Claude harness
  And the transcript has a turn whose run ended one of its steps
  When I open the turn's steps
  Then the "Watch the build" step reads "Ended by the run" and is not failed
  And the "List the files" step shows no run ending and is not failed
  And the "Run the tests" step shows no run ending and is failed
