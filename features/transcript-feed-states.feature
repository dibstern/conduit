Feature: The transcript shows how current it is while its feed connects

Scenario Outline: A session with nothing cached shows a skeleton until its feed arrives
  Given the transcript feed will hold
  And the conduit app is served with the matching-model mockup
  Then the transcript shows a loading skeleton
  And the beginning of session marker is not shown
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                | threshold |
  | transcript-feed-cold    | 98        |

Scenario Outline: A transcript that is still catching up is shown but not interactive
  Given the transcript feed will stall
  And the conduit app is served with the matching-model mockup
  Then the transcript feed pill reads Catching up
  And the transcript controls are inert
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | baseline                     | threshold |
  | transcript-feed-catching-up  | 98        |

Scenario Outline: A synchronized transcript is live
  Given the transcript feed will synchronize
  And the conduit app is served with the matching-model mockup
  Then the transcript is live
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | baseline             | threshold |
  | transcript-feed-live | 98        |

Scenario Outline: A failing feed offers Retry, which reconnects immediately
  Given the transcript feed will fail
  And the conduit app is served with the matching-model mockup
  Then the transcript feed pill reads Couldn't refresh
  And the messages region visually matches <baseline> at <threshold> percent
  When I press Retry on the transcript
  Then the transcript is live

Examples:
  | baseline                | threshold |
  | transcript-feed-failing | 98        |

Scenario Outline: A new session's first send shows at once, never under a skeleton
  Given the transcript feed will hold
  And the conduit app is served with the connected mockup
  And the composer picker has the OpenCode catalog
  And session creation takes <createMs> ms
  When I send <message> from the composer, watching the transcript for <watchMs> ms
  Then the sent message showed within <shownWithinMs> ms and stayed, with no loading skeleton
  When the server places the sent message in the new session
  Then the transcript shows the sent message exactly once
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | createMs | message            | watchMs | shownWithinMs | baseline                   | threshold |
  | 400      | Hello from a draft | 1200    | 100           | transcript-feed-first-send | 98        |
