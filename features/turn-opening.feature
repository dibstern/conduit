
Feature: A turn waits quietly until its first step

Scenario Outline: A sent prompt with no events shows Sending immediately
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent <send_seconds> seconds ago
  Then the turn opening reads Sending… without a card or timer
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | send_seconds | baseline             | threshold |
  | 5            | turn-opening-sending | 98        |

Scenario Outline: The first ordinary step replaces Sending and counts time from send
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent <send_seconds> seconds ago
  Then the turn opening reads Sending… without a card or timer
  When the first ordinary turn opening step arrives
  Then the turn opening is replaced by a Working card timed <elapsed>
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | send_seconds | elapsed | baseline             | threshold |
  | 5            | 5s      | turn-opening-working | 98        |

Scenario Outline: Replacing the pulse keeps the prompt and head in place
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  Then the turn opening reads Sending… without a card or timer
  When I record the turn opening prompt and head positions
  And the first ordinary turn opening step arrives
  Then the turn opening is replaced by a Working card timed 5s
  And the turn opening prompt bounding box is unchanged
  And the assistant name row occupies the opening row

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: The opening pulse stays still under reduced motion
  Given the conduit app is served with the connected mockup
  And reduced motion is enabled for the turn opening
  And the turn opening prompt was sent 5 seconds ago
  Then the turn opening reads Sending… without a card or timer
  And the turn opening has no running animation

Scenario: A notice before the first step changes the opening to Working
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent 5 seconds ago
  When a retry notice arrives before the first step
  Then the turn opening reads Working without a card or timer
  And the retry notice follows the turn opening

Scenario Outline: Compaction before the first step is a live rule
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | turn-opening-compacting         | 98        |
  | phone    | turn-opening-compacting         | 98        |

Scenario Outline: Failed opening compaction leaves only the error notice
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  When the turn opening compaction fails
  Then the opening compaction leaves only its error notice
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | turn-opening-compaction-failed  | 98        |
  | phone    | turn-opening-compaction-failed  | 98        |

Scenario Outline: Stopping opening compaction leaves no rule behind
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  When I stop the turn during its opening compaction
  Then the stopped opening compaction leaves no rule or notice
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | turn-opening-compaction-stopped | 98        |
  | phone    | turn-opening-compaction-stopped | 98        |

Scenario: A compacting row before the turn is live never flashes a plain notice
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent 5 seconds ago but the turn is not live
  When I watch for a plain opening compaction notice
  And a compacting row arrives before the turn is live
  Then the turn opening shows Compacting context without a status message, card or timer
  When the turn opening session becomes busy
  Then the turn opening shows Compacting context without a status message, card or timer
  And the plain opening compaction notice never appeared

Scenario: Mid-turn compaction stays a status message
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent 5 seconds ago
  When the first ordinary turn opening step arrives
  Then the turn opening is replaced by a Working card timed 5s
  When the turn opening session starts compacting
  Then the mid-turn compaction is a status message
  And the turn opening is replaced by a Working card timed 5s

Scenario: The live compaction rule stays still under reduced motion
  Given the conduit app is served with the connected mockup
  And reduced motion is enabled for the turn opening
  And the turn opening prompt was sent 5 seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  And the turn opening has no running animation

Scenario Outline: An opening compaction settles in place and returns to Working
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent <send_seconds> seconds ago
  When the turn opening session starts compacting
  Then the turn opening shows Compacting context without a status message, card or timer
  When I record the turn opening prompt and live compaction rule positions
  And the turn opening compaction completes <completion_seconds> seconds after send with <before_tokens> tokens before and <after_tokens> tokens after
  Then the settled turn opening rule shows <before_display> → <after_display> and <saved_display> saved
  And the turn opening reads Working without a card or timer
  And the settled turn opening rules precede the Working opening
  And the settled turn opening rule occupies the live rule's box
  And the turn opening prompt bounding box is unchanged
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | send_seconds | completion_seconds | before_tokens | after_tokens | before_display | after_display | saved_display | baseline                       | threshold |
  | desktop  | 45           | 40                 | 180000        | 42000        | 180k           | 42k           | 138k          | turn-opening-compacted-working | 98        |
  | phone    | 45           | 40                 | 180000        | 42000        | 180k           | 42k           | 138k          | turn-opening-compacted-working | 98        |

Scenario Outline: Work after opening compaction excludes it from the ledger and timer
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent <send_seconds> seconds ago
  When the turn opening compaction completes <completion_seconds> seconds after send with <before_tokens> tokens before and <after_tokens> tokens after
  And the first ordinary turn opening step arrives <step_seconds> seconds after send
  Then the turn opening is replaced by a Working card timed <elapsed>
  And the settled turn opening rule shows <before_display> → <after_display> and <saved_display> saved
  And the settled turn opening rules precede the Working card
  And the turn opening ledger has no compaction seam or rule
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | send_seconds | completion_seconds | step_seconds | before_tokens | after_tokens | before_display | after_display | saved_display | elapsed | baseline                          | threshold |
  | desktop  | 45           | 40                 | 41           | 180000        | 42000        | 180k           | 42k           | 138k          | 5s      | turn-opening-compacted-first-step | 98        |
  | phone    | 45           | 40                 | 41           | 180000        | 42000        | 180k           | 42k           | 138k          | 5s      | turn-opening-compacted-first-step | 98        |

