// Shared browser utilities loaded across desktop workbench (/) and mobile PWA (/phone).
// Classic non-module script so it works cleanly in plain script tags & service-workerless pages.
const PPShared = (() => {
  function fmtBytes(n, { nullable = false, compactKb = false } = {}) {
    if (nullable && n == null) return '';
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return '0 B';
    if (compactKb) {
      if (b > 1048576) return `${(b / 1048576).toFixed(1)} MB`;
      if (b >= 1024) return `${Math.round(b / 1024)} KB`;
      return `${Math.round(b)} B`;
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log2(b) / 10));
    const v = b / 2 ** (10 * i);
    return `${i === 0 ? Math.round(v) : (v >= 100 ? Math.round(v) : v.toFixed(1))} ${units[i]}`;
  }

  function parseUtcMs(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
    const raw = String(ts);
    const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
    const ms = d.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  function fmtClock(ts) {
    const ms = parseUtcMs(ts);
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fmtShortDateTime(ts) {
    const ms = parseUtcMs(ts);
    if (!ms) return '';
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Multipart POST over XMLHttpRequest so callers receive real byte-level
  // upload progress events via `onProgress(pct)` (`-1` when lengthComputable is false).
  function xhrPost(url, formData, { timeoutMs = 0, onProgress } = {}) {
    if (typeof XMLHttpRequest !== 'function') {
      return fetch(url, { method: 'POST', body: formData }).then(async r => {
        const data = await r.json().catch(() => null);
        return {
          ok: r.ok,
          status: r.status,
          data,
          reason: data && data.error ? String(data.error) : '',
          json: async () => data || {},
        };
      });
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      if (timeoutMs > 0) xhr.timeout = timeoutMs;
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = e => {
          if (e.lengthComputable && e.total > 0) {
            onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
          } else {
            onProgress(-1);
          }
        };
      }
      xhr.onload = () => {
        let data = xhr.response;
        if (!data && xhr.responseText) {
          try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        }
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          data,
          reason: data && data.error ? String(data.error) : '',
          json: async () => data || {},
        });
      };
      xhr.onerror = () => reject(new Error('network'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.onabort = () => reject(new Error('aborted'));
      xhr.send(formData);
    });
  }

  return { fmtBytes, parseUtcMs, fmtClock, fmtShortDateTime, xhrPost };
})();
if (typeof self !== 'undefined') self.PPShared = PPShared;
