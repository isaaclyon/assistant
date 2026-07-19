---
name: track-improvement-ideas
description: "Maintains the agent improvement ideas backlog. Use when the user wants to add, list, refine, or remove ideas for future skills, extensions, or agent improvements."
---

# Track Improvement Ideas

Store improvement ideas as GitHub Issues in the repository configured by the
`origin` remote. Use `gh`, specify the resolved `owner/repository` explicitly on
every operation, and verify `gh auth status` before the first operation.

## Add

- Accept rough ideas without asking the user to scope them perfectly.
- List existing open and closed issues first and avoid obvious duplicates. If a
  likely match exists, show it and ask whether to add context or reopen it.
- Create one issue per idea with a concise title, the `enhancement` label, and a
  short body containing only the useful context already provided. Do not invent
  requirements, acceptance criteria, priority, or implementation details.
- An explicit request to add, save, track, or remember an improvement idea
  authorizes creating the issue. Otherwise offer to capture it rather than
  publishing silently.
- Build request JSON with a serializer and pass it to `gh api` through a file or
  stdin. Never interpolate user text into shell commands or place it in command
  arguments.

## List and refine

- Use `gh issue list --repo <owner/repository>` and summarize tersely with issue
  numbers and titles. Include closed issues only when requested or when checking
  for duplicates.
- Read the current issue before editing it. Preserve unrelated body content and
  labels; apply only the requested title/body/label change.
- Treat prioritization as optional. An issue can remain an unscoped idea until
  the user wants to develop it.

## Remove

- Interpret removal as closing the issue, not deleting it. Show the issue and
  obtain explicit confirmation before closing because this changes shared
  external state.
- Reopen a closed idea when explicitly requested.

After every write, inspect the returned issue and report its number, title, and
URL. Never print GitHub credentials or authentication configuration.
