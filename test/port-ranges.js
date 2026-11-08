// Shared per-suite loopback port plan (PITFALLS #27/#39).
//
// Every suite owns a DISJOINT range and randomizes WITHIN it, so parallel
// suites can't collide — with each other OR with unrelated processes holding a
// specific port (NVIDIA's nvcontainer squatted 8970–8975 in a socket state
// netstat can't even see; a proxy client once held 9030 as an ephemeral outbound
// port). Keeping the table in ONE place means a new suite can't silently pick a
// range that overlaps an existing one.
//
// Layout (inclusive ranges):
//   ratelimit 8976–9025 · regression 9026 · smoke 9027–9060 · files 9200–9299
//   mediadir 9300–9399 · backup 9400–9449 · browser 9500–9549 · config 9550–9589
export const PORT_RANGES = {
  ratelimit: [8976, 9025],
  regression: [9026, 9026],
  smoke: [9027, 9060],
  files: [9200, 9299],
  mediadir: [9300, 9399],
  backup: [9400, 9449],
  browser: [9500, 9549],
  config: [9550, 9589],
};

const usedInProcess = new Set();

// A random port within the named suite's inclusive range, guaranteed unique
// within the current process so two servers in one suite never collide.
export function pickPort(suite) {
  const range = PORT_RANGES[suite];
  if (!range) throw new Error(`unknown test suite port range: ${suite}`);
  const [lo, hi] = range;
  const span = hi - lo + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const candidate = lo + ((start + i) % span);
    if (!usedInProcess.has(candidate)) {
      usedInProcess.add(candidate);
      return candidate;
    }
  }
  return lo + start;
}

// "lo-hi" label for docs/comments.
export function portRangeLabel(suite) {
  const range = PORT_RANGES[suite];
  if (!range) throw new Error(`unknown test suite port range: ${suite}`);
  return `${range[0]}-${range[1]}`;
}
