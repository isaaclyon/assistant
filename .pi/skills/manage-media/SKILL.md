---
name: manage-media
description: "Checks and requests media on the home media stack (Sonarr, Radarr, Prowlarr, Seerr) through the typed media_stack and media_request tools. Use for download queues, stuck or failed downloads, upcoming episodes and releases, whether a title is in the library, media stack health, and requesting a movie or show."
compatibility: "Needs the media_stack tool, which exists only when the instance has a media gateway configured. There is no shell, SSH or raw API access."
---

# Manage media

Use only the `media_stack` (read) and `media_request` (request) tools. Do not look for another route: do not use a shell, SSH, `docker`, `curl` or an app web page to reach the media host. If neither tool is available, say the media stack is not set up for this bot and stop.

## Reading

`media_stack` runs one operation per call:

| Question | operation |
| --- | --- |
| Is the stack healthy? | `health` (reports each service and any health warnings) |
| What is downloading, stuck or failing? | `queue` (Sonarr and Radarr; shows state, time left and errors) |
| What airs or releases soon? | `upcoming` with `days` (1 to 14, default 7) |
| Do we already have this? | `library_search` with `query`, optionally `kind` (`movie`, `series`) |
| What can be requested? | `request_search` with `query` |
| What has been requested? | `request_list` with `filter` (default `pending`) and `take` |

Report results in plain words. Give counts and the few items that matter, not raw output. For `queue`, name each item with an error and state the likely next step in one sentence. A healthy queue needs one line.

## Requesting

1. Check `library_search` first. If the title is already in the library, say so and do not request it.
2. Run `request_search` and match the title and year the user gave. If more than one result fits, ask which one. Do not guess.
3. Call `media_request` only for a title the user clearly asked for, using the exact `media_type` and `media_id` from the search. TV needs `seasons` (a list) or `all_seasons`. Ask which seasons if the user did not say.
4. Make one `media_request` call per title. `ALREADY_EXISTS` means it is already requested; tell the user and do not retry. If a call fails or is interrupted, check `request_list` before trying again.

## Limits

- The tools cannot delete, restart, change settings or search indexers. Say so if asked, and describe what the user can do themselves.
- A request goes to Seerr, which decides approval and download. Say "requested", not "downloading".
- `REQUESTS_DISABLED` means the operator turned requests off for this gateway. Report it; do not look for a workaround.
- Errors such as `MEDIA_GATEWAY_UNAVAILABLE`, `MEDIA_UNAVAILABLE` or `MEDIA_TIMEOUT` mean the media host or its link is down. Report that once. Do not retry in a loop.
