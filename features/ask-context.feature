Feature: An Ask brings back the agent's setup and explains options on request

Scenario Outline: Reply actions append an Ask reference to the draft without sending
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Ask context uses the dark theme with summaries on
  And the Ask session has a setup
  When I type My existing draft into the composer
  And I choose the Ask action <action>
  Then the composer contains the Ask reply <reference> followed by <prose> without sending

Examples:
  | viewport | action          | reference          | prose                                  |
  | desktop  | Reply           | Re #2 (Ask, 00:17) | My existing draft                      |
  | phone    | Reply           | Re #2 (Ask, 00:17) | My existing draft                      |
  | desktop  | Reply with this | Re #2 (Ask, 00:17) | My existing draft \n\nKeep the new look |
  | phone    | Reply with this | Re #2 (Ask, 00:17) | My existing draft \n\nKeep the new look |
  | desktop  | Something else  | Re #2 (Ask, 00:17) | My existing draft                      |
  | phone    | Something else  | Re #2 (Ask, 00:17) | My existing draft                      |

Scenario Outline: The agent's own setup is instant and jumps below the chosen level
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Ask context uses the <theme> theme with summaries on
  And the Ask session has a setup
  Then the Ask quotes the preceding setup with Explain options and Reply
  And the messages region visually matches ask-setup-<viewport>-<theme> at <threshold> percent
  When I jump to the Ask setup
  Then the quoted setup opens below the chosen surfacing level

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: Explain uses one paid request and citations jump to their messages
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Ask context uses the <theme> theme with summaries on
  And the Ask session has a setup
  When I explain the Ask options
  Then the Ask explains So far and What came up with cited options
  And the messages region visually matches ask-explained-<viewport>-<theme> at <threshold> percent
  When I follow Ask citation #1
  Then the quoted setup opens below the chosen surfacing level
  When I return to the Ask
  Then the same Ask explanation is retained without another call

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: With no setup Explain is the primary action
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Ask context uses the <theme> theme with summaries on
  And the Ask session has no setup
  Then the Ask has no setup and Explain options is primary
  And the messages region visually matches ask-no-setup-<viewport>-<theme> at <threshold> percent
  When I explain the Ask options
  Then the same Ask explanation is retained without another call

Examples:
  | viewport | theme | threshold |
  | desktop  | dark  | 98        |
  | desktop  | light | 98        |
  | phone    | dark  | 98        |
  | phone    | light | 98        |

Scenario Outline: A failed explanation preserves the question and can be retried
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Ask context uses the <theme> theme with summaries on
  And the Ask session has a failing explanation
  When I explain the Ask options
  Then the Ask keeps its setup and offers an explanation retry
  When I explain the Ask options
  Then the Ask explains So far and What came up with cited options after a retry

Examples:
  | viewport | theme |
  | desktop  | dark  |
  | phone    | light |

Scenario Outline: Summary Off keeps the free quote and prevents a paid call
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And Ask context uses the <theme> theme with summaries off
  And the Ask session has a setup
  Then the Ask keeps its quote while explaining is disabled

Examples:
  | viewport | theme |
  | desktop  | light |
  | phone    | dark  |
