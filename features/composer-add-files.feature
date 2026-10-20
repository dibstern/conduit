Feature: Add shared provider file formats from the composer

Scenario Outline: attach text and PDF files on desktop and phone
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the <harness> harness
  When I open the composer add menu
  Then Add Files follows Add Photos in the attach menu
  When I choose the text and PDF attachments
  Then the composer shows removable file chips for notes.txt and guide.pdf
  And the composer region visually matches <baseline> at <threshold> percent
  When I type Read these files into the composer
  And I send the composer message
  Then the composer submits both files with their original bytes and names
  And the composer file chips are cleared

Examples:
  | viewport | harness  | baseline                            | threshold |
  | desktop  | Claude   | composer-add-files-claude-desktop   | 98        |
  | phone    | Claude   | composer-add-files-claude-phone     | 98        |
  | desktop  | OpenCode | composer-add-files-opencode-desktop | 98        |
  | phone    | OpenCode | composer-add-files-opencode-phone   | 98        |

Scenario: send files without a typed message
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  When I open the composer add menu
  And I choose the text and PDF attachments
  And I send the composer message
  Then the composer submits both files with their original bytes and names

Scenario: recover a failed file-only send without losing attachments
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  When I open the composer add menu
  And I choose the text and PDF attachments
  And the next composer submission fails
  And I send the composer message
  Then the failed file-only send keeps both files ready to retry
  When I send the composer message
  Then the composer retries both files with their original bytes and names
  And the composer file chips are cleared

Scenario: remove a file before sending
  Given the conduit app is served with the connected mockup
  And a session already exists on the Claude harness
  When I open the composer add menu
  And I choose the text and PDF attachments
  And I remove the notes.txt attachment
  Then only the guide.pdf file chip remains

Scenario Outline: reject unsupported or unreadable files inline and keep valid attachments
  Given the conduit app is served with the connected mockup
  And the viewport is a <viewport>
  And a session already exists on the Claude harness
  When I open the composer add menu
  And I choose the text and PDF attachments
  And I open the composer add menu
  And I choose an unsupported binary attachment
  Then the composer reports that archive.zip cannot be attached
  And the composer shows removable file chips for notes.txt and guide.pdf

Examples:
  | viewport |
  | desktop  |
  | phone    |

Scenario: explain that file delivery is unavailable on Cursor
  Given the conduit app is served with the connected mockup
  And a Cursor account is available with its live models
  When I start a new session
  And I open the model picker
  And I view Harness choices in the picker
  And I select the Cursor Harness tab in the picker
  And I view Model choices in the picker
  And I select model Composer 2.5 in the picker
  And I close the model picker
  And I open the composer add menu
  And I select Add Files on the unsupported harness
  Then the composer explains which harnesses support file attachments
