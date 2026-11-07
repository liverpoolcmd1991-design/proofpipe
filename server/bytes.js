// server/bytes.js — centralized byte counters for /api/stats.
// Previously `let bytesTotal` / `let bytesTotalFiles` were module globals in
// server.js that routes mutated ad hoc (`+= size`, `-= cap.bytes`, bare
// reassigns), which let them drift from the DB until the next boot re-sync.
// All increments, decrements and re-assigns now go through this one object, and
// a periodic re-sync from the DB (hook it up in server.js) catches any residual
// drift mid-run instead of waiting for a reboot.
let total = 0;      // captures (original + thumbnail) bytes
let totalFiles = 0; // transfer-file bytes
export const bytes = {
  get total() { return total; },
  get files() { return totalFiles; },
  add(n) { if (Number.isFinite(n) && n > 0) total += n; },
  addFiles(n) { if (Number.isFinite(n) && n > 0) totalFiles += n; },
  sub(n) { if (Number.isFinite(n) && n > 0) total = Math.max(0, total - n); },
  subFiles(n) { if (Number.isFinite(n) && n > 0) totalFiles = Math.max(0, totalFiles - n); },
  // absolute re-sync from the DB (boot and the periodic reconcile)
  set(value) { if (Number.isFinite(value) && value >= 0) total = value; },
  setFiles(value) { if (Number.isFinite(value) && value >= 0) totalFiles = value; },
};