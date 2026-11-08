// server/sqlite.js — zero-dependency synchronous SQLite adapter backed by
// Node.js built-in `node:sqlite` (DatabaseSync). Provides the subset of the
// better-sqlite3 API used across ProofPipe (.exec, .pragma, .prepare,
// .transaction, .close) without requiring native C++ compilation (node-gyp/make).
import { DatabaseSync } from 'node:sqlite';

const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('SQLite')) return;
  if (warning && typeof warning.message === 'string' && warning.message.includes('SQLite')) return;
  return origEmitWarning.call(this, warning, ...args);
};

const normalizeParam = (p) => (p === undefined ? null : p);

export default class Database {
  #db;
  #txDepth = 0;

  constructor(filename) {
    this.#db = new DatabaseSync(filename);
  }

  exec(sql) {
    this.#db.exec(sql);
    return this;
  }

  pragma(source, options) {
    if (!options?.simple && source.includes('=')) {
      this.#db.exec(`PRAGMA ${source}`);
      return undefined;
    }
    const stmt = this.#db.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (options?.simple) {
      if (!rows.length) return undefined;
      const val = Object.values(rows[0])[0];
      return typeof val === 'bigint' ? Number(val) : val;
    }
    return rows.map((r) => ({ ...r }));
  }

  prepare(sql) {
    const stmt = this.#db.prepare(sql);
    return {
      run: (...params) => {
        const info = stmt.run(...params.map(normalizeParam));
        return {
          changes: Number(info.changes),
          lastInsertRowid: Number(info.lastInsertRowid),
        };
      },
      get: (...params) => {
        const row = stmt.get(...params.map(normalizeParam));
        return row ? { ...row } : undefined;
      },
      all: (...params) => {
        const rows = stmt.all(...params.map(normalizeParam));
        return rows.map((r) => ({ ...r }));
      },
    };
  }

  transaction(fn) {
    return (...args) => {
      const depth = this.#txDepth++;
      const sp = `sp_${depth}`;
      this.#db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      try {
        const result = fn(...args);
        this.#db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          this.#db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
        } catch {}
        throw err;
      } finally {
        this.#txDepth--;
      }
    };
  }

  close() {
    this.#db.close();
  }
}