Scenario Outline: Two opening compactions retain their order and time starts after the last
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent <send_seconds> seconds ago
  When the turn opening compaction completes <first_seconds> seconds after send with <before_tokens> tokens before and <middle_tokens> tokens after
  Then the turn opening reads Working without a card or timer
  When the turn opening compaction completes <last_seconds> seconds after send with <middle_tokens> tokens before and <after_tokens> tokens after
  Then the turn preface lists <rule_count> rules saving <first_saved> then <last_saved>
  And the turn opening reads Working without a card or timer
  When the first ordinary turn opening step arrives <step_seconds> seconds after send
  Then the turn opening is replaced by a Working card timed <elapsed>
  And the settled turn opening rules precede the Working card
  And the turn opening ledger has no compaction seam or rule

Examples:
  | send_seconds | first_seconds | last_seconds | step_seconds | before_tokens | middle_tokens | after_tokens | rule_count | first_saved | last_saved | elapsed |
  | 45           | 20            | 40           | 41           | 180000        | 42000         | 14000        | 2          | 138k        | 28k        | 5s      |

Scenario Outline: Server timing and compaction both bound the working clock
  Given the conduit app is served with the connected mockup
  And the turn opening prompt was sent <send_seconds> seconds ago
  And the turn opening server timing starts <start_seconds> seconds after send
  When the turn opening compaction completes <completion_seconds> seconds after send with <before_tokens> tokens before and <after_tokens> tokens after
  And the first ordinary turn opening step arrives <step_seconds> seconds after send
  Then the turn opening is replaced by a Working card timed <elapsed>

Examples:
  | send_seconds | start_seconds | completion_seconds | step_seconds | before_tokens | after_tokens | elapsed |
  | 45           | 30            | 40                 | 44           | 180000        | 42000        | 5s      |
  | 45           | 43            | 40                 | 44           | 180000        | 42000        | 2s      |

Scenario Outline: Reload preserves the preface and excludes compaction from Worked time
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent <send_seconds> seconds ago
  And the turn opening server timing starts <start_seconds> seconds after send
  When the turn opening compaction completes <completion_seconds> seconds after send with <before_tokens> tokens before and <after_tokens> tokens after
  And the first ordinary turn opening step arrives <step_seconds> seconds after send
  And the turn opening finishes <finish_seconds> seconds after send and I reload it
  Then the reloaded turn opening has a Worked card timed <duration>
  And the settled turn opening rule shows <before_display> → <after_display> and <saved_display> saved
  And the settled turn opening rules precede the Worked card
  And the turn opening ledger has no compaction seam or rule
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | send_seconds | start_seconds | completion_seconds | step_seconds | finish_seconds | before_tokens | after_tokens | before_display | after_display | saved_display | duration | baseline                      | threshold |
  | desktop  | 45           | 0             | 40                 | 41           | 44             | 180000        | 42000        | 180k           | 42k           | 138k          | 4s       | turn-opening-compacted-reload | 98        |
  | phone    | 45           | 0             | 40                 | 41           | 44             | 180000        | 42000        | 180k           | 42k           | 138k          | 4s       | turn-opening-compacted-reload | 98        |

Scenario Outline: A completed mid-turn compaction stays in the ledger
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the turn opening prompt was sent <send_seconds> seconds ago
  When the first ordinary turn opening step arrives <step_seconds> seconds after send
  And the turn opening compaction completes <completion_seconds> seconds after send with <before_tokens> tokens before and <after_tokens> tokens after
  Then the turn opening is replaced by a Working card timed <elapsed>
  And the turn opening ledger contains <compaction_count> compaction
  And the messages region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | send_seconds | step_seconds | completion_seconds | before_tokens | after_tokens | compaction_count | elapsed | baseline                        | threshold |
  | desktop  | 45           | 1            | 40                 | 180000        | 42000        | 1                | 45s     | turn-opening-midturn-compaction | 98        |
  | phone    | 45           | 1            | 40                 | 180000        | 42000        | 1                | 45s     | turn-opening-midturn-compaction | 98        |

Scenario: A busy session with no transcript rows still shows Sending
  Given the conduit app is served with the connected mockup
  And the turn opening session is busy with no transcript rows
  Then the turn opening reads Sending… without a card or timer

Scenario: A first send waiting for the transcript still shows Sending
  Given the transcript feed will hold
  And the conduit app is served with the connected mockup
  And the composer picker has the OpenCode catalog
  And session creation takes 400 ms
  When I send Hello from a draft from the composer, watching the transcript for 1200 ms
  Then the sent message showed within 100 ms and stayed, with no loading skeleton
  And the turn opening reads Sending… without a card or timer
  When the draft turn opening is reported busy
  And the server places the sent message in the new session
  Then the transcript shows the sent message exactly once
  And the turn opening reads Sending… without a card or timer
