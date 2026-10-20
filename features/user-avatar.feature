Feature: Your avatar is shared by every chat and device

Scenario Outline: First run asks once and Continue persists the initial
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is unchosen with no Mac picture
  And the conduit app is served with the matching-model mockup
  Then the avatar first run is visible
  And the screen region visually matches <firstRunBaseline> at <threshold> percent
  When I continue with my initial avatar
  Then the daemon stores the initial avatar
  And the avatar first run is absent
  And the transcript avatar is initial
  When I reconnect to the daemon avatar
  Then the avatar first run is absent
  And the transcript avatar is initial
  And the last-user-message region visually matches <savedBaseline> at <threshold> percent

Examples:
  | viewport | theme | firstRunBaseline | savedBaseline | threshold |
  | desktop | dark | avatar-first-run-desktop-dark | avatar-first-run-saved-desktop-dark | 99 |
  | desktop | light | avatar-first-run-desktop-light | avatar-first-run-saved-desktop-light | 99 |
  | phone | dark | avatar-first-run-phone-dark | avatar-first-run-saved-phone-dark | 99 |
  | phone | light | avatar-first-run-phone-light | avatar-first-run-saved-phone-light | 99 |

Scenario Outline: General opens the picker and exposes all twelve presets with available kinds
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is initial with <picture> Mac picture
  And the conduit app is served with the matching-model mockup
  And General auto-settle is set to 3 days
  When I open settings to the General section
  And I open the avatar picker from General
  Then the avatar picker <macOption> Mac
  And the avatar picker has all twelve presets
  And the screen region visually matches <baseline> at <threshold> percent
  When I cancel my avatar change
  Then the daemon has received no avatar changes

Examples:
  | viewport | theme | picture | macOption | baseline | threshold |
  | desktop | dark | a | offers | avatar-picker-mac-desktop-dark | 99 |
  | desktop | dark | no | hides | avatar-picker-no-mac-desktop-dark | 99 |
  | desktop | light | a | offers | avatar-picker-mac-desktop-light | 99 |
  | desktop | light | no | hides | avatar-picker-no-mac-desktop-light | 99 |
  | phone | dark | a | offers | avatar-picker-mac-phone-dark | 99 |
  | phone | dark | no | hides | avatar-picker-no-mac-phone-dark | 99 |
  | phone | light | a | offers | avatar-picker-mac-phone-light | 99 |
  | phone | light | no | hides | avatar-picker-no-mac-phone-light | 99 |

Scenario Outline: Each avatar kind previews locally and survives a reconnect after Done
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is initial with a Mac picture
  And the conduit app is served with the matching-model mockup
  When I open the avatar picker from chat
  And I choose the <choice> avatar
  Then the daemon has received no avatar changes
  When I save my avatar
  Then the daemon stores the <choice> avatar
  And the transcript avatar is <choice>
  When I reconnect to the daemon avatar
  Then the avatar first run is absent
  And the transcript avatar is <choice>
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | choice | baseline | threshold |
  | desktop | dark | initial | avatar-initial-desktop-dark | 99 |
  | desktop | dark | mac | avatar-mac-desktop-dark | 99 |
  | desktop | dark | preset fox | avatar-preset-fox-desktop-dark | 99 |
  | desktop | dark | shape 0 | avatar-shape-0-desktop-dark | 99 |
  | desktop | light | initial | avatar-initial-desktop-light | 99 |
  | desktop | light | mac | avatar-mac-desktop-light | 99 |
  | desktop | light | preset fox | avatar-preset-fox-desktop-light | 99 |
  | desktop | light | shape 0 | avatar-shape-0-desktop-light | 99 |
  | phone | dark | initial | avatar-initial-phone-dark | 99 |
  | phone | dark | mac | avatar-mac-phone-dark | 99 |
  | phone | dark | preset fox | avatar-preset-fox-phone-dark | 99 |
  | phone | dark | shape 0 | avatar-shape-0-phone-dark | 99 |
  | phone | light | initial | avatar-initial-phone-light | 99 |
  | phone | light | mac | avatar-mac-phone-light | 99 |
  | phone | light | preset fox | avatar-preset-fox-phone-light | 99 |
  | phone | light | shape 0 | avatar-shape-0-phone-light | 99 |

