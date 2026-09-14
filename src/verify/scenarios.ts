// Deprecated: hand-written fixtures were replaced by real captured traffic.
//
// Verification now replays actual OpenClaw hook payloads recorded from a live
// gateway run (see `load-capture.ts`). Synthetic fixtures were removed because
// they encoded assumptions about the host span tree that real captures
// disproved, most importantly that each ReAct round has its own host span.
export {};
