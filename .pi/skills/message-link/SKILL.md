---
name: message-link
description: "Creates private Telegram-clickable HTTPS links that let the user edit a proposed SMS/iMessage before explicitly opening Messages. Use when the user wants to draft or message someone without sending automatically."
---

# Create an editable Messages link

Use this workflow only to draft a message. It never sends, reads contacts, or
opens Messages automatically.

1. Establish one selected phone number, recipient label, and proposed body. If
   recipient selection is ambiguous, ask first.
2. Generate the link with the tracked helper. Pass exactly one JSON object on
   stdin; do not put private values in the HTTPS query string:

   ```bash
   printf '%s\n' '{"to":"+18018851827","label":"Emma","body":"Proposed text"}' \
     | node .pi/skills/message-link/scripts/messages-link.mjs
   ```

3. Return the generated HTTPS URL as a normal Markdown link, named for the
   recipient (for example, `Review message to Emma`). State briefly that the
   body is editable, opening Messages takes a tap, and sending takes another.

The helper validates and normalizes the phone number, bounds the label/body,
and places all three values after `#`. URL fragments stay in the browser and do
not reach the HTTPS server. Treat the proposed text as a draft, not approval.
Never claim that Messages opened or that anything was sent.
