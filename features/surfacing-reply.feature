Feature: Reply references remain atomic in drafts and become plain text for the agent

Scenario Outline: A message reply previews and sends its number category time and text
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I pick surfaced message #2
  And I reply to the surfaced message with <source>
  Then the composer has 1 reply token named #2 Ask
  When I append Keep the old paint order. after the reply
  Then the reply preview is Re #2 (Ask, 00:17): "Recapture the phone baseline, or keep the old paint order?"\n\nKeep the old paint order.
  And the composer region visually matches <baseline> at <threshold> percent
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport | source | baseline                          | threshold |
  | desktop  | Reply  | surfacing-reply-message-desktop    | 98        |
  | phone    | Reply  | surfacing-reply-message-phone      | 98        |
  | desktop  | r      | surfacing-reply-keyboard-desktop   | 98        |
  | phone    | r      | surfacing-reply-keyboard-phone     | 98        |

Scenario Outline: Reply stays pressed while the draft replies to its message and a second press takes the reply out
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I pick surfaced message #2
  Then the surfaced message's Reply is not pressed
  When I reply to the surfaced message with <source>
  And I append Keep the old paint order. after the reply
  Then the surfaced message's Reply is pressed
  When I reply to the surfaced message with <source>
  Then the composer has no reply tokens
  And the surfaced message's Reply is not pressed
  When I undo the composer edit
  Then the composer has 1 reply token named #2 Ask
  And the surfaced message's Reply is pressed

Examples:
  | viewport | source |
  | desktop  | Reply  |
  | phone    | Reply  |
  | desktop  | r      |

Scenario Outline: A selected excerpt clips its chip while sending every selected character
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I pick surfaced message #2
  And I select the surfaced words Recapture the phone baseline, or keep the old paint order?
  Then the selection offers a native-selection-safe reply on <viewport>
  When I reply to the surfaced selection
  Then the composer has 1 reply token named #2
  And the reply excerpt chip clips Recapture the phone baseline, or keep the old paint order? to 24 characters
  And the reply preview is Re #2 (Ask, 00:17): "Recapture the phone baseline, or keep the old paint order?"
  And the composer region visually matches <baseline> at <threshold> percent
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport | baseline                         | threshold |
  | desktop  | surfacing-reply-excerpt-desktop   | 98        |
  | phone    | surfacing-reply-excerpt-phone     | 98        |

Scenario Outline: Reply on a recap citation inserts the cited message as a token
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I follow recap citation #2
  Then the cited message's Reply is not pressed
  When I reply to the cited message
  Then the composer has 1 reply token named #2 Ask
  And the composer has focus
  And the cited message is closed
  And the composer region visually matches <baseline> at <threshold> percent
  When I append Keep the old paint order. after the reply
  Then the reply preview is Re #2 (Ask, 00:17): "Recapture the phone baseline, or keep the old paint order?"\n\nKeep the old paint order.
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport | baseline                           | threshold |
  | desktop  | surfacing-reply-recap-cite-desktop | 98        |
  | phone    | surfacing-reply-recap-cite-phone   | 98        |

Scenario Outline: The cited message's Reply stays pressed while the draft replies to it
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I follow recap citation #2
  And I reply to the cited message
  Then the composer has 1 reply token named #2 Ask
  And the composer has focus
  When I open the turn summary
  And I follow recap citation #2
  Then the cited message's Reply is pressed
  When I reply to the cited message
  Then the composer has no reply tokens
  And the cited message's Reply is not pressed

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Words selected in the turn summary become a recap excerpt
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I open the turn summary
  And I quote the recap words The routing review is complete.
  Then the composer has 1 reply token named Recap
  And the composer has focus
  And the summary is closed only on a phone
  And the reply preview is Re recap: "The routing review is complete."
  And the composer region visually matches <baseline> at <threshold> percent
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport | baseline                              | threshold |
  | desktop  | surfacing-reply-recap-excerpt-desktop | 98        |
  | phone    | surfacing-reply-recap-excerpt-phone   | 98        |

Scenario Outline: Several references can sit among free text at the caret
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I place a message reply and a recap reply among free text
  Then the composer keeps both references at their insertion carets
  And the reply preview is Re #2 (Ask, 00:17): "Recapture the phone baseline, or keep the old paint order?"\nRe recap: "The routing review is complete."\n\nBefore middle after
  And the composer region visually matches <baseline> at <threshold> percent
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport | baseline                        | threshold |
  | desktop  | surfacing-reply-multiple-desktop | 98        |
  | phone    | surfacing-reply-multiple-phone   | 98        |

Scenario Outline: Backspace the remove button and a partial selection remove entire tokens
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I quote the recap words The routing review is complete.
  And I remove the reply with <method>
  Then the composer contains no partial reply or preview

Examples:
  | viewport | method            |
  | desktop  | Backspace         |
  | phone    | Backspace         |
  | desktop  | x                 |
  | phone    | x                 |
  | desktop  | partial selection |
  | phone    | partial selection |

Scenario Outline: Arrow keys skip the reference as one editable item
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I quote the recap words The routing review is complete.
  Then arrow keys move across the whole reply token

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: Undo and redo restore full reference payloads after editing
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I quote the recap words The routing review is complete.
  And I append Keep it. after the reply
  And I edit the reply using <method>
  Then the composer has no reply tokens
  When I undo the composer edit
  Then the composer has 1 reply token named Recap
  When I redo the composer edit
  Then the composer has no reply tokens
  When I undo the composer edit
  Then the composer has 1 reply token named Recap
  And the reply preview is Re recap: "The routing review is complete."\n\nKeep it.
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport | method                |
  | desktop  | Backspace             |
  | phone    | Backspace             |
  | desktop  | selection replacement |
  | phone    | selection replacement |

Scenario Outline: Removing the first of two identical chips preserves the second payload
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the recap session has a settled turn with current summaries
  When I quote the recap words The routing review is complete
  And I quote the recap words The routing review is complete.
  Then the composer has 2 reply tokens named Recap
  And the reply tokens have identical displayed labels
  When I remove the reply with Backspace
  Then the composer has 1 reply token named Recap
  And the reply preview is Re recap: "The routing review is complete."
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A self-contained reference survives session switching reload and surfacing being disabled
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When I pick surfaced message #2
  And I reply to the surfaced message with Reply
  And I append Keep the old paint order. after the reply
  Then the reply is included in the existing draft sync
  When I open another surfacing session using the daemon default
  Then the composer has no reply tokens
  When I reload the surfacing session
  Then the composer has 1 reply token named #2 Ask
  And the reply preview is Re #2 (Ask, 00:17): "Recapture the phone baseline, or keep the old paint order?"\n\nKeep the old paint order.
  When surfacing is disabled and I reload the reply draft
  Then the composer has 1 reply token named #2 Ask
  And the reply preview is Re #2 (Ask, 00:17): "Recapture the phone baseline, or keep the old paint order?"\n\nKeep the old paint order.
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario Outline: A draft from another device restores its reference without looking up the message
  Given message surfacing is active at Balanced
  And the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And the surfacing session has a settled turn
  When another device syncs a self-contained recap reply
  Then the composer has 1 reply token named Recap
  And the reply preview is Re recap: "This source is available only on the other device."\n\nPlease check it.
  When I send the composer message
  Then the submitted reply equals its exact preview and the transcript keeps that text

Examples:
  | viewport |
  | desktop  |
  | phone    |
