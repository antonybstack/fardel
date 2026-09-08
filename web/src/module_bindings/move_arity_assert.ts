// Compile-time guard: Move reducer bindings must expose dx, dz, jump (see #119).
// Included via tsconfig src; npm run build / tsc --noEmit fails if jump is missing.
import MoveReducer from "./move_reducer";

type MoveKeys = keyof typeof MoveReducer;
type AssertJump = "jump" extends MoveKeys ? true : never;
const _moveHasJump: AssertJump = true;
void _moveHasJump;

void MoveReducer.dx;
void MoveReducer.dz;
void MoveReducer.jump;
