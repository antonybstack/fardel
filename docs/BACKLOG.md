# Backlog

**Source of truth:** [GitHub Issues](https://github.com/antonybstack/fardel/issues) on `antonybstack/fardel`.

Do not maintain a parallel markdown backlog. Open or update Issues for work; close them when done.

## Labels (convention)

| Label | Meaning |
|---|---|
| `P0` / `P1` / `P2` | Priority |
| `lane:server` / `lane:client` / `lane:qa` | Ownership lane |
| `feel` | Feel / UX observation |
| `flake` | Intermittent / flaky failure |
| `wave` | Grouped into a delivery wave |

Issue templates live under `.github/ISSUE_TEMPLATE/` (bug, feature, feel).

## PRs

- Reference the Issue: `Fixes #N` (or `Closes #N`) in the PR body so merge closes the work item.
- Prefer one Issue → one PR when practical.

## Waves

**Team Lead** assigns waves from Issues (labels / milestones), not from ad-hoc chat lists.
