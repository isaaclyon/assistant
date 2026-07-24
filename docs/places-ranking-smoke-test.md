# Places ranking Telegram smoke test

Run this checklist against non-sensitive sample data after deployment approval.
Do not use it to authorize deployment or restart the bridge.

## Preconditions

- The deployed revision is recorded.
- The selected private instance has the `places` extension enabled.
- `<stateDir>/places.db` has been backed up with the supported online backup.
- `/places` appears in Telegram's command menu.

## Add and comparison flow

1. Send `/places`; verify concise **Add place** and **View rankings** buttons.
2. Add `Smoke Test A` to `Coffee` as **Liked**. With an empty band, verify it
   completes without a comparison and reports `#1 of 1`.
3. Add `Smoke Test B` to `Coffee` as **Liked**. Verify the bot presents exactly
   the two place names plus Back and Cancel.
4. Choose `Smoke Test B`; verify one final rank is reported and the Coffee list
   contains each place once.
5. Press the old comparison button again. Verify it reports a stale/current
   state and does not reorder or duplicate either place.

## Interruption and restart persistence

1. Start adding `Smoke Test C` until a comparison is visible, then leave it
   unanswered.
2. Send `/places` again and verify **Resume ranking** returns the same target.
3. Only during an explicitly approved rollout test, restart the instance and
   verify Resume still returns that comparison.
4. Use Cancel, decline once, then confirm. Verify A and B remain unchanged and C
   is absent.

## Management

1. Open Coffee and verify ordered output and sentiment boundaries.
2. Add a note to A, reopen its details, and verify the note.
3. Move A to Restaurants. Cancel if a comparison appears and verify A remains in
   Coffee; repeat and complete the move, then verify it appears only in
   Restaurants.
4. Re-rank B and use Back once; verify the exact prior comparison returns.
5. Delete B, decline confirmation once, then confirm and verify positions remain
   contiguous.
6. Create, rename, and delete an empty test category. Verify a non-empty category
   cannot be deleted.

## Backup and recovery

1. Create an online SQLite backup and verify its file mode is `0600`.
2. Open the backup in an isolated test process and confirm published rankings
   and any active insertion are readable.
3. Verify the JSON export contains published categories/places but no unfinished
   interaction history.

## Cleanup

- Delete all `Smoke Test` places and empty test categories.
- Confirm unrelated assistant commands and tools still work.
- Record failures as follow-up issues without including personal place data or
  database contents in logs or issue comments.
