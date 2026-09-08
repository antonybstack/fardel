# Mac Studio + Grok CLI portable runbook

How to recreate the **entire** Team Lead + Dev1–5 + QA Bugs + QA Feel + Reviewer + Release + Art orchestration loop on Antony's **Mac Studio** using **Grok Build / Grok CLI** (parent agent + subagents), with **no dependency on Grok Bot box**.

Related: [ORCHESTRATION.md](ORCHESTRATION.md) · [TEAM_SEATS.md](TEAM_SEATS.md) · [DEPLOY.md](DEPLOY.md)

---

## 1. Vision

Replace the Grok Bot Linux box (shared computer for Bot agents) with:

- **Mac Studio** at `/Users/antbly/dev/fardel` as the shared computer
- **Grok CLI parent agent** as Team Lead (unbound coordinator)
- **Grok CLI subagents** as Dev1–5, QA Bugs, QA Feel, Reviewer, Release, Art
- **Same roster, same process** as documented in [ORCHESTRATION.md](ORCHESTRATION.md)

Goal: Antony can run the full loop locally without touching the Bot box.

---

## 2. One-time Mac setup

### Prerequisites

1. **Clone repo** to Mac Studio:
   ```bash
   cd /Users/antbly/dev
   git clone https://github.com/antonybstack/fardel.git
   cd fardel
   git checkout develop
   ```

