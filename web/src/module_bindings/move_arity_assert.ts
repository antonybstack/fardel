// Compile-time guard: Move reducer bindings must expose dx, dz, jump (see #119).
// Also guard PlayerPose vertical fields velY / lastGroundedMicros (see #166).
// Included via tsconfig src; npm run build / tsc --noEmit fails if fields are missing.
import MoveReducer from "./move_reducer";
import type { PlayerPose } from "./types";

type MoveKeys = keyof typeof MoveReducer;
type AssertJump = "jump" extends MoveKeys ? true : never;
const _moveHasJump: AssertJump = true;
void _moveHasJump;

void MoveReducer.dx;
void MoveReducer.dz;
void MoveReducer.jump;

type PoseKeys = keyof PlayerPose;
type AssertVelY = "velY" extends PoseKeys ? true : never;
type AssertLastGrounded = "lastGroundedMicros" extends PoseKeys ? true : never;
const _poseHasVelY: AssertVelY = true;
const _poseHasLastGrounded: AssertLastGrounded = true;
void _poseHasVelY;
void _poseHasLastGrounded;
