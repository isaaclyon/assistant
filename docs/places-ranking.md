# Places ranking MVP

This document defines the behavior contract for the local, comparison-based
places ranking tracked by [GitHub issue #53](https://github.com/isaaclyon/assistant/issues/53).
It intentionally describes product behavior rather than a database, ranking
algorithm, or Telegram implementation.

## Goal

Let one person maintain ordered lists of restaurants, coffee shops, bars, and
other place categories from Telegram. Adding a place starts with a broad
sentiment and then asks only enough head-to-head questions to determine the
place's position within that sentiment band.

## Ownership and privacy

- The MVP is enabled only for the `personal-isaac` capability profile. Rankings
  belong to that configured assistant instance. They are not shared
  across personal assistants, the household assistant, or unrelated Telegram
  chats.
- The MVP is enabled only for a private Telegram surface. Group rankings and
  collaborative comparisons are deferred.
- The host binds that profile to Isaac's configured private Telegram surface
  and actor before the extension loads. Active insertion ownership is keyed by
  the trusted instance ID and principal, never by model- or user-supplied IDs.
  Emma, household, builder, and unrelated chat contexts do not load the tool.
  The legacy compatibility singleton uses a fixed local owner key only when the
  host has already bound the `isaac` principal and private Telegram surface.
- Place data remains in that instance's local state tree. It is not sent to a
  discovery, maps, or restaurant API.
- Data remains until the user deletes it or removes the local database. Backup
  and export behavior is specified with the persistence work in issue #56.
- Place names and notes are personal data. Logs and errors must use identifiers
  or bounded generic messages rather than record their contents.

## Terms and model

### Place

A place has:

- a generated stable identifier;
- a required display name;
- one category;
- one initial sentiment: `liked`, `alright`, or `disliked`;
- optional plain-text notes; and
- created and updated timestamps.

Names are trimmed, non-empty, and compared case-insensitively after whitespace
normalization. The same normalized name cannot occur twice in one category.
When a duplicate is entered, the bot shows the existing place and asks the user
to cancel or enter a more specific name, such as `Starbucks — Pearl St`. The MVP
does not collect a separate address or location field.

### Category

Categories are user-created ordered-list containers, such as `Restaurants`,
`Coffee`, or `Bars`.

- On a fresh database, `Restaurants`, `Coffee`, and `Bars` are available.
- The user may create another category while adding or managing a place.
- Category names follow the same trim, whitespace, and case-insensitive
  uniqueness rules as place names.
- An empty category may be renamed or deleted. Deleting a non-empty category is
  deferred; places must first be moved or deleted.

### Ranking

Each category has one total ordering from best to worst. Its sentiment bands
are strict and contiguous:

1. every `liked` place;
2. every `alright` place; then
3. every `disliked` place.

Pairwise comparisons determine order only within a sentiment band. Therefore a
liked place always ranks above an alright place even if those two places have
never been compared directly. Position numbers are derived from the ordering
and are never user-editable state.

The MVP has no ties. A first comparison offers the new place, the existing
place, and Cancel. After at least one accepted answer, it also offers Back. It
does not offer `equal`, `skip`, or `haven't decided`,
because those answers do not produce a deterministic binary insertion. The
user may cancel and resume later if they cannot choose.

## Entry points

### Telegram command

`/place_rankings` opens a menu with:

- **Add place**
- **View rankings**
- **Manage places**
- **Resume ranking**, only when an unfinished insertion exists
- **Cancel**, only when an interaction is active

The command and deterministic buttons use pi-telegram's registered-section
callbacks directly. Menu navigation, category/sentiment choices, comparisons,
Back, browsing, pagination, and management do not start model turns. Names,
notes, and category edits use one pending private reply input. Reply to the fresh
standalone bot prompt; its unique input reference distinguishes it from older
prompts. Input expires after ten minutes and can be cancelled. Replies must
match the trusted private actor/chat and that exact bot prompt; unrelated
messages retain ordinary Telegram routing. Input and button tokens are ephemeral;
unfinished database insertions remain durable.

The tool and section use the transport-independent `PlacesApplication.execute`
command boundary. Telegram rendering, drafts, and reply capture stay outside it.
No web UI or generic workflow framework is introduced (issue #96).

Only one unfinished place insertion may exist for an interaction owner. Asking
to add another place first offers Resume or Cancel existing ranking; it never
silently replaces the unfinished work.

### Natural language

Requests that clearly express one of these operations use the same underlying
flow:

- add or rank a restaurant, coffee shop, bar, or other place;
- show a place ranking or category ranking;
- resume or cancel an unfinished ranking; or
- edit, move, re-rank, or delete a place.

Natural language may prefill an unambiguous place name or category, but it does
not bypass confirmation, duplicate checks, comparison state, or destructive
action confirmation. Ambiguous conversation remains ordinary assistant
conversation rather than guessing a mutation.

## Add and rank flow

1. **Collect name.** The bot asks for a place name unless one was supplied
   unambiguously. Cancel returns to the menu without creating a place.
2. **Choose category.** The bot shows existing categories plus **New category**.
   Creating a category returns to this step with the new category available.
3. **Check duplicate.** An existing normalized name in the category stops the
   flow and offers **View existing**, **Enter another name**, or **Cancel**.
4. **Choose sentiment.** The bot offers **Liked**, **Alright**, and **Disliked**.
5. **Insert.** If the selected band is empty, the place is inserted without a
   comparison. Otherwise the bot repeatedly presents the new place against an
   existing place selected by the ranking engine. Choosing one records that
   answer and either asks the next comparison or completes the insertion.
6. **Finish.** The bot reports the place's one-based rank, category size, and
   sentiment. It offers **Add notes**, **View ranking**, and **Undo addition**.
7. **Optional notes.** Notes may be supplied at completion or edited later.

The place is provisional while insertion is active: it does not appear in the
published ranking until the insertion completes. Its draft and comparison
state are durable so a process restart cannot expose a partially ranked place.
Before an insertion exists, the direct add name and selected category are
stored as a small private recovery draft in `<stateDir>/places-add-draft.json`.
After a reset, `/place_rankings` and any stale add-flow button reopen the
category or sentiment step with the place name. The draft is cleared when the
insertion starts and expires after 24 hours.

### Happy-path transcript

```text
User: /place_rankings
Bot:  [Add place] [View rankings] [Manage places]
User: [Add place]
Bot:  What place do you want to rank?
User: Huckleberry Roasters
Bot:  Choose a category: [Restaurants] [Coffee] [Bars] [New category]
User: [Coffee]
Bot:  What was your overall impression? [Liked] [Alright] [Disliked]
User: [Liked]
Bot:  Which is better? [Huckleberry Roasters] [Corvus Coffee]
User: [Huckleberry Roasters]
Bot:  Which is better? [Huckleberry Roasters] [Sweet Bloom]
User: [Sweet Bloom]
Bot:  Huckleberry Roasters is #2 of 8 in Coffee. [Add notes] [View ranking] [Undo addition]
```

### First place in a band

```text
User chooses: [Disliked]
Bot: This is your first disliked place in Restaurants.
Bot: Taco Place is #12 of 12 in Restaurants. [Add notes] [View ranking] [Undo addition]
```

No unnecessary comparison is requested.

## Interruption, resume, cancellation, and undo

### Interruption and resume

- Every accepted step persists before the next prompt is shown.
- Leaving the chat, starting a new Pi session, reloading extensions, or
  restarting the process does not discard an unfinished insertion.
- `/place_rankings` shows **Resume ranking** when one exists. A clear natural-language
  request to continue may do the same.
- Resume shows the current step again. If a comparison answer was already
  accepted, it is not asked again.
- Repeated delivery of the same button action is idempotent and cannot advance
  the insertion twice.
- A button from an older step receives a short stale-action response and shows
  the current step; it never rewinds or mutates state.

### Back

- Before comparisons begin, ordinary conversational prompts may return to a
  preceding input question, but no persisted comparison Back action is shown.
- During comparisons, **Back** removes the most recent comparison answer and
  restores exactly that comparison.
- Back never changes an already published ranking.

### Cancel

- Canceling an unfinished insertion asks for confirmation after the place name
  has been entered.
- The confirmation is a short-lived, one-use token bound to the insertion and
  exact comparison revision. Advancing the comparison invalidates that approval.
- Tokens live only in the selected extension session, whose Telegram surface
  is restricted by the host to one configured private actor. They expire after
  ten minutes, are capped at 32 pending operations, and are cleared on reload,
  session replacement, or shutdown.
- Confirmation deletes the draft and its insertion answers. The published
  ranking remains unchanged.
- Declining cancellation returns to the current step.

### Undo addition

- Immediately after completion, **Undo addition** asks for confirmation.
- Delete-place and delete-category actions use the same operation-bound,
  one-use confirmation mechanism. They also snapshot the category mutation
  revision and check it inside the deletion transaction. A later mutation in
  that category requires a fresh confirmation, including same-timestamp edits.
- Confirming removes that newly added place and its comparison history.
- The action is available until another place mutation occurs in that category.
  After that, normal confirmed deletion is used instead.
- Undo is safe to repeat: once removed, another press reports that the action is
  no longer available and changes nothing.

## Browse and management contract

The MVP's management surface, implemented in issue #59, supports:

- list categories and their place counts;
- show an ordered category ranking with sentiment boundaries;
- show one place's rank, sentiment, and notes;
- edit a place name or notes;
- move a place to another category, which starts a new insertion there and
  leaves the original ranking unchanged until completion;
- change sentiment or re-rank a place through a new insertion;
- delete a place after confirmation; and
- rename or delete an empty category.

A move or re-rank is provisional just like an add. Canceling it leaves the
published place in its original category and position. Completing it replaces
the old placement atomically.

## Required failure behavior

- Empty categories and bands finish without a comparison.
- Invalid text, missing records, or impossible ranking state produce a bounded
  error and do not partially write data.
- A comparison target deleted or changed by another writer makes the current
  insertion stale. The bot cancels that provisional insertion and asks the
  user to restart it rather than applying an answer to a different target.
- Telegram message limits are handled by pagination; ranking output is never
  silently truncated.
- Database unavailability leaves the action unaccepted and tells the user to
  retry. It must not claim a rank or completion.

## Deferred functionality

- ties, skipped comparisons, and partial orders;
- collaborative or household rankings;
- public profiles, following, comments, or recommendations;
- maps, addresses, geocoding, place discovery, and third-party APIs;
- photos, menus, prices, visit history, companions, or per-dish ratings;
- automatic imports from Beli or another service;
- a standalone web or mobile UI; and
- ranking decay, scoring formulas, or global comparisons across categories.

These are not compatibility requirements for the MVP. They should be added only
in response to a separate concrete need.

## Backup, export, and recovery

Canonical data lives in the selected assistant instance's
`<stateDir>/places.db`. The file and supported backups are mode `0600`; neither
belongs in Git.

- Use `PI_TELEGRAM_BRIDGE_STATE_DIR=<stateDir> npm run places -- backup <path>`
  to create a consistent online SQLite backup while the bridge is running. It
  includes categories, published rankings, unfinished insertions, and history.
- Use `PI_TELEGRAM_BRIDGE_STATE_DIR=<stateDir> npm run places -- export <path>`
  for a private-mode JSON export of published data.
- The JSON export is intended for inspection and portability. It contains only
  published categories and places, so it cannot restore an unfinished ranking
  or its history.
- Restore by stopping the affected instance, retaining the damaged database for
  diagnosis, placing a known-good SQLite backup at `<stateDir>/places.db`, and
  starting the instance again. The schema version is checked before use.
- Do not copy only the main database file while the bridge is running in WAL
  mode. Use the online backup operation or stop the instance before a manual
  filesystem copy.
