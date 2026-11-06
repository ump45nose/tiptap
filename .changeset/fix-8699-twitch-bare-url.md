---
'@tiptap/extension-twitch': patch
---

Bare Twitch domain URLs (and query-only paths) are rejected by `setTwitchVideo` and paste matching instead of inserting an "Invalid Twitch URL" placeholder that cannot round-trip.
