// Chronological release history rendered by the What's New dialog in app.js.
// Keep this array ordered newest-first with `v<package.json version>` at index 0.
const PP_RELEASES = [
  {
    version: 'v1.27.0',
    date: '2026-11',
    headline: 'Liquid Glass Background & Panel Warp, Rim Refraction & Tactile Button Animations',
    changes: [
      {
        scope: 'server',
        title: 'Desktop Background & Panel Warp, Chromatic Rim Refraction, Water Ripples & Micro-Interactions',
        detail: 'Added an optical radial background displacement mesh & caustic pool (#pp-bg-warp) plus pointer-reactive Liquid Glass panel warping across .side, .workbench-card, .rail-card, and .modal-box (smooth rAF 3D tilt, hyperbolic corner shear, press rebound, and masked prismatic border refraction), alongside cached-rect --lgx/--lgy caustic highlights, water click ripples (.pp-ripple), and playful copy/send/rotate/sheen micro-interactions.',
      },
      {
        scope: 'phone',
        title: 'Phone PWA Background & Panel Warp, Touch Ripples, Tactile Icon Feedback & Notification Sheen',
        detail: 'Added the radial background warp canvas (.pp-bg-warp) plus elastic pointer/touch warping and rim refraction on .status-strip, .alt-btn, #outbox-info, and #more-menu.open, coordinate-accurate tap ripples (.pp-phone-ripple), send plane-launch motion, 90-degree rotate spin, copy confirmation pulses, and notification sheen sweeps (proofpipe-v41).',
      },
      {
        scope: 'extension',
        title: 'Popup & Floating Tray Panel Warp, Background Caustics, Click Ripples & Icon Spring Physics',
        detail: 'Added #pp-ext-warp background displacement in the popup plus smooth pointer-reactive panel warping, corner skew, press rebound, and chromatic rim lighting across popup cards (.qsend, .tabs, .ext-advanced, .item, .titem) and the Shadow-DOM floating tray (.panel and .fab) while keeping tile drag-and-drop neutral and crisp.',
      },
    ],
  },
  {
    version: 'v1.26.0',
    date: '2026-11',
    headline: 'Full-Stack Performance & Memory Optimization Sweep',
    changes: [
      {
        scope: 'server',
        title: 'Single-Pass Rotation, Bounded Thumbnail Queue, Indexed Queries & Parallel Cleanups',
        detail: 'Replaced double-encode buffer rotation with single-pass libvips autoOrient+rotate, added a bounded 3-worker thumbnail queue, cached async asset-stamped HTML, removed sync fs calls on hot routes, added composite SQLite indexes for text/file filtering, skipped unused /api/stats recent queries, batched file deletes in one transaction, and parallelized retention sweeps & media-dir moves. On the PC workbench, added DOM ID reconciliation for captures/files/messages, 24 MB PNG clipboard LRU caching with promise writes, 2-worker concurrent uploads, lightbox neighbor prefetching, debounced SSE stats refreshes, and compositor-layer reductions.',
      },
      {
        scope: 'phone',
        title: 'Zero-Reflow Touch Viewer, Bounded Blob LRU & Lean Outbox/PWA Sync',
        detail: 'Cached viewer stage bounds on touchstart/resize to eliminate 120Hz touchmove layout reads, capped fetched remote full-resolution blobs via a 4-item LRU cleared on close, released temporary tile canvas backing stores, checked IndexedDB keys without re-cloning multi-MB blobs during outbox flush, skipped empty queue scans, fixed trimRecent() multi-item pruning, eliminated duplicate SSE/visibility reloads, and removed heavy blur filters from scrollable chips.',
      },
      {
        scope: 'extension',
        title: 'Batched Host Discovery, SW Prefetch Bounding & Light DOM Traversal',
        detail: 'Batched idempotent GET/HEAD fallback origin discovery in groups of 6, capped service-worker media prefetch entries at 4 with immediate post-consume eviction, added popup PNG LRU caching and in-flight prefetch deduplication, removed eager 5x background full-image prefetches, cached filter search haystacks, switched shadow-host scanning to TreeWalker, and trimmed scrollable grid blur layers.',
      },
    ],
  },
  {
    version: 'v1.25.0',
    date: '2026-11',
    headline: 'Lightbox & Mobile Viewer Overhaul, Liquid Glass Swipe Toasts, Batch Selection, and Tray Quadrant Anchoring',
    changes: [
      {
        scope: 'server',
        title: 'Desktop Lightbox Zoom & Rotate, Capture Grid Multi-Select, Modal Focus Trap & Swipe Notification Dock',
        detail: 'Added Fit/100%/200% zoom, pan, persistent 90-degree CW rotation (POST /api/captures/:id/rotate), pixel dimensions, origin badges, Capture Grid multi-select batch deletion, keyboard Tab focus trapping with opener focus restore across modals, a non-blocking bottom-right Liquid Glass swipe-dismissible notification dock, initial loading skeletons, and a live connection-recovery banner while removing the duplicate sidebar Settings trigger.',
      },
      {
        scope: 'phone',
        title: 'Mobile Viewer HUD & Gestures, Swipe Notifications, Batch Selection, Composer & Offline Icon Sync',
        detail: 'Added a top viewer HUD with inline remote loading/retry, prev/next stage arrows, rotation-aware fit scaling, pinch-zoom, swipe-down dismiss, persistent Save rotation, multi-select batch Retry/Delete, composer char count & URL badge, Liquid Glass swipe-dismissible flash/undo banners, and offline service worker precaching for chevron icons (proofpipe-v37).',
      },
      {
        scope: 'extension',
        title: 'Floating Tray Quadrant Anchoring, Liquid Glass Page Toasts, Search & Recovery Actions',
        detail: 'Anchored the floating tray across all four viewport quadrants relative to the dragged FAB, upgraded in-page notifications to a non-blocking bottom-right Liquid Glass stack with swipe-to-dismiss and hover pause, and added live search filtering, Phone/PC origin badges, per-item delete buttons, Open Workbench shortcut, live auto-paste target indicator, and server recovery actions.',
      },
    ],
  },
  {
    version: 'v1.24.0',
    date: '2026-11',
    headline: 'Live Phone XHR Progress, Two-Way Extension Quick Send & Background Daemon',
    changes: [
      {
        scope: 'phone',
        title: 'Real byte-level upload progress for photos',
        detail: 'Upgraded photo uploads to XMLHttpRequest with xhr.upload.onprogress tracking so single and concurrent bursts stream real-time percentages into the Liquid Glass status wave.',
      },
      {
        scope: 'extension',
        title: 'Two-way Quick Send, tab screenshot & Liquid Glass UI',
        detail: 'Added an inline note/URL composer, one-click Tab Link sender, and visible-tab Screenshot capture to the extension popup, alongside dark Liquid Glass styling for the popup, in-page tray, and page toasts.',
      },
      {
        scope: 'server',
        title: 'Cross-platform background daemon CLI & Windows tray launcher',
        detail: 'Added scripts/daemon.js (start, stop, restart, status, logs, autostart), a zero-dependency Windows system tray monitor (scripts/tray.ps1), and ProofPipe.vbs for zero-console tray-only launch.',
      },
    ],
  },
  {
    version: 'v1.23.0',
    date: '2026-11',
    headline: 'Liquid Glass UX Overhaul, Safe Deletions, Two-Way Sync & Pre-Compiled SQL',
    changes: [
      {
        scope: 'server',
        title: 'Safe destructive actions, Undo snackbar & live XHR upload progress',
        detail: 'Added a confirmation modal for bulk wipes, a 5-second Undo snackbar for single deletions, full-window drag-and-drop overlay, hover photo actions, and live byte-level upload progress on the PC workbench.',
      },
      {
        scope: 'phone',
        title: 'Two-way capture gallery sync & full-screen text composer',
        detail: 'PC-origin captures now appear automatically in the phone gallery with a PC badge, accompanied by a labeled From your PC inbox strip and a minimal full-screen text editor.',
      },
      {
        scope: 'extension',
        title: 'Liquid Glass extension popup & collapsible advanced drawer',
        detail: 'Redesigned the Chrome extension popup with translucent glass cards, segmented pill tabs, and a collapsible drawer for port override and site button controls.',
      },
    ],
  },
  {
    version: 'v1.22.0',
    date: '2026-10',
    headline: '64 MP Full-Resolution Pipeline & Lossless Clipboard Encoding',
    changes: [
      {
        scope: 'server',
        title: '64 MP capture ceiling',
        detail: 'Raised the image probe limit to 64 MP (MAX_PIXELS) so 48 MP and 50 MP phone photos upload byte-for-byte without downscaling.',
      },
      {
        scope: 'phone',
        title: 'Resolution-preserving HEIC conversion',
        detail: 'Decoupled HEIC-to-JPEG format conversion from the optional 4096 px quality-reduction clamp so full-sensor photos keep every pixel when quality reduction is off.',
      },
      {
        scope: 'extension',
        title: 'Full-resolution PNG Worker encoding',
        detail: 'Removed the 8192 px clipboard clamp in toPng.js so tall scrolling screenshots copy 1:1 up to physical browser canvas limits.',
      },
    ],
  },
  {
    version: 'v1.21.0',
    date: '2026-09',
    headline: 'Bulk File Operations, Phone Sorting & In-Flight Decode Guards',
    changes: [
      {
        scope: 'server',
        title: 'In-flight sharp decode coordination',
        detail: 'Added beginFileRead and awaitFileIdle synchronization so deleting a capture immediately after upload waits for background thumbnail generation before unlinking.',
      },
      {
        scope: 'server',
        title: 'Batch file deletion',
        detail: 'Extended DELETE /api/files to accept an { ids } array and broadcast a single coalesced file-deleted SSE event.',
      },
      {
        scope: 'phone',
        title: 'Unified sort order & viewer rotation',
        detail: 'Added Newest, Oldest, and Name sorting across phone lanes plus 90-degree rotation inside the mobile pinch-zoom viewer.',
      },
    ],
  },
  {
    version: 'v1.20.0',
    date: '2026-08',
    headline: 'Full-Resolution Tray Dragging & Keyboard Direct Paste',
    changes: [
      {
        scope: 'extension',
        title: 'Byte-identical drag payloads from the p tray',
        detail: 'Upgraded hovered tray tiles to their stored original blob before dragstart and attached real MIME types so dragging into AI chats transfers untouched originals.',
      },
      {
        scope: 'extension',
        title: 'Ctrl/Cmd+Enter direct chat injection',
        detail: 'Added keyboard shortcut support in the in-page tray to run the staged synthetic paste pipeline directly into the page editor.',
      },
      {
        scope: 'extension',
        title: 'Largest-visible composer targeting',
        detail: 'Improved editor discovery to prefer the focused element or the largest visible contenteditable/textarea composer rather than the last DOM node.',
      },
    ],
  },
  {
    version: 'v1.18.0',
    date: '2026-07',
    headline: 'Browser-Targeted Auto-Paste & Pinned Extension Origin',
    changes: [
      {
        scope: 'server',
        title: 'Pinned chrome-extension CSRF origin',
        detail: 'Derived the exact 32-character extension ID from extension/manifest.json key so only the official ProofPipe extension passes mutation checks.',
      },
      {
        scope: 'extension',
        title: 'Multi-browser autoTarget routing',
        detail: 'Added browser-target matching so Chrome and Edge extensions only auto-paste when selected, with automatic fallback when the target browser has no active SSE client.',
      },
      {
        scope: 'server',
        title: 'Aggregated /api/settings bundle',
        detail: 'Combined all server settings into a single GET /api/settings payload and SSE broadcast frame.',
      },
    ],
  },
  {
    version: 'v1.15.0',
    date: '2026-05',
    headline: 'Bidirectional File Transfers, Auto-Inbox & ZIP Backups',
    changes: [
      {
        scope: 'server',
        title: '1 GB file transfer store & HTTP Range streaming',
        detail: 'Added /api/files and /file/:id with RFC 7233 byte-range support, dedicated token-bucket rate limiting, and automatic saving of phone files into data/inbox/.',
      },
      {
        scope: 'server',
        title: 'Live media directory relocation & transactional backups',
        detail: 'Added /api/media-dir for moving captures/files across drives with rollback on failure, and /api/backup for WAL-checkpointed archive exports.',
      },
      {
        scope: 'phone',
        title: 'Swipe-to-delete with deferred Undo snackbar',
        detail: 'Added downward swipe gestures on phone text and file chips with a 6-second undo window before committing server deletion.',
      },
    ],
  },
  {
    version: 'v1.10.0',
    date: '2026-03',
    headline: 'Idempotent Offline Queues & Automatic Port Discovery',
    changes: [
      {
        scope: 'phone',
        title: 'IndexedDB offline queues with deduplication keys',
        detail: 'Queued photos, files, and texts in IndexedDB when offline and attached client-generated dedupe_key tokens so retried uploads never create duplicates.',
      },
      {
        scope: 'extension',
        title: 'Two-stage loopback port discovery',
        detail: 'Added PPDiscovery.probeHosts to scan candidate ports in parallel and verify /api/version so custom PORT setups work without manual configuration.',
      },
      {
        scope: 'server',
        title: 'Age-based retention & 80% storage cap sweeps',
        detail: 'Added configurable retention days and storage cap thresholds that trim the oldest captures automatically on schedule and on upload.',
      },
    ],
  },
  {
    version: 'v1.0.0',
    date: '2026-01',
    headline: 'Initial Release: One-Tap Phone Capture to AI Chat Paste',
    changes: [
      {
        scope: 'server',
        title: 'Fastify + SQLite + sharp capture server',
        detail: 'Built the local LAN capture server storing untouched originals in data/captures/ with background 400 px thumbnail generation and instant SSE push.',
      },
      {
        scope: 'phone',
        title: 'Installable Mobile PWA & Web Share Target',
        detail: 'Created the /phone web app with one-tap camera shutter, two-way text chips, pinch-to-zoom gallery viewer, and Share-to-ProofPipe support.',
      },
      {
        scope: 'extension',
        title: 'MV3 offscreen SSE relay & staged synthetic paste',
        detail: 'Built the Chromium extension with an offscreen EventSource relay and non-bubbling-first synthetic ClipboardEvent dispatch into AI chat editors.',
      },
    ],
  },
];
if (typeof self !== 'undefined') self.PP_RELEASES = PP_RELEASES;
