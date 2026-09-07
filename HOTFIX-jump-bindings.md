# Hotfix: Regenerate web bindings for Jump feature

## Issue
Production `play.sparkify.dev` (main @ 1144c88) has broken WASD movement due to stale TypeScript bindings after PR #83/#93 added jump support.

## Root Cause
1. PR #83 (commit 794f517) added `jump: bool` parameter to C# `Move` reducer and `VelY`/`LastGroundedMicros` fields to `PlayerPose` table
2. PR #93 merged #83 to main @ 1144c88 **WITHOUT regenerating TypeScript client bindings**
3. Client code (`web/src/net/connection.ts:1449`) calls:
   ```typescript
   conn.reducers.move({ dx, dz, jump })
   ```
4. But generated `move_reducer.ts` at 1144c88 only schemas `{ dx, dz }` (missing `jump`)
5. Runtime type mismatch causes move calls to fail → users cannot move

## Fix Applied
PR #99 (commit 6e84c6d) regenerated the web module bindings:

### Changes:
- `web/src/module_bindings/move_reducer.ts`: Added `jump: __t.bool()`
- `web/src/module_bindings/player_pose_table.ts`: Added `velY` and `lastGroundedMicros` fields
- `web/src/module_bindings/types.ts`: Updated type exports
- Additional type fixes in `main.ts` and `humanoid.ts`

## Verification
✅ TypeScript compilation passes (`npm run build`)
✅ Move reducer signature matches server schema
✅ PlayerPose table includes vertical physics fields
✅ Jump feature now functional with proper client/server type alignment

## Release Notes
**Critical Fix:** Regenerated SpacetimeDB TypeScript bindings to restore WASD movement functionality after jump feature merge. Production deployment requires:
1. Merge this fix to `main`
2. Republish module on SpacetimeDB Studio if schema changed
3. Redeploy Pages client with updated bindings

## Related
- Fixes production bug reported at main @ 1144c88
- Related to PR #83 (Jump feature)
- Related to PR #93 (Release merge)
- Fixed in PR #99 (this fix, already on develop)
