Feature: Turn summaries keep cached versions and cite the original messages

Scenario Outline: A settled turn opens its newest cached summary without generating
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  Then the newest cached summary is the settled default
  When I open the turn summary
  Then recap version 2 of 2 says The routing review is complete.
  And no recap generation was requested
  When I reload the surfacing session
  And I open the turn summary
  Then recap version 2 of 2 says The routing review is complete.
  And no recap generation was requested
  And the screen region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | surfacing-recap-cached-desktop   | 98        |
  | phone    | surfacing-recap-cached-phone     | 98        |

Scenario Outline: Automatic cached summaries arrive live and preserve an older selected version
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with automatic summaries
  When I open the turn summary
  Then recap version 1 of 1 says The earlier review found a routing decision.
  When a completed-turn recap arrives from the server
  Then recap version 2 of 2 says The later review found a blocker.
  And the recap arrived without reloading or listing again
  And no recap generation was requested
  When I select the previous summary
  And a completed-turn recap arrives from the server
  Then recap version 1 of 3 says The earlier review found a routing decision.
  And the recap arrived without reloading or listing again
  And no recap generation was requested
  When I select the next summary
  And I select the next summary
  Then recap version 3 of 3 says The newer messages identify the remaining risk.

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Automatic generation and SDK failures arrive without a browser request
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with automatic summaries
  When I open the turn summary
  And the server recap is generating
  Then the summary indicates server generation
  And recap version 1 of 1 says The earlier review found a routing decision.
  And no recap generation was requested
  When the server recap is failed
  Then the summary failure offers Retry and the SDK sign-in error
  And recap version 1 of 1 says The earlier review found a routing decision.
  And the recap arrived without reloading or listing again
  And no recap generation was requested

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: On request creates a summary only after Summarize
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a live turn with no summaries
  Then the turn offers Summary without a summary
  And no recap generation was requested
  When I open the turn summary
  Then the empty summary offers Summarize and its settings
  And no recap generation was requested
  When I request the turn summary
  Then recap version 1 of 1 says The routing review is complete.
  And recap generation scopes are whole

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Summary settings patch only the selected model and timing
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I open summary settings
  Then the summary settings name their model and timing
  When I choose summary setting Opus
  Then the summary setting patch is model opus
  When I open summary settings
  And I choose summary setting When a turn ends
  Then the summary setting patch is when turn-end
  And no recap generation was requested

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Stale summaries append New versions and keep older versions
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with stale summaries
  When I open the turn summary
  Then the summary offers 4 new messages and Whole turn
  And the screen region visually matches <baseline> at <threshold> percent
  When I summarize the new messages
  Then recap version 2 of 2 says The newer messages identify the remaining risk.
  And recap generation scopes are new
  When I select the previous summary
  Then recap version 1 of 2 says The earlier review found a routing decision.
  When I select the next summary
  Then recap version 2 of 2 says The newer messages identify the remaining risk.
  When I regenerate the selected summary
  Then recap version 3 of 3 says The newer messages identify the remaining risk.
  And recap generation scopes are new,new
  And the regenerated summary names source version 2

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | surfacing-recap-stale-desktop    | 98        |
  | phone    | surfacing-recap-stale-phone      | 98        |

Scenario Outline: Whole turn again appends a fresh version without replacing earlier summaries
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with stale summaries
  When I open the turn summary
  And I summarize the whole turn again
  Then recap version 2 of 2 says The routing review is complete.
  And recap generation scopes are whole
  When I regenerate the selected summary
  Then recap version 3 of 3 says The routing review is complete.
  And recap generation scopes are whole,whole
  When I select the previous summary
  And I select the previous summary
  Then recap version 1 of 3 says The earlier review found a routing decision.

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A citation opens in the summary reader without moving the transcript
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I follow recap citation #3
  Then the cited summary remains open
  And recap citation #3 is readable below Balanced without moving the transcript
  And the effective surfacing level is Balanced
  And the screen region visually matches <baseline> at <threshold> percent
  When I close the cited message
  Then recap citation #3 is followed

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | surfacing-recap-cited-desktop    | 98        |
  | phone    | surfacing-recap-cited-phone      | 98        |
  | duo      | surfacing-recap-cited-duo        | 98        |

Scenario Outline: A failed summary retains the SDK error and retries on request
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a live turn with failing summaries
  When I request the turn summary
  Then the summary failure offers Retry and the SDK sign-in error
  And the screen region visually matches <baseline> at <threshold> percent
  When I retry the failed summary
  Then recap version 1 of 1 says The routing review is complete.
  And recap generation scopes are whole,whole

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | surfacing-recap-failed-desktop   | 98        |
  | phone    | surfacing-recap-failed-phone     | 98        |

Scenario Outline: Summary model Off hides summary controls and never generates
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with disabled summaries
  Then the turn has no summary controls
  And no recap generation was requested

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Shared recap preferences replace an earlier local setting
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I open summary settings
  And I choose summary setting Off
  Then the turn has no summary controls
  When another device enables Sonnet summaries and preferences refresh
  And I open the turn summary
  Then the summary model is Sonnet
  And no recap generation was requested

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: The focused turn toggles its summary with the s shortcut
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I toggle the focused turn summary with s
  Then the summary body is closed
  When I toggle the focused turn summary with s
  Then recap version 2 of 2 says The routing review is complete.

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: The phone summary is a bottom sheet with a dismissible scrim
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a phone
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  Then the phone summary has a bottom sheet and padded citations
  When I dismiss the summary with its scrim
  Then the summary body is closed

Scenario Outline: A pending automatic recap settles after the next turn starts
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with automatic summaries
  When I open the turn summary
  And the server recap is generating
  Then the summary indicates server generation
  When the next turn starts before the recap settles
  And I open the turn summary
  Then the summary indicates server generation
  When a completed-turn recap arrives from the server
  Then recap version 2 of 2 says The later review found a blocker.
  And the summary has finished generating
  And the recap arrived without reloading or listing again
  And no recap generation was requested

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A recap pending on the server is observed when its turn becomes older
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with automatic summaries
  When I open the turn summary
  And the next turn starts while its recap is pending on the server
  And I open the turn summary
  Then the summary indicates server generation
  When a completed-turn recap arrives from the server
  Then recap version 2 of 2 says The later review found a blocker.
  And the summary has finished generating
  And the recap arrived without reloading or listing again
  And no recap generation was requested

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Escape closes the summary before changing the selected transcript card
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I select a transcript card and open its summary
  And I dismiss the summary with Escape
  Then the summary body is closed
  And the selected transcript card is unchanged

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: The summary foot marks the remaining surfaced messages read
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries and messages 1,4,8 read
  When I open the turn summary
  Then the summary foot offers Mark <unread> read
  And the screen region visually matches <baseline> at <threshold> percent
  When I mark <unread> surfaced messages read
  Then surfacing read RPC 1 marks only messages <ordinals> read

Examples:
  | viewport | unread | ordinals | baseline                          | threshold |
  | desktop  | 2      | 2,5      | surfacing-recap-mark-read-desktop | 98        |
  | phone    | 2      | 2,5      | surfacing-recap-mark-read-phone   | 98        |
