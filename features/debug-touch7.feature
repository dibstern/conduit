Feature: DEBUG touch7 bar direction by touch

Scenario: A slow short swipe towards older from the bottom expands the bar
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When DEBUG I swipe the transcript towards older by 400 pixels
  And DEBUG I swipe the transcript towards newer by 3000 pixels
  Then the session bar is collapsed
  When DEBUG I swipe the transcript towards older by 120 pixels at speed 150
  Then the session bar is expanded

Scenario: A tiny swipe towards older from the bottom expands the bar
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When DEBUG I swipe the transcript towards older by 400 pixels
  And DEBUG I swipe the transcript towards newer by 3000 pixels
  Then the session bar is collapsed
  When DEBUG I swipe the transcript towards older by 40 pixels at speed 100
  Then the session bar is expanded

Scenario: A slow swipe towards newer mid-transcript collapses the bar
  Given the viewport is a phone
  And the conduit app is served with the long-transcript mockup
  When DEBUG I swipe the transcript towards older by 800 pixels
  Then the session bar is expanded
  When DEBUG I swipe the transcript towards newer by 80 pixels at speed 150
  Then the session bar is collapsed
