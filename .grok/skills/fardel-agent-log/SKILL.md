---
name: fardel-agent-log
description: >
  Record and reuse Fardel implementation quirks across Devs and PRs.
  Read docs/agent-log.md at ticket start; append a 3-line entry in the
  same PR when you hit a reusable trap (VE 403, detached skeleton, fog
  banding, jump squash rubber-band, Fish ve-upload, JumpSmoke flake,
  SpacetimeDB generate). Promote a log line into a project skill when
  the same trap needs a multi-step procedure. Use when implementing a
  Fardel Issue, opening or reviewing a PR, hitting a quirk, writing a
  learning, or running /fardel-agent-log.
---

# Fardel agent log

The log is `docs/agent-log.md` (in-repo, all worktrees). **Format is that file's header** — do not invent a second template. `docs/LEARNINGS.md` is historical keep/leave; never append farm traps there.

## Read

Before editing: `rg -i '<tags>' docs/agent-log.md` for tags that match the Issue (`movement`, `humanoid`, `place`, `ve`, `smoke`, `spacetime`, `bindings`, `fog`, `jump`). If the file is missing on this branch, `git show origin/develop:docs/agent-log.md`. Apply matching **Do this** lines. Do not re-derive a logged workaround.

## Write

Append **in the same PR** (newest at the bottom) when all of:

- You lost real time, or shipped a wrong approach, on something the next seat will hit
- The note is reusable on a *different* ticket
- Nothing already in the file covers it

Heading must include date, tags, and PR/Issue so parallel Devs appending the same hour merge cleanly.

Skip: happy-path narration, "implemented X", one-off typos, farm process (LOOP / CHARTER / ORCHESTRATION), design keep/leave.

## Promote to a skill

Create `.grok/skills/<name>/SKILL.md` (project scope) instead of another log paragraph when:

- The same trap already has **two** log entries, or
- The fix is a **multi-step procedure** (not one command / one don't)

The new skill's `description` must include trigger phrases so it auto-invokes. Leave a one-line pointer in the agent log: `promoted: .grok/skills/<name>/SKILL.md`.

Do not mint a skill for a one-liner already in LOOP (VE `fish -c`, never `:3000`).
