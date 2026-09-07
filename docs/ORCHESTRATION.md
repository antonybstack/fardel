# Fardel team orchestration

Operational runbook for the multi-agent development loop that lands work on `develop`, cuts `main`, and ships [play.sparkify.dev](https://play.sparkify.dev). Written so the same loop can be recreated on Antony’s Mac Studio via **Grok CLI** (parent agent creates subagents; the Mac is the shared computer instead of the Grok Bot Linux box).

Related docs: [TEAM_SEATS.md](TEAM_SEATS.md) · [BACKLOG.md](BACKLOG.md) · [DEV_BOX.md](DEV_BOX.md) · [DEPLOY.md](DEPLOY.md) · [LEARNINGS.md](LEARNINGS.md) · [SCOPE.md](SCOPE.md)

---

## 1. Purpose / north star

**Fardel** is a browser MMORPG (classless / bag-as-build, hordes.io feel) with:

- SpacetimeDB **C#** module as authority
- **Babylon.js + TypeScript / Vite** client (`web/`)
- Headless C# smokes as the first proof of Done-when
- Visual evidence (`ve/*.png`) on every user-facing PR

**Unbound Team Lead** (parent) coordinates Devs, QA, Reviewer, Release, and **Art**. The Lead:

- Assigns work **only from GitHub Issues** (not ad-hoc chat wishlists)
- **Never leaves seats idle** while the project has open gaps — if the board is thin, file Issues (or have Art file visual ones) and assign immediately
- Merges to `develop` only after Reviewer feedback is addressed
- Greenlights Release cuts (`develop` → `main` → Mac smoke → Pages)
- Does **not** solo-invent features on `main` while the team is live

Autonomy default: keep the loop moving (assign idle seats, nudge reviews, merge when clear). Surface Antony only for merges, blockers, release candidates, or genuine human gates (deploy wipe, elevated approvals).

---

## 2. Roster and roles

| Role | Job | Must NOT |
|------|-----|----------|
| **Team Lead** | Pick Issues; assign seats; broadcast `develop` tip SHAs; merge after Reviewer; greenlight Release; run continuous-iterate | Solo invent on `main`; wipe non-local DBs; fan-out spam |
| **Dev1–Dev5** | Implement one assigned Issue in their seat worktree; open PR → `develop` with VE | Invent without an Issue; PR to `main`; use another seat’s ports/DB |
| **QA Bugs** | Smoke matrix, flake repros, regression Issues; optional fix PRs as `qa/<slug>` | Feature invent |
| **QA Feel** | Feel / UX playtests; `feel`-labeled Issues; Mac/Pages FPS truth (not box SwiftShader) | Feature invent |
| **Reviewer** | Review PRs targeting `develop`: correctness, smoke coverage, schema-collision risk, lane conflicts; concrete feedback | Own features; push merges |
| **Release** | On Lead greenlight: promote pinned `develop` SHA → `main`, Mac smoke, Cloudflare Pages deploy, VE + release beat | Cut without greenlight; expand tip silently; invent features; run two cuts at once |
| **Art** | Visual north star vs [ASSETS.md](ASSETS.md); art-direction briefs; license-safe pack **shortlists**; break visual work into Issues for Devs; look-language coherence | Invent gameplay systems; **buy** third-party art packs without Antony/Lead greenlight; leave Devs idle on visuals |

### Seat map (shared computer)

Canonical file: [`tools/scripts/fardel-seats.env`](../tools/scripts/fardel-seats.env). Narrative: [TEAM_SEATS.md](TEAM_SEATS.md).

| Seat | Spacetime | Vite | DB name | Worktree (box today) |
|------|-----------|------|---------|----------------------|
| `dev1` | 3001 | 5174 | `fardel-dev1` | `/workspace/wt/dev1` |
| `dev2` | 3002 | 5175 | `fardel-dev2` | `/workspace/wt/dev2` |
| `dev3` | 3003 | 5176 | `fardel-dev3` | `/workspace/wt/dev3` |
| `dev4` | 3004 | 5177 | `fardel-dev4` | `/workspace/wt/dev4` |
| `dev5` | 3005 | 5178 | `fardel-dev5` | `/workspace/wt/dev5` |
| `qa-bugs` | 3011 | 5184 | `fardel-qa-bugs` | `/workspace/wt/qa-bugs` |
| `qa-feel` | 3012 | 5185 | `fardel-qa-feel` | `/workspace/wt/qa-feel` |
| `lead` | 3000 | 5173 | `fardel` | `/workspace/fardel` |

Per-seat Spacetime data: `$HOME/.local/share/fardel-wt/<slug>`.

Reviewer, Release, and Art do not need a dedicated Spacetime stack by default (Release uses Mac Studio `/Users/antbly/dev/fardel` for smokes + Pages; Art mostly briefs + docs + VE reviews). Art may borrow a Dev seat worktree for presentation spikes when Lead agrees.

---

## 3. Communication topology

Grok Bot / Grok CLI agents talk through channels and 1:1 messages. Hard constraint observed on the Bot product: **channels max out at 6 members**, which forced a split:

| Channel | Members | Purpose |
|---------|---------|---------|
| **Fardel** | Lead + Dev1–5 | Assignments, tip broadcasts, Dev blockers |
| **Fardel QA** | Lead + QA Bugs + QA Feel + Reviewer + Release + Art | Review nudges, feel/smoke reports, release coordination, visual gate notes |
| **Fardel Art** | Lead + Art + QA Feel + Dev3–5 (example seating) | Art briefs, visual wave coordination, look-language reviews |

**Assignment message shape** (1:1 or short channel post):

1. Issue number + title (`#20 Bandage consumable`)
2. Branch name (`dev1/bandage`)
3. Base tip SHA of `develop` at assign time
4. Done-when (smokes + `?ve=…` name)
5. VE path expectation (`ve/babylon-….png`, force-add if gitignored)
6. Explicit “do not invent past this Issue”

Prefer **GitHub Issues as source of truth** over maintaining parallel markdown backlogs ([BACKLOG.md](BACKLOG.md)).

Do not re-ping Reviewer or Lead about a PR that is already merged — check `gh pr view` / merge state first.

---

## 4. Git branching model

| Branch | Role |
|--------|------|
| `main` | **Release** / production tip. No feature PRs. |
| `develop` | **Integration** — every day-to-day PR targets this. |
| `seats/<slug>` | Long-lived worktree tips (optional); feature work still ships on short-lived branches. |
| `devN/<slug>`, `client/<slug>`, `qa/<slug>`, `art/<slug>`, `chore/<slug>` | Feature / fix / art / docs branches. |
| `checkpoint/unity-webgl` | Frozen Unity client (not active). Active client is Babylon. |

### PR rules

- Target **`develop`**, never `main` (except Release’s promote PR).
- Body includes `Fixes #N` (or `Closes #N`) so merge closes the Issue.
- **VE required** for user-visible changes: commit `ve/*.png` **and** embed in the PR body.
- `ve/` is often gitignored → use `git add -f ve/<file>.png`.
- Serialize **schema / reducer / Spacetime module** edits to **one Dev at a time**. Client-only Cosmetics can parallel.
- After merge: Lead broadcasts new `develop` tip SHA; open branches rebase onto it before next push.

### Attribution

Commits as: `Antony Blyakher <antonyblyakher@gmail.com>` (GitHub: `antonybstack`).

---

## 5. Shared-computer isolation (worktrees + ports)

Agents share **one filesystem** (the Grok Bot box today; Mac Studio in the Grok CLI port). Isolation is not “separate VMs” — it is:

1. **Git worktrees** so concurrent checkouts don’t fight
2. **Unique Spacetime ports + data dirs + DB names**
3. **Unique Vite ports**

### Seat bootstrap

```bash
# From repo root of the seat worktree’s sibling scripts (lead clone or any wt that has tools/)
source tools/scripts/wt-env.sh <slug>          # exports FARDEL_*
tools/scripts/ensure-seat-spacetime.sh <slug>  # detached start + ping

cd "$FARDEL_WT/server"
spacetime publish "$FARDEL_DB" -y --env local -s "$FARDEL_SPACETIME_URI"
```

Prefer `$FARDEL_SPACETIME_URI` over the Spacetime nickname `local` so seats do not all publish to port 3000.

Local schema drift frequently requires:

```bash
spacetime publish "$FARDEL_DB" -y --env local -s "$FARDEL_SPACETIME_URI" --delete-data=always
```

**Never** pass delete-data against non-local / tunnel / prod DBs without explicit human coordination.

Vite: bind `127.0.0.1:$FARDEL_VITE_PORT` from `$FARDEL_WT/web`.

Smokes (`tools/*Smoke`, mates): after sourcing `wt-env.sh`, they honor `FARDEL_SPACETIME_URI` / `FARDEL_DB` via `GameConstants.ResolveLocalUri()` / `ResolveDatabaseName()`.

Lead defaults match historical single-instance docs in [DEV_BOX.md](DEV_BOX.md) (`http://127.0.0.1:3000` / `fardel`).

---

## 6. GitHub integration (Issues → PR → merge → release)

### Backlog

- Board: https://github.com/antonybstack/fardel/issues
- Labels: `P0` / `P1` / `P2`, `lane:server` | `lane:client` | `lane:qa` | `lane:release` | `lane:art`, `feel`, `flake`, `wave`
- Templates: `.github/ISSUE_TEMPLATE/` (bug, feature, feel)
- Team Lead assigns waves from Issues / milestones, not chat lists

### Merge gate (develop)

A PR is merge-ready when **all** of:

1. Reviewer has reviewed (approve or feedback addressed)
2. Relevant headless smokes green on the seat (or Lead/QA Bugs verification)
3. VE present (committed + embedded) when UI/feel changed
4. `Fixes #N` present
5. No open schema collision with another in-flight server PR

Team Lead merges (not Reviewer, not Dev self-merge by default).

### Release cut

1. Lead greenlights a **pinned** `develop` SHA (example language: “cut at `d6c21dc`”).
2. Release opens / merges **develop → main** for that tip (do not silently include later develops).
3. Mac Studio smoke on `/Users/antbly/dev/fardel` (local Spacetime and/or tunnel `dev-db.sparkify.dev`).
4. If green: Vite production build + Cloudflare Pages → `https://play.sparkify.dev`.
5. Post VE + short release beat to Lead / Fardel QA.
6. Later commits on `develop` wait for the next cut.

Deploy topology: [DEPLOY.md](DEPLOY.md).

---

## 7. Developer environment

### Box (Grok Bot computer) — [DEV_BOX.md](DEV_BOX.md)

| Tool | Notes |
|------|-------|
| .NET | `$HOME/.dotnet` — SDK 10 + 8; module TFM `net8.0` |
| Spacetime CLI | `$HOME/.local/bin/spacetime` → **2.10.x** |
| Node | `$HOME/.local/node22/bin` → **22.x** |

```bash
export DOTNET_ROOT=$HOME/.dotnet
export PATH="$HOME/.local/node22/bin:$DOTNET_ROOT:$DOTNET_ROOT/tools:$HOME/.local/bin:$PATH"
```

Do **not** use bare `spacetime start &` in agent shells — the process dies when the shell aborts. Use `ensure-local-spacetime.sh` / `ensure-seat-spacetime.sh` (`setsid -f` on Linux).

### Mac Studio

- Primary clone: `/Users/antbly/dev/fardel`
- Username: `antbly`
- Fish PATH lesson: ensure `fish_add_path ~/.local/bin` is active so `spacetime` resolves
- Tunnel: `cloudflared` → `dev-db.sparkify.dev` → local `:3000` ([DEPLOY.md](DEPLOY.md))
- Feel / FPS claims: verify on Mac or Pages, **not** box SwiftShader

### Client note

Unity WebGL is frozen on `checkpoint/unity-webgl`. Active client is Babylon under `web/`.

---

## 8. Day-to-day loop

```mermaid
flowchart LR
  Issues[GitHub Issues] --> Lead[Team Lead assign]
  Lead --> Seat[Dev/QA seat worktree]
  Seat --> PR[PR to develop + VE]
  PR --> Rev[Reviewer]
  Rev --> LeadMerge[Lead merge]
  LeadMerge --> Tip[Broadcast develop tip]
  Tip --> Issues
  LeadMerge --> Rel{Release greenlight?}
  Rel -->|yes| Cut[Release: main + Mac smoke + Pages]
```

### Step-by-step

1. **Lead** scans open Issues (priority, `lane:*`, open PRs, who is idle).
2. **Assign** one non-colliding ticket per idle Dev; serialize `lane:server` schema work.
3. **Seat** fetches latest `develop`, branches, implements, runs seat-local smokes + Vite `?ve=…`.
4. **Open PR** → `develop` with `Fixes #N` + force-added VE + embedded screenshot.
5. **Reviewer** reviews; author pushes fixes.
6. **Lead** merges, closes Issue, broadcasts tip SHA, asks open branches to rebase.
7. **QA Feel / QA Bugs** pick follow-on Issues (`feel`, `flake`) as assigned — not invent.

### Continuous iterate (Team Lead schedule)

Intent of the live `@every 15m` routine (conceptual; recreate on Mac/Grok CLI as needed):

1. Check open PRs into `develop`; nudge Reviewer if stalled; merge only when gate clears.
2. Unblock idle Devs/QA from Issues (no invent).
3. Prefer cloud coding agents for heavy edits when available; otherwise seat-local work.
4. Tell Antony only on real merges / blockers / release candidates (with screenshot when VE lands).
5. Stay quiet if nothing changed.
6. Never wipe non-local DBs.
7. **No idle seats:** if open Issues < idle Devs, file or ask Art to file the next visual/feel tickets and assign.
8. Third-party **art pack purchases** (paid itch/store kits) need Antony/Lead greenlight — shortlists and procedural polish do not.

---

## 9. Release loop (detail)

**Trigger:** Team Lead message naming the greenlit tip SHA and “cut now.”

**Release agent checklist:**

1. Confirm Reviewer + smokes on that tip (or Lead attestation).
2. Open PR `develop` → `main` (or fast-forward if policy allows) for the **pinned** SHA only.
3. On Mac: pull that tip at `/Users/antbly/dev/fardel`, publish local if needed, run critical smokes + quick Vite playpass.
4. Build `web/` → deploy Pages project for `play.sparkify.dev`.
5. Capture VE of live play (or Mac local if Pages lag).
6. Report: main SHA, Pages URL, smoke result, VE path, anything deferred to next cut.

If `develop` moved after greenlight, **do not** expand the cut unless Lead re-greenlights.

---

## 10. Hard-won orchestration learnings

Game-design learnings stay in [LEARNINGS.md](LEARNINGS.md). Orchestration-specific failure modes:

| Failure | Mitigation |
|---------|------------|
| Solo executor invents on `main` while a Dev has a `develop` PR (race) | Forbid solo invent while team loop is live; Lead stops duplicate streams |
| Agents re-ping already-merged PRs | Always `gh pr view` before nudge; Lead says STOP when looping |
| Auto-review / approval blocks merges or elevated Shell | Escalate honestly to Antony; never credential workarounds |
| Channel 6-member cap | Split **Fardel** vs **Fardel QA**; add **Fardel Art** when visuals need a standing room |
| Idle Devs + empty Issues board | Lead/Art must file Issues and assign — never “wait for inspiration” |
| Visual gap vs hordes/RS/WoW mood | Art owns north star (#31-style); Devs implement presentation Issues; pack **buy** is a human gate |
| Tip moves mid-rebase | `git fetch origin develop` before rebase; Lead broadcasts SHA after every merge |
| VE missing from PR (gitignore) | `git add -f ve/...` + embed in body as Done-when |
| Stale GitHub `CONFLICTING` / mergeable noise | Re-fetch base; rebase; reopen PR if GitHub lies |
| Parallel schema PRs | Serialize `lane:server` module edits |
| Release cut expands past greenlit tip | Pin SHA in the greenlight message; Release refuses silent expansion |
| Box FPS used as feel truth | QA Feel verifies on Mac / Pages |
| Spacetime dies with agent shell abort | `ensure-*-spacetime.sh` + detached/`setsid` |
| Fish can’t find `spacetime` on Mac | `fish_add_path ~/.local/bin` |
| Local publish schema drift | `--delete-data=always` **local only** |

---

## 11. Recreating on Mac Studio via Grok CLI

Goal: same loop, **no Grok Bot box**. Parent agent + subagents; Mac Studio filesystem is the shared computer.

### Mapping

| Bot world | Mac / Grok CLI world |
|-----------|----------------------|
| Unbound Team Lead chat | Parent Grok CLI agent (Team Lead persona) |
| CreateAgent teammates | Parent-created **subagents** (Dev1–5, QA Bugs, QA Feel, Reviewer, Release, Art) with the same charters as §2 |
| Shared Linux box `/workspace` | Mac Studio disk (e.g. under `/Users/antbly/dev/`) |
| `/workspace/fardel` | `/Users/antbly/dev/fardel` |
| `/workspace/wt/<seat>` | `/Users/antbly/dev/fardel-wt/<seat>` (suggested) |
| Channels Fardel / Fardel QA / Fardel Art | Parent group threads or CLI-equivalent rooms (respect 6-member style caps if any) |
| `@every 15m` Bot routine | Parent schedule / cron tick with the continuous-iterate prompt |
| Box VE / SwiftShader | Mac screenshots + Pages VEs |

### One-time Mac setup

1. Clone `antonybstack/fardel` to `/Users/antbly/dev/fardel` if missing.
2. Install toolchain: .NET 8+10, SpacetimeDB CLI 2.10, Node 22, `gh` authed as `antonybstack`, `cloudflared` for `dev-db` if needed.
3. Copy/adapt `tools/scripts/fardel-seats.env` so worktree paths point at `fardel-wt/<seat>` (keep **ports and DB names** identical for doc portability).
4. Create worktrees:

```bash
cd /Users/antbly/dev/fardel
git fetch origin
for s in dev1 dev2 dev3 dev4 dev5 qa-bugs qa-feel; do
  git worktree add "/Users/antbly/dev/fardel-wt/$s" -b "seats/$s" origin/develop || \
    git worktree add "/Users/antbly/dev/fardel-wt/$s" "seats/$s"
done
```

5. Parent creates subagents with descriptions copied from §2 (include seat path + ports + “wait for assign; no invent”).
6. Wire a 15-minute orchestration tick on the parent (same intent as §8 continuous iterate).

### Runtime rules on Mac

- Parent assigns from Issues; subagents work only in their worktree.
- Source `wt-env.sh` / ensure-seat scripts after path rewrite.
- Human still confirms: Pages deploy, any DB wipe, force-push, payment/secrets.
- Prefer Issues + PR links over long chat dumps when waking Antony.
- When Cloud Agents / remote coders are unavailable, seats edit locally on the Mac — same Done-when (smokes + VE).

### What “done” looks like after a port

- Idle Dev can receive `#N`, land a PR to `develop` with VE, get Reviewer + Lead merge, without touching the Bot box.
- Release can cut `main` and update `play.sparkify.dev` from the Mac after Lead greenlight.
- Continuous tick stays quiet when the board is idle.

---

## 12. Quick reference

### Merge gate

`Reviewer ✓` + `smokes green` + `VE if UI` + `Fixes #N` + `no schema collision` → **Lead merges to `develop`**

### Labels

`P0` `P1` `P2` · `lane:server` `lane:client` `lane:qa` `lane:release` `lane:art` · `feel` · `flake` · `wave`

### Branch prefixes

`dev1/`…`dev5/` · `client/` · `qa/` · `art/` · `chore/` · Release: `develop`→`main`

### Do not

- Invent without an Issue assign
- Leave Devs idle while the game still has open gaps (file Issues first)
- Open feature PRs to `main`
- Wipe non-local DBs
- Re-ping merged PRs
- Expand a release past the greenlit tip
- Treat box SwiftShader FPS as ship feel
- Purchase third-party art packs without Antony/Lead greenlight (shortlist only)

---

## 13. Art packs vs “purchases”

In this runbook, **purchase** means buying a **third-party art/asset pack** (itch.io, Unity/store kits, paid CC commercial packs) to replace procedural kitbash — see [ASSETS.md](ASSETS.md).

It does **not** mean shopping, subscriptions, or unrelated spend. Flow:

1. **Art** shortlists 1 env + 1 character pack (license + URL + web-budget fit) on an Issue.
2. **Antony or Lead** greenlights the buy (human gate).
3. Import + credits ledger land in the same PR as the assets.
4. Until then: procedural / kitbash presentation Issues (`lane:art` + `lane:client`) keep shipping.

## 14. Minimal assign template (copy/paste)


```text
Assign: #<N> <title>
Branch: <seat>/<slug> off develop @ <sha>
Seat: <slug> (ports/DB per TEAM_SEATS)
Done-when:
  - headless: <Smoke> green
  - VE: ?ve=<name> → ve/babylon-<name>.png (git add -f) + embed in PR
  - PR → develop with Fixes #<N>
No invent past this Issue. Rebase if tip moves.
```

---

*This document describes the live Bot team loop as of 2026-09-07 (includes Fardel Art + no-idle rule) and the intended Mac Studio / Grok CLI recreation. When process drifts, update this file in the same PR as the process change.*
