Feature: Move the conversation from the transcript, and undo any move

Background:
  Given the conduit app is served with the connected mockup

Scenario Outline: undo a move from the Head Log, reached from a reply's message menu
  Given the viewport is a <viewport>
  And a branched conversation is open
  When I open the head log from the first reply's message menu
  Then the head log lists <first> then <second>
  When I undo the head log entry <second>
  Then the conversation moves with undo of <moveId>
  And the head log lists <undo> then <first>

Examples:
  | viewport | first                       | second  | moveId | undo         |
  | phone    | Resent "Add a FAQ section"  | Rewound | move-1 | Undid a move |
  | desktop  | Resent "Add a FAQ section"  | Rewound | move-1 | Undid a move |

Scenario Outline: a move still landing cannot be undone yet
  Given the viewport is a <viewport>
  And a branched conversation is open
  And the newest head move is still landing
  When I open the head log from the first reply's message menu
  Then the head log entry <entry> cannot be undone yet

Examples:
  | viewport | entry           |
  | phone    | Switched branch |
  | desktop  | Switched branch |

Scenario Outline: the Head Log is the way into the rewind dialog
  Given the viewport is a <viewport>
  And a branched conversation is open
  When I open the head log from the first reply's message menu
  And I choose to rewind to a message from the head log
  Then the head log is closed
  And the rewind banner reads <banner>

Examples:
  | viewport | banner                        |
  | phone    | Select a message to rewind to |
  | desktop  | Select a message to rewind to |

Scenario Outline: switch to another branch where the conversation branched
  Given the viewport is a <viewport>
  And a branched conversation is open
  Then only the message <message> carries a branch switcher reading <label>
  When I open the branch switcher
  Then the branch <gone> is unavailable and cannot be picked
  When I pick the branch <other>
  Then the conversation moves with a switch to <tip>

Examples:
  | viewport | message                  | label         | gone                   | other                    | tip        |
  | phone    | Add a migration section  | Branch 1 of 3 | Add a changelog         | Add a FAQ section        | node-faq   |
  | desktop  | Add a migration section  | Branch 1 of 3 | Add a changelog         | Add a FAQ section        | node-faq   |

Scenario Outline: edit and resend a message as a new branch
  Given the viewport is a <viewport>
  And a branched conversation is open
  When I edit the message <old> to <new> and send it
  Then the conversation moves with a rewind before <messageId> resending <new>
  And no message was sent outside the move

Examples:
  | viewport | old                     | new                          | messageId  |
  | phone    | Add a migration section | Add an upgrade guide section | hm-user-2  |
  | desktop  | Add a migration section | Add an upgrade guide section | hm-user-2  |

Scenario Outline: regenerate a reply as a new branch
  Given the viewport is a <viewport>
  And a branched conversation is open
  When I regenerate the reply from the message menu of reply <reply>
  Then the conversation moves with a rewind before <messageId> resending <text>

Examples:
  | viewport | reply | messageId | text                    |
  | phone    | 2     | hm-user-2 | Add a migration section |
  | desktop  | 2     | hm-user-2 | Add a migration section |

Scenario Outline: a move into pruned history says the files there were pruned
  Given the viewport is a <viewport>
  And a branched conversation is open
  And the files at every move's target were pruned
  When I regenerate the reply from the message menu of reply <reply>
  Then the conversation moves with a rewind before <messageId> resending <text>
  And a notice says <notice>

Examples:
  | viewport | reply | messageId | text                     | notice                             |
  | phone    | 1     | hm-user-1 | Draft the release notes  | Files from this point were pruned. |
  | desktop  | 1     | hm-user-1 | Draft the release notes  | Files from this point were pruned. |

Scenario Outline: a message with an image can be regenerated
  Given the viewport is a <viewport>
  And the first message carried an image
  And a branched conversation is open
  When I regenerate the reply from the message menu of reply <reply>
  Then the conversation moves with a rewind before <messageId> resending <text>

Examples:
  | viewport | reply | messageId | text                    |
  | phone    | 1     | hm-user-1 | Draft the release notes |
  | desktop  | 1     | hm-user-1 | Draft the release notes |

Scenario Outline: a move refused because a turn started elsewhere says why and moves nothing
  Given the viewport is a <viewport>
  And a branched conversation is open
  And another device has started a turn in the conversation
  When I regenerate the reply from the message menu of reply <reply>
  Then a notice says <notice>
  And the conversation did not move

Examples:
  | viewport | reply | notice                       |
  | phone    | 2     | Stop the current turn first. |
  | desktop  | 2     | Stop the current turn first. |

Scenario Outline: rewind the conversation and files after reading the paths that change
  Given the viewport is a <viewport>
  And a rewind there would change <first_path> and <second_path>
  And a branched conversation is open
  When I open the head log from the first reply's message menu
  And I choose to rewind to a message from the head log
  And I pick the message <message> to rewind to
  Then the rewind dialog lists <first_path> and <second_path> as changing
  When I choose to rewind the conversation and files
  Then the conversation moves with a rewind before <messageId> with files

Examples:
  | viewport | first_path        | second_path | message                 | messageId |
  | phone    | docs/migration.md | notes.md    | Add a migration section | hm-user-2 |
  | desktop  | docs/migration.md | notes.md    | Add a migration section | hm-user-2 |

Scenario Outline: another session in the folder keeps the files, and the conversation-only rewind still goes
  Given the viewport is a <viewport>
  And the session <other> has run in <folder> since
  And a branched conversation is open
  When I open the head log from the first reply's message menu
  And I choose to rewind to a message from the head log
  And I pick the message <message> to rewind to
  Then rewinding the files is unavailable because <reason>
  When I choose to rewind the conversation only
  Then the conversation moves with a rewind before <messageId>

Examples:
  | viewport | other     | folder      | message                 | reason                                                    | messageId |
  | phone    | Docs pass | /work/notes | Add a migration section | Docs pass changed files in /work/notes since this point. | hm-user-2 |
  | desktop  | Docs pass | /work/notes | Add a migration section | Docs pass changed files in /work/notes since this point. | hm-user-2 |

Scenario Outline: files from pruned history cannot be rewound
  Given the viewport is a <viewport>
  And the files at every move's target were pruned
  And a branched conversation is open
  When I open the head log from the first reply's message menu
  And I choose to rewind to a message from the head log
  And I pick the message <message> to rewind to
  Then rewinding the files is unavailable because <reason>

Examples:
  | viewport | message                 | reason                             |
  | phone    | Add a migration section | Files from this point were pruned. |
  | desktop  | Add a migration section | Files from this point were pruned. |
