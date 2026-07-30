---
name: message-link
description: "Creates private Telegram-clickable HTTPS links for editable SMS/iMessage drafts. Use whenever the user asks to write, draft, prepare, or send a text/message to someone; do not respond with only the proposed wording when a recipient number is available."
---

# Create an editable Messages link

Use this workflow only to draft a message. It never sends, reads contacts, or
opens Messages automatically.

## Trigger behavior

- Treat requests to **write, draft, or prepare a text to someone** as requests
  for an editable Messages link, not merely help composing wording.
- Do not return only the message body when one recipient phone number and a
  proposed body can be established from the current request and conversation.
- When the recipient and proposed body are known, generate the link immediately
  in the same turn; do not ask whether the user wants a link.
- If the user explicitly asks only for wording, copy, or phrasing and does not
  ask to text a recipient, a plain-text draft is sufficient.
- If the recipient is named but no selected phone number is available, use the
  `google-contacts` skill first when available.

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
