// Google Meet only: report who is currently speaking, so remote transcript lines
// can carry a real name ("李明") instead of a generic label.
//
// This reads Meet's own UI, which is obfuscated and changes without notice, so
// every strategy below is best-effort and the whole thing degrades silently to
// "对方" when nothing matches. What it detects is written to the debug log, which
// is the first place to look if names stop appearing.

(function () {
  'use strict';

  if (!location.hostname.endsWith('meet.google.com')) return;

  let lastName = null;
  let lastSent = 0;

  // A participant tile is considered "speaking" when Meet marks it. Meet has
  // used several mechanisms over time; try them in order of reliability.
  function findSpeakerName() {
    // 1. Accessibility: Meet labels the active speaker in some layouts
    const aria = document.querySelector(
      '[aria-label*="正在讲话"], [aria-label*="is speaking"], [aria-label*="正在说话"]',
    );
    if (aria) {
      const n = nameFromTile(aria) || cleanAria(aria.getAttribute('aria-label'));
      if (n) return n;
    }

    // 2. Tiles carry a participant id; the speaking one gets a visual marker.
    //    We look for the animated "voice level" indicator inside a tile.
    for (const tile of document.querySelectorAll('[data-participant-id]')) {
      if (isTileSpeaking(tile)) {
        const n = nameFromTile(tile);
        if (n) return n;
      }
    }
    return null;
  }

  function isTileSpeaking(tile) {
    // Meet animates a small equaliser while someone talks. Its class names are
    // unstable, so key off structural/state hints rather than one fixed class.
    if (tile.querySelector('[data-is-speaking="true"]')) return true;
    if (tile.getAttribute('data-is-speaking') === 'true') return true;
    const marker = tile.querySelector('[class*="speaking"], [jsname][class*="wave"]');
    if (marker && marker.offsetParent !== null) return true;
    return false;
  }

  function nameFromTile(el) {
    const tile = el.closest?.('[data-participant-id]') || el;
    const named = tile.querySelector?.('[data-self-name]');
    if (named) {
      const v = named.getAttribute('data-self-name') || named.textContent;
      if (v && v.trim()) return v.trim();
    }
    // fall back to the tile's own label
    const label = tile.getAttribute?.('data-participant-id') ? tile.textContent : '';
    const line = (label || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
    return line && line.length <= 40 ? line : null;
  }

  function cleanAria(label) {
    if (!label) return null;
    const m = label.match(/^(.+?)\s*(正在讲话|正在说话|is speaking)/);
    return m ? m[1].trim() : null;
  }

  function tick() {
    let name = null;
    try { name = findSpeakerName(); } catch (e) { /* Meet DOM changed; stay quiet */ }

    const now = Date.now();
    // Report changes, plus a heartbeat so background can expire stale entries
    if (name !== lastName || now - lastSent > 5000) {
      lastName = name;
      lastSent = now;
      chrome.runtime.sendMessage({ type: 'meet-speaker', name, at: now }).catch(() => {});
    }
  }

  setInterval(tick, 700);
  tick();
})();
