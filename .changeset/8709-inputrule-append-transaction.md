---
"@tiptap/core": patch
---

Rebuild input-rule transactions against the live editor state when an appendTransaction rewrites the document after the typed text is inserted, so rules still apply instead of leaving marker text (#8709).