Scenario Outline: Fixed seeds zero through eleven keep their generated transcript shapes
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is shape <seed> with no Mac picture
  And the conduit app is served with the matching-model mockup
  Then the avatar first run is absent
  And the transcript avatar is shape <seed>
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | seed | baseline | threshold |
  | desktop | dark | 0 | avatar-fixed-shape-0-desktop-dark | 99 |
  | desktop | dark | 1 | avatar-fixed-shape-1-desktop-dark | 99 |
  | desktop | dark | 2 | avatar-fixed-shape-2-desktop-dark | 99 |
  | desktop | dark | 3 | avatar-fixed-shape-3-desktop-dark | 99 |
  | desktop | dark | 4 | avatar-fixed-shape-4-desktop-dark | 99 |
  | desktop | dark | 5 | avatar-fixed-shape-5-desktop-dark | 99 |
  | desktop | dark | 6 | avatar-fixed-shape-6-desktop-dark | 99 |
  | desktop | dark | 7 | avatar-fixed-shape-7-desktop-dark | 99 |
  | desktop | dark | 8 | avatar-fixed-shape-8-desktop-dark | 99 |
  | desktop | dark | 9 | avatar-fixed-shape-9-desktop-dark | 99 |
  | desktop | dark | 10 | avatar-fixed-shape-10-desktop-dark | 99 |
  | desktop | dark | 11 | avatar-fixed-shape-11-desktop-dark | 99 |
  | desktop | light | 0 | avatar-fixed-shape-0-desktop-light | 99 |
  | desktop | light | 1 | avatar-fixed-shape-1-desktop-light | 99 |
  | desktop | light | 2 | avatar-fixed-shape-2-desktop-light | 99 |
  | desktop | light | 3 | avatar-fixed-shape-3-desktop-light | 99 |
  | desktop | light | 4 | avatar-fixed-shape-4-desktop-light | 99 |
  | desktop | light | 5 | avatar-fixed-shape-5-desktop-light | 99 |
  | desktop | light | 6 | avatar-fixed-shape-6-desktop-light | 99 |
  | desktop | light | 7 | avatar-fixed-shape-7-desktop-light | 99 |
  | desktop | light | 8 | avatar-fixed-shape-8-desktop-light | 99 |
  | desktop | light | 9 | avatar-fixed-shape-9-desktop-light | 99 |
  | desktop | light | 10 | avatar-fixed-shape-10-desktop-light | 99 |
  | desktop | light | 11 | avatar-fixed-shape-11-desktop-light | 99 |
  | phone | dark | 0 | avatar-fixed-shape-0-phone-dark | 99 |
  | phone | dark | 1 | avatar-fixed-shape-1-phone-dark | 99 |
  | phone | dark | 2 | avatar-fixed-shape-2-phone-dark | 99 |
  | phone | dark | 3 | avatar-fixed-shape-3-phone-dark | 99 |
  | phone | dark | 4 | avatar-fixed-shape-4-phone-dark | 99 |
  | phone | dark | 5 | avatar-fixed-shape-5-phone-dark | 99 |
  | phone | dark | 6 | avatar-fixed-shape-6-phone-dark | 99 |
  | phone | dark | 7 | avatar-fixed-shape-7-phone-dark | 99 |
  | phone | dark | 8 | avatar-fixed-shape-8-phone-dark | 99 |
  | phone | dark | 9 | avatar-fixed-shape-9-phone-dark | 99 |
  | phone | dark | 10 | avatar-fixed-shape-10-phone-dark | 99 |
  | phone | dark | 11 | avatar-fixed-shape-11-phone-dark | 99 |
  | phone | light | 0 | avatar-fixed-shape-0-phone-light | 99 |
  | phone | light | 1 | avatar-fixed-shape-1-phone-light | 99 |
  | phone | light | 2 | avatar-fixed-shape-2-phone-light | 99 |
  | phone | light | 3 | avatar-fixed-shape-3-phone-light | 99 |
  | phone | light | 4 | avatar-fixed-shape-4-phone-light | 99 |
  | phone | light | 5 | avatar-fixed-shape-5-phone-light | 99 |
  | phone | light | 6 | avatar-fixed-shape-6-phone-light | 99 |
  | phone | light | 7 | avatar-fixed-shape-7-phone-light | 99 |
  | phone | light | 8 | avatar-fixed-shape-8-phone-light | 99 |
  | phone | light | 9 | avatar-fixed-shape-9-phone-light | 99 |
  | phone | light | 10 | avatar-fixed-shape-10-phone-light | 99 |
  | phone | light | 11 | avatar-fixed-shape-11-phone-light | 99 |

Scenario Outline: Shuffle stays local and cancelling keeps the saved shape
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is shape 0 with no Mac picture
  And the conduit app is served with the matching-model mockup
  When I open the avatar picker from chat
  And I shuffle the avatar shapes
  Then the daemon has received no avatar changes
  When I cancel my avatar change
  Then the transcript avatar is shape 0
  When I reconnect to the daemon avatar
  Then the transcript avatar is shape 0
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | baseline | threshold |
  | desktop | dark | avatar-cancelled-shuffle-desktop-dark | 99 |
  | desktop | light | avatar-cancelled-shuffle-desktop-light | 99 |
  | phone | dark | avatar-cancelled-shuffle-phone-dark | 99 |
  | phone | light | avatar-cancelled-shuffle-phone-light | 99 |

Scenario Outline: A missing Mac picture hides its option and draws the saved Mac choice as an initial
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is mac with no Mac picture
  And the conduit app is served with the matching-model mockup
  Then the avatar first run is absent
  And the transcript avatar is initial
  When I open the avatar picker from chat
  Then the avatar picker hides Mac
  When I cancel my avatar change
  Then the daemon has received no avatar changes
  And the last-user-message region visually matches <baseline> at <threshold> percent

Examples:
  | viewport | theme | baseline | threshold |
  | desktop | dark | avatar-missing-mac-desktop-dark | 99 |
  | desktop | light | avatar-missing-mac-desktop-light | 99 |
  | phone | dark | avatar-missing-mac-phone-dark | 99 |
  | phone | light | avatar-missing-mac-phone-light | 99 |

Scenario Outline: A failed save keeps the picker draft and the saved avatar
  Given the viewport is a <viewport>
  And the avatar theme is <theme>
  And the daemon avatar is initial with no Mac picture
  And the conduit app is served with the matching-model mockup
  And the daemon cannot save the avatar
  When I open the avatar picker from chat
  And I choose the preset fox avatar
  And I save my avatar
  Then the avatar picker keeps its draft after the save error
  And the screen region visually matches <baseline> at <threshold> percent
  When I cancel my avatar change
  Then the transcript avatar is initial

Examples:
  | viewport | theme | baseline | threshold |
  | desktop | dark | avatar-save-error-desktop-dark | 99 |
  | desktop | light | avatar-save-error-desktop-light | 99 |
  | phone | dark | avatar-save-error-phone-dark | 99 |
  | phone | light | avatar-save-error-phone-light | 99 |