2. **Install toolchain:**
   - **.NET SDK 8 + 10:** Download from [dot.net](https://dot.net)
     ```bash
     # Verify
     dotnet --list-sdks
     # Should show 8.x and 10.x
     ```
   - **SpacetimeDB CLI 2.10.x:**
     ```bash
     curl -sSf https://install.spacetimedb.com | sh -s -- -y
     spacetime version install 2.10.0 --use -y
     # Add to PATH: ~/.local/bin
     ```
   - **Node 22.x:**
     ```bash
     # Via nvm or direct install
     node --version  # v22.x
     npm --version
     ```
   - **GitHub CLI authed:**
     ```bash
     brew install gh
     gh auth login
     # Authenticate as antonybstack
     ```
   - **Cloudflare tunnel (optional for dev-db):**
     ```bash
     brew install cloudflared
     # See DEPLOY.md for dev-db.sparkify.dev tunnel setup
     ```

3. **Configure git:**
   ```bash
   cd /Users/antbly/dev/fardel
   git config user.name "Antony Blyakher"
   git config user.email "antonyblyakher@gmail.com"
   ```

4. **Set environment variables (shared for all seats):**
   
   Add to `~/.zshrc` or `~/.bashrc` (or Fish equivalent):
   ```bash
   # Cloudflare VE upload token
   export CLOUDFLARE_API_TOKEN="<your-cloudflare-api-token>"
   
   # Ensure Spacetime CLI on PATH
   export PATH="$HOME/.local/bin:$PATH"
   
   # .NET (if needed)
   export DOTNET_ROOT="$HOME/.dotnet"
   export PATH="$DOTNET_ROOT:$PATH"
   ```

   **Important:** `CLOUDFLARE_API_TOKEN` must be set so all subagents can upload VE via `tools/scripts/ve-upload.sh`. Account ID `6ea5db25020bce6cbefd6c1cc999bef3` is hardcoded in the script.

5. **Create worktrees:**
   
   ```bash
   cd /Users/antbly/dev/fardel
   git fetch origin develop
   
   # Create seat worktrees
   for seat in dev1 dev2 dev3 dev4 dev5 qa-bugs qa-feel; do
     mkdir -p "/Users/antbly/dev/fardel-wt"
     git worktree add "/Users/antbly/dev/fardel-wt/$seat" -b "seats/$seat" origin/develop || \
       git worktree add "/Users/antbly/dev/fardel-wt/$seat" "seats/$seat"
   done
   ```

6. **Adapt seat env map:**
   
   Edit `tools/scripts/fardel-seats.env` to add Mac paths as defaults (or create a Mac-specific variant):
   
   ```bash
   # Original (box):
   # dev1|3001|5174|fardel-dev1|/workspace/wt/dev1
   
   # Mac variant (can conditionally detect OS or maintain two maps):
   # dev1|3001|5174|fardel-dev1|/Users/antbly/dev/fardel-wt/dev1
   ```
   
   Or keep the script logic but override `FARDEL_WT` paths in parent agent prompts.

---

## 3. Mapping Bot → Mac/Grok CLI

| Bot world | Mac / Grok CLI world |
|-----------|----------------------|
| Unbound Team Lead chat | **Parent Grok CLI agent** (Team Lead persona) |
| CreateAgent teammates (Dev1–5, QA, etc.) | **Parent-created subagents** with the same charters |
| Shared Linux box `/workspace` | Mac Studio disk `/Users/antbly/dev/` |
| `/workspace/fardel` (lead) | `/Users/antbly/dev/fardel` |
| `/workspace/wt/<seat>` | `/Users/antbly/dev/fardel-wt/<seat>` |
| Channels Fardel / Fardel QA / Fardel Art | Parent group threads or CLI-equivalent rooms (respect 6-member style caps if any) |
| `@every 15m` Bot routine | Parent schedule / cron tick with continuous-iterate prompt |
| Box VE / SwiftShader | Mac screenshots + Pages VEs |
| Box `CLOUDFLARE_API_TOKEN` in secrets | Mac `CLOUDFLARE_API_TOKEN` in parent/env (exported for all subagents) |

---

## 4. Parent agent (Team Lead) setup

The parent Grok CLI agent acts as **Team Lead** with the charter from [ORCHESTRATION.md § 2](ORCHESTRATION.md#2-roster-and-roles):

- Pick Issues from https://github.com/antonybstack/fardel/issues
- Assign idle seats (never leave Devs idle while open gaps exist)
- Broadcast `develop` tip SHAs after merge
- Merge PRs after Reviewer clears them
- Does **not** greenlight routine Release cuts (Release self-decides)
- Does **not** solo-invent on `main` while team is live
- Unsticks only P0 / non-local DB wipe scenarios

### Parent context / prompt

Include in the parent agent's persistent context:

```text
You are Team Lead for the Fardel MMORPG project.

**Role:** Coordinate Dev1–5, QA Bugs, QA Feel, Reviewer, Release, Art per ORCHESTRATION.md.

**Workspace:** /Users/antbly/dev/fardel (develop branch)

**Seats:**
- dev1–dev5: /Users/antbly/dev/fardel-wt/{dev1…dev5}
- qa-bugs: /Users/antbly/dev/fardel-wt/qa-bugs
- qa-feel: /Users/antbly/dev/fardel-wt/qa-feel
- lead (you): /Users/antbly/dev/fardel

**Ports/DBs:** See tools/scripts/fardel-seats.env.

**Your job:**
1. Scan open Issues: https://github.com/antonybstack/fardel/issues
2. Assign idle Dev/QA seats (one Issue per seat; serialize lane:server schema work)
3. Create subagents with seat charters when needed
4. Nudge Reviewer for stalled PRs
5. Merge PRs after Reviewer clears (Fixes #N + VE + smokes green + no schema collision)
6. Broadcast tip SHA after merge; ask open branches to rebase
7. File new Issues (or ask Art to file visual ones) when board is thin
8. Never leave seats idle
9. Do not greenlight Release cuts (Release self-decides)
10. Do not wipe non-local DBs without Antony's explicit approval

**Continuous iterate (conceptual @every 15m):**
- Check open PRs → nudge Reviewer if stalled → merge when clear
- Unblock idle Devs/QA from Issues
- Tell Antony only on real merges / blockers / release candidates (with VE)
- Stay quiet if nothing changed
- Never invent features solo on main while team is live

**Hard rules:**
- Assign only from GitHub Issues
- VE required for UI changes: https://ve.sparkify.dev/… (upload via tools/scripts/ve-upload.sh)
- Never ask Antony to sign into GitHub for VE
- No paid art packs (free OSS/CC0 or DIY only)
- CLOUDFLARE_API_TOKEN already set in env for ve-upload.sh

**Token budget / chat hygiene (hard):**
- Banned: "Ack" / "Copy" / "On it" / roster restates / replies to corrections
- `gh pr view <n>` before any PR ping; MERGED/CLOSED = silence forever
- Continuous-iterate: ~30m cadence, speak only on tip moves / assigns / merges / blockers (no roster restates)
- One bus message per fact; prefer Cloud Agents for heavy work
- End every status with `spend: light|med|heavy` self-estimate
- See ORCHESTRATION.md § 12 for full rules
```

---

## 5. Subagent charters (Dev1–Dev5)

When parent assigns a Dev seat, create a subagent with:

```text
You are Dev<N> for the Fardel project.

**Seat:** dev<N>
**Worktree:** /Users/antbly/dev/fardel-wt/dev<N>
**Ports:** Spacetime 300<N>, Vite 517<3+N>, DB fardel-dev<N>
**Assignment:** #<Issue> <title>

**Your job:**
1. Work only in your worktree (/Users/antbly/dev/fardel-wt/dev<N>)
2. Fetch latest develop, branch <seat>/<slug>
3. Implement the assigned Issue (Done-when from assign message)
4. Source tools/scripts/wt-env.sh dev<N> before running seat commands
5. Run tools/scripts/ensure-seat-spacetime.sh dev<N> to start your DB
6. Publish module: cd $FARDEL_WT/server && spacetime publish $FARDEL_DB -y --env local -s $FARDEL_SPACETIME_URI
7. Run headless smokes (dotnet run --project tools/<Smoke>)
8. Capture VE screenshot if UI change (?ve=<name> in Vite browser)
9. Upload VE: tools/scripts/ve-upload.sh <local.png> <pr>/<name>.png
10. Open PR → develop with:
    - Title: clear summary
    - Body: Fixes #<N>, Done-when checklist, VE embed https://ve.sparkify.dev/...
11. Rebase if develop tip moves (Lead will broadcast)
12. Do not invent past the assigned Issue
13. Do not PR to main
14. Do not use another seat's ports/DB

**Hard rules:**
- VE required for UI: upload to ve.sparkify.dev (never commit ve/*.png)
- Never ask Antony to sign into GitHub
- Smokes must pass before PR
- Commits as: Antony Blyakher <antonyblyakher@gmail.com>

**Token budget / chat hygiene (hard):**
- Banned: "Ack" / "Copy" / "On it" / replies to Lead corrections
- `gh pr view <n>` before any PR ping; MERGED/CLOSED = silence forever
- Max one status per SHA; fix Lead corrections silently
- End status with `spend: light|med|heavy`
- See ORCHESTRATION.md § 12 for full rules

**Repeat this pattern for dev1, dev2, dev3, dev4, dev5** with seat-specific paths/ports.

---

## 6. Subagent charters (QA Bugs, QA Feel)

### QA Bugs

```text
You are QA Bugs for the Fardel project.

**Seat:** qa-bugs
**Worktree:** /Users/antbly/dev/fardel-wt/qa-bugs
**Ports:** Spacetime 3011, Vite 5184, DB fardel-qa-bugs

**Your job:**
1. Smoke matrix, flake repros, regression Issues
2. Optional fix PRs as qa/<slug> → develop
3. File Issues for bugs (use .github/ISSUE_TEMPLATE/bug.yml)
4. Do not invent features
5. Run smokes in your worktree after sourcing tools/scripts/wt-env.sh qa-bugs
6. Verify green smoke bar for Release cuts when asked

**Hard rules:**
- Assign from Lead only
- No feature invent
- VE upload via ve-upload.sh if needed
- Token hygiene: `gh pr view <n>` before ping; no "Ack"; end status with `spend: light|med|heavy`
```

### QA Feel

```text
You are QA Feel for the Fardel project.

**Seat:** qa-feel
**Worktree:** /Users/antbly/dev/fardel-wt/qa-feel
**Ports:** Spacetime 3012, Vite 5185, DB fardel-qa-feel

**Your job:**
1. Feel / UX playtests on Mac or play.sparkify.dev
2. File feel Issues (use .github/ISSUE_TEMPLATE/feel.yml with feel label)
3. Mac/Pages FPS truth (not box SwiftShader)
4. Optional fix PRs as qa/<slug> → develop
5. Do not invent features

**Hard rules:**
- Mac or Pages for FPS/feel claims (not box)
- Assign from Lead only
- No feature invent
- One box automation attempt; if inconclusive, Mac/self-verify — no retry loops
- Freeze SHA: verify frozen SHA only; wait for PASS/FAIL ack before tip moves
- Token hygiene: `gh pr view <n>` before ping; no "Ack"; end status with `spend: light|med|heavy`
```

---

## 7. Subagent charter (Reviewer)

```text
You are Reviewer for the Fardel project.

**No dedicated worktree** (read-only role; can use lead worktree if needed).

**Your job:**
1. Review PRs targeting develop (Lead will ping you)
2. Check:
   - Correctness
   - Smoke coverage (headless must pass)
   - Schema collision risk (serialize lane:server module edits)
   - VE present for UI changes (https://ve.sparkify.dev/... must render HTTP 200 image/png)
3. Concrete feedback; do not merge (Lead merges)
4. VE bar: image URL must be ve.sparkify.dev, HTTP 200, renders in PR UI
5. Reject relative ve/ links, GitHub user-attachments for new work, raw.githubusercontent.com VE embeds, text placeholders

**Hard rules:**
- Do not own features or invent
- Do not push merges (Lead only)
- VE required for UI PRs: https://ve.sparkify.dev/...
- Token hygiene: `gh pr view <n>` before nudge; no "Ack"; end status with `spend: light|med|heavy`
```

---

## 8. Subagent charter (Release)

```text
You are Release for the Fardel project.

**Worktree:** /Users/antbly/dev/fardel (lead; or own clone if preferred)

**Your job (self-sufficient; no Lead greenlight needed):**
1. Decide cuts when ALL true:
   a. develop tip has Reviewer-cleared meaningful delta since main
   b. QA Bugs smokes green on that tip (or you document waive)
   c. No open P0 blockers on the tip
2. Pin concrete develop SHA
3. Open/merge PR develop → main for that SHA only (never expand mid-cut)
4. Mac smoke:
   - Pull tip at /Users/antbly/dev/fardel
   - Publish local if needed (spacetime publish fardel -y)
   - Run critical smokes + quick Vite playpass
5. Build + deploy:
   - cd /Users/antbly/dev/fardel/web
   - npm run build
   - Deploy web/dist to Cloudflare Pages project "fardel" → play.sparkify.dev
   - Verify live
6. Capture VE of live play (or Mac local)
7. Report to Lead / Fardel QA: main SHA, Pages URL, smoke result, VE path, defers

**Hard rules:**
- Self-decide cuts (no Lead gate)
- Pin SHA at cut start; refuse silent expansion
- One cut at a time
- Coordinate with Lead before non-local DB wipe
- Mac smoke at /Users/antbly/dev/fardel (not box)
- Token hygiene: `gh pr view <n>` before ping; no "Ack"; end status with `spend: light|med|heavy`
```

---

## 9. Subagent charter (Art)

```text
You are Art for the Fardel project.

**No dedicated worktree** (brief/docs role; may borrow Dev seat for spikes with Lead approval).

**Your job:**
1. Visual north star per ASSETS.md (hordes.io / RS / WoW readable fantasy)
2. Shortlist free OSS/CC0 packs (never paid)
3. File visual work Issues (use .github/ISSUE_TEMPLATE/ templates; add lane:art where useful)
4. Art-direction briefs for Devs
5. Art-clear on VE when Reviewer pings you
6. Look-language coherence

**Hard rules:**
- Do not invent gameplay features
- Do not propose paid packs (HARD forbidden by Antony)
- Do not flip Issue open/close or Fix numbers after Lead locked an assign
- Do not leave Devs idle (file visual Issues if board is thin)
- Free OSS/CC0 or original/procedural only
```

---

## 10. Issue assign → PR → Reviewer → merge flow (without Bot)

### 10.1. Lead assigns Issue

Parent agent (Team Lead) picks an Issue, selects an idle seat:

```text
Assign: #<N> <title>
Branch: <seat>/<slug> off develop @ <sha>
Seat: <slug> (ports/DB per TEAM_SEATS)
Done-when:
  - headless: <Smoke> green
  - VE: ?ve=<name> → ve-upload.sh → embed https://ve.sparkify.dev/...
  - PR → develop with Fixes #<N>
No invent past this Issue. Rebase if tip moves.
```

### 10.2. Seat implements

Subagent (Dev/QA):
1. `cd $FARDEL_WT` (e.g. `/Users/antbly/dev/fardel-wt/dev1`)
2. `git fetch origin develop && git checkout -b <seat>/<slug> origin/develop`
3. Implement
4. `source tools/scripts/wt-env.sh <seat>`
5. `tools/scripts/ensure-seat-spacetime.sh <seat>`
6. `cd server && spacetime publish $FARDEL_DB -y --env local -s $FARDEL_SPACETIME_URI`
7. Run smokes: `dotnet run --project tools/<Smoke>`
8. If UI: `cd ../web && npm run dev` → open `http://127.0.0.1:$FARDEL_VITE_PORT?ve=<name>` → capture screenshot
9. Upload VE: `tools/scripts/ve-upload.sh /tmp/screenshot.png <pr>/<name>.png`
10. Commit + push: `git add . && git commit -m "..." && git push -u origin <seat>/<slug>`
11. Open PR via `gh pr create --base develop --title "..." --body "Fixes #<N>\n\n![ve](https://ve.sparkify.dev/<pr>/<name>.png)"`

### 10.3. Reviewer reviews

Parent pings Reviewer subagent with PR link. Reviewer:
1. `gh pr view <pr-url>`
2. `gh pr checkout <pr-number>` (or read diff)
3. Check correctness, smoke coverage, VE presence/renderability
4. Comment feedback or approve
5. Do not merge

### 10.4. Lead merges

Parent (Team Lead):
1. `gh pr view <pr-number>` → confirm Reviewer clear + VE + smokes
2. `cd /Users/antbly/dev/fardel && git checkout develop && git pull origin develop`
3. `gh pr merge <pr-number> --squash` (or merge strategy per policy)
4. Broadcast tip SHA to open branches: "develop @ <new-sha>; rebase your branches"

---

## 11. VE upload on Mac (shared token)

All subagents inherit `CLOUDFLARE_API_TOKEN` from parent environment.

**Parent must set once:**
```bash
export CLOUDFLARE_API_TOKEN="<your-cloudflare-r2-edit-token>"
```

**Subagents call:**
```bash
tools/scripts/ve-upload.sh /tmp/screenshot.png <pr>/<name>.png
# Prints: https://ve.sparkify.dev/<pr>/<name>.png
```

**Fallback if subagent lacks token:**
- Capture to `/Users/antbly/dev/fardel-ve-capture/<pr>-<name>.png`
- Ping Lead (parent) to upload
- **Never ask Antony to sign into GitHub**

---

## 12. Release cut to play.sparkify.dev from Mac

When Release subagent decides criteria are met:

```bash
# At /Users/antbly/dev/fardel
cd /Users/antbly/dev/fardel
git fetch origin develop
git checkout develop
git pull origin develop

# Pin SHA
PIN_SHA=$(git rev-parse HEAD)

# Open PR develop → main (or fast-forward if allowed)
gh pr create --base main --head develop --title "Release: $PIN_SHA" --body "Pin: $PIN_SHA\n\nSmokes green. No P0s."

# After merge:
git checkout main
git pull origin main

# Smoke
./tools/scripts/ensure-local-spacetime.sh
(cd server && spacetime publish fardel -y --env local)
dotnet run --project tools/ConnectSmoke  # critical smokes

# Vite build
cd web
npm ci
npm run build

# Deploy to Cloudflare Pages
npx wrangler@4 pages deploy dist --project-name=fardel --branch main

# Verify live
open https://play.sparkify.dev

# Capture VE + report to Lead/Fardel QA
```

---

## 13. What human gates remain

Agents should **not** do without Antony's explicit approval:

1. **Non-local DB wipe:** `--delete-data` on tunnel / prod / non-127.0.0.1 DBs
2. **Force-push:** `git push --force` to develop or main
3. **Secrets rotation:** Cloudflare API token, GitHub PATs
4. **Payment/purchase:** Any asset pack, service, or tool requiring payment
5. **Repository settings:** Branch protection, webhooks, collaborators

Routine operations agents **can** do autonomously:

- Merge PRs after Reviewer clears
- Cut Release to play.sparkify.dev (local DB + Pages deploy)
- File Issues
- Upload VE to ve.sparkify.dev (R2 bucket)
- Rebase branches
- Run local smokes with `--delete-data=always` on `127.0.0.1` DBs

---

## 14. Continuous iterate implementation

Parent agent runs a conceptual `@every 15m` routine (adjust timing as needed):

```text
1. gh pr list --base develop --state open
2. For each open PR:
   - gh pr view <pr> --json reviews,mergeable,author
   - If Reviewer stalled >2 hours: ping Reviewer subagent
   - If Reviewer cleared + smokes green + VE present + no conflicts: merge
3. gh issue list --state open --label P0,P1
4. For each idle seat (no active subagent or assignment):
   - Pick highest-priority non-colliding Issue
   - Create/prompt subagent with assign message
5. If open Issues < idle Devs:
   - File new Issue or prompt Art to file visual ones
6. If merges happened:
   - Broadcast tip SHA to channels / open branches
7. Stay quiet if nothing changed
```

---

## 15. Jump / locomotion gating example (current truth)

From [ORCHESTRATION.md § 17](ORCHESTRATION.md#17-jump--locomotion-gating-example):

- **Feel Pages `?ve=jump` harness:** Automated jump physics test → can PASS
- **Manual Space input:** Real keyboard UX → can FAIL (e.g. focus-steal #127)

Pattern: harness/`?ve=` automated checks vs real input UX can diverge.

**Locomotion-done waits for:**
1. Feel harness pass (automated `?ve=jump`)
2. Post-#127 manual Space recheck (QA Feel on Mac or Pages)

This documents that `?ve=` tests are necessary but not sufficient for feel signoff.

---

## 16. How to file Issues (QA Bugs / Feel / Art)

### QA Bugs

Use `.github/ISSUE_TEMPLATE/bug.yml`:
- Title: `[bug] <short>`
- Repro steps (numbered)
- Expected vs actual
- Seat/env (e.g. local dev1, play.sparkify.dev)
- VE: select "Required" / "Helpful" / "Not needed"
- Evidence: optional links/logs; **do not** paste GitHub user-attachments for long-term VE (use ve.sparkify.dev)

### QA Feel

Use `.github/ISSUE_TEMPLATE/feel.yml`:
- Title: `[feel] <short>`
- Label: `feel` (auto-applied)
- Observation: what you noticed
- Priority: P0 (blocks feel) / P1 (friction) / P2 (polish)
- Context: scene/input/host (Mac or Pages)
- Screenshots/clips: **attach or link ve.sparkify.dev** (never rely on GitHub drag-drop alone for docs)
- Suggested direction: optional fix idea

### Art

Use `.github/ISSUE_TEMPLATE/feature.yml` or `bug.yml` as appropriate; add `lane:art` label:
- Title: `[art] <short>` or `[feat] <visual>`
- Done-when: clear checklist (e.g. "Hero tree silhouettes read at 8–20m under #39 fog")
- Lane: select `client` (for now; may add `art` option)
- Notes: link to ASSETS.md, mood refs, pack shortlist (free only)
- **Hard rule:** specify "free OSS/CC0 only" or "procedural DIY" — never propose paid packs

**Lead will assign** after Issue is filed — Art does not flip Issue open/close or assign self.

---

## 17. Done-when (port complete)

The Mac Studio + Grok CLI port is **done** when:

- [ ] Idle Dev can receive `#N` assign from parent, land a PR to `develop` with VE, get Reviewer + Lead merge, **without touching the Bot box**
- [ ] Release self-decides cuts and updates `play.sparkify.dev` from Mac when criteria met
- [ ] Continuous tick stays quiet when board is idle
- [ ] QA Bugs / QA Feel file Issues and optionally fix as assigned
- [ ] Art files visual Issues and art-clears VE when pinged
- [ ] Reviewer reviews PRs with concrete feedback (VE bar enforced)
- [ ] All VE uploaded to `ve.sparkify.dev` (no `ve/*.png` commits, no GitHub paste for new work)
- [ ] Parent broadcasts tip SHA after merge; open branches rebase
- [ ] No idle seats while open Issues exist

---

## 18. Token budget / chat hygiene (hard)

**Antony is under severe token spend pressure.** All subagents follow these rules or stop. See [ORCHESTRATION.md § 12](ORCHESTRATION.md#12-token-budget--chat-hygiene-hard) for full detail.

### Banned responses

- "Ack" / "Copy" / "On it" / "Standing by" / any reply to Lead corrections
- Roster restates

### Before any PR ping

`gh pr view <n>` — if MERGED/CLOSED: **silence forever** on that PR.

### Max one status per SHA

Once you report "PR up @ SHA" or "MERGE-READY @ SHA", do not send another status on that SHA unless blocked or asked.

### Spend self-estimate (required)

End every status/PR comment with:
```
spend: light   # short update
spend: med     # moderate detail
spend: heavy   # long or multi-turn
```

### Continuous-iterate

~30m cadence. Speak only on tip moves, assigns, merges, blockers. Quiet tick = no message.

### Prefer Cloud Agents

For heavy edits or multi-turn work, launch Cloud Agent instead of burning parent context.

---

**Violating these rules exhausts Antony's budget.**

---

## 19. Troubleshooting

### Spacetime CLI not found on Mac

**Symptom:** `spacetime: command not found`

**Fix (bash/zsh):**
```bash
export PATH="$HOME/.local/bin:$PATH"
```

**Fix (Fish):**
```fish
fish_add_path ~/.local/bin
```

### ve-upload.sh fails: CLOUDFLARE_API_TOKEN not set

**Symptom:** `CLOUDFLARE_API_TOKEN not set on this box — ping Lead`

**Fix:** Parent must export token before subagents run:
```bash
export CLOUDFLARE_API_TOKEN="<your-token>"
```

Subagents inherit from parent shell.

### Worktree already exists

**Symptom:** `fatal: 'fardel-wt/dev1' already exists`

**Fix:** Reuse existing worktree:
```bash
cd /Users/antbly/dev/fardel-wt/dev1
git fetch origin develop
git checkout seats/dev1  # or create if missing
```

### Spacetime port already in use

**Symptom:** `Error: Address already in use (os error 48)`

**Fix:** Kill stale process:
```bash
lsof -ti:3001 | xargs kill -9  # Replace 3001 with seat's port
```

Or use a different port (update `fardel-seats.env`).

### PR merge conflict (develop moved)

**Symptom:** GitHub reports conflicts

**Fix (in seat worktree):**
```bash
cd $FARDEL_WT
git fetch origin develop
git rebase origin/develop
# Resolve conflicts
git push --force-with-lease origin <branch>
```

Lead broadcasts tip SHA after merges — subagents should rebase when notified.

---

## 20. Differences from Bot box

| Aspect | Bot box | Mac Studio + Grok CLI |
|--------|---------|----------------------|
| Team Lead | Unbound Bot chat | Parent Grok CLI agent |
| Teammates | CreateAgent Bot teammates | Parent-created subagents |
| Shared computer | Linux `/workspace` | Mac `/Users/antbly/dev` |
| Channels | Grok Bot channels (6-member cap) | CLI parent orchestration (no channel cap, but respect 6-member style for clarity) |
| VE token | Box secrets → export to shell | Mac env var → inherited by subagents |
| `@every 15m` routine | Bot scheduled task | Parent conceptual tick (manual or cron) |
| Feel FPS truth | Mac or Pages (not box SwiftShader) | Mac or Pages (primary) |
| Release deploy | Box or Mac | **Mac only** (bot box optional) |

---

## 21. Quick reference

### Workspace paths

- Lead: `/Users/antbly/dev/fardel`
- Dev1: `/Users/antbly/dev/fardel-wt/dev1`
- Dev2: `/Users/antbly/dev/fardel-wt/dev2`
- Dev3: `/Users/antbly/dev/fardel-wt/dev3`
- Dev4: `/Users/antbly/dev/fardel-wt/dev4`
- Dev5: `/Users/antbly/dev/fardel-wt/dev5`
- QA Bugs: `/Users/antbly/dev/fardel-wt/qa-bugs`
- QA Feel: `/Users/antbly/dev/fardel-wt/qa-feel`

### Ports/DBs

See `tools/scripts/fardel-seats.env` (same as box; paths differ).

### Key commands (per seat)

```bash
# Load seat env
source tools/scripts/wt-env.sh <seat>

# Start seat DB
tools/scripts/ensure-seat-spacetime.sh <seat>

# Publish module
cd $FARDEL_WT/server
spacetime publish $FARDEL_DB -y --env local -s $FARDEL_SPACETIME_URI

# Run smoke
cd $FARDEL_WT
dotnet run --project tools/<Smoke>

# Vite dev
cd $FARDEL_WT/web
npm run dev
# Open http://127.0.0.1:$FARDEL_VITE_PORT?ve=<name>

# Upload VE
tools/scripts/ve-upload.sh <local.png> <pr>/<name>.png
```

### PR flow

```bash
# Open PR
gh pr create --base develop --title "..." --body "Fixes #<N>\n\n![ve](https://ve.sparkify.dev/...)"

# Check status
gh pr view <pr-number>

# Merge (Lead only)
gh pr merge <pr-number> --squash
```

---

*This runbook is the single source of truth for recreating Fardel orchestration on Mac Studio via Grok CLI. Update in the same PR as any Mac/CLI process changes.*
