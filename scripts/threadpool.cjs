// Preloaded via `node --require ./scripts/threadpool.cjs server.js` (npm start)
// so UV_THREADPOOL_SIZE is set BEFORE Node ever touches the libuv threadpool.
// UV_THREADPOOL_SIZE is read once at pool init: setting it inside server.js's
// module body is too late (the ESM graph and its imports are evaluated first).
// ProofPipe.bat exports the same variable before `node` for the double-click
// path. NOTE: there is no `--threadpool-size` CLI flag — passing one exits with
// "bad option"; the environment variable is the only supported mechanism.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';