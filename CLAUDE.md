# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"나만의 SOOP 확프" — a Manifest V3 Chrome extension for Soop (sooplive.com, formerly AfreecaTV). No bundler, no framework, no package.json: every file in `src/` is a plain script loaded directly by `manifest.json`. There is no build step.

## Commands

There is no build/lint/test tooling in this repo. Development loop:

- **Syntax-check a file after editing it**: `node --check src/<file>.js` (works for both classic scripts and the ES-module `background.js`/`soopLiveApi.js` on modern Node).
- **Validate manifest.json**: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`.
- **Manual test**: load unpacked at `chrome://extensions` (enable Developer mode → "압축해제된 확장 프로그램을 로드합니다" → select the repo root), then reload the extension after each change.
- **Background logs**: `chrome://extensions` → this extension's "service worker" link opens its DevTools console.
- **Content script logs** (panel, live monitor, etc.): open DevTools on the relevant `play.sooplive.com` tab.

## Architecture

### No bundler ⇒ shared JS world per content_scripts entry

Content scripts listed together in one `content_scripts` entry of `manifest.json` execute in the same isolated-world JS context on that page, so top-level `const`/`function` names in one file are visible to the others in the same entry and can collide. `content.js` and `songSearch.js` rely on this (deliberately share globals like `SongSearch`). Scripts that don't need to share state (`disableAutoPlay.js`, `hideBroadcastButton.js`, `liveMonitor.js`) are wrapped in an IIFE — keep doing this for new standalone content scripts.

`background.js` is the only ES module (`"type": "module"` in manifest) and is the only place that can `import` from `soopLiveApi.js`.

### Settings: one storage key, feature-gated

All configuration lives under a single `chrome.storage.local` key, `settings`, shaped as `{ features: { <featureName>: {...} } }`. Each feature object has at minimum `enabled: boolean`. This schema is intentionally duplicated (not shared via an imported module) as `DEFAULT_SETTINGS` in both `src/background.js` and `src/options.js` — when adding a new feature, update both, plus the corresponding UI block in `src/options.html`/`src/options.js` (a `.switch` toggle + optional fields, following the existing card markup).

Classic content scripts that gate a simple on/off feature (`disableAutoPlay.js`, `hideBroadcastButton.js`, and the panel init in `content.js`) do a lightweight one-off check instead of importing the full defaults:

```js
chrome.storage.local.get(['settings']).then(({ settings }) => {
  if (settings?.features?.<name>?.enabled === false) return; // default-on: undefined means enabled
  // ... run the feature
});
```

Follow this pattern for any new simple content-script toggle rather than pulling in `DEFAULT_SETTINGS`.

The extension icon has no `default_popup` (see `manifest.json`'s empty `action`), so `chrome.action.onClicked` in `background.js` opens the options page (`options_ui` in manifest, `open_in_tab: true`) instead.

### Live-monitor feature (background.js + soopLiveApi.js + liveMonitor.js)

This is the most involved subsystem. Key design points, in case they need to be extended:

- **All Soop API calls happen in `background.js`** (via `soopLiveApi.js`'s `isStreamerLive`/`getChannelBroad`, hitting `api-channel.sooplive.com`), never from content scripts — background/extension contexts get CORS-free fetches for `host_permissions` origins; content scripts don't (their fetch/XHR is bound by the *page's* origin for CORS, regardless of host_permissions). `soopLiveApi.js` is a minimal in-repo port of `GetChannelBroad` from the sibling project `../VOD-Master/src/.test/soop_api_standalone.js`; if more Soop API surface is needed later, that file is the source to port from (not a runtime dependency). The same CORS constraint is why the YouTube upload flow (below) does its actual `googleapis.com` requests in background too, not in `vodFileInfo.js`.
- **`chrome.alarms` (`liveCheck`, min. 1 minute — a Chrome-enforced floor)** drives periodic polling of registered streamers. `chrome.storage.session` holds the ephemeral `monitoredTabs: {tabId: streamerId}` map, which scopes "auto-managed" tabs. This is why `liveMonitor.js` always starts by asking background `liveMonitor:init` and does nothing if the answer is `monitored: false` — tabs the user opens manually are never touched.
- **The per-tick decision is level-triggered, not edge-triggered**: on every alarm tick, for each enabled streamer, the rule is simply "is live && has no open monitored tab" → open a tab. This single rule intentionally covers both the first time a stream goes live and recovery when a monitored tab was closed unexpectedly (crash, accidental close) while the stream was still live — no separate "previous state" bookkeeping needed.
- **Tabs are opened with a brief real focus, then handed back.** Soop's player does not appear to start streaming in a tab that's never been the active tab, so `runLiveCheck` creates the tab with `active: true`, remembers the previously-active tab, and `liveMonitor.js` detects true playback start (video `currentTime` advancing) and sends `liveMonitor:playbackStarted` so background can restore focus to the original tab (`FOCUS_RESTORE_FALLBACK_MS` is a safety timeout in case that signal never arrives). The video is muted (`muteVideo` in `liveMonitor.js`) as soon as it's found, precisely because this focus hand-off is real.
- **End-of-broadcast detection is deliberately two-step**, because "video stopped" is ambiguous (real end vs. network hiccup vs. being kicked): `liveMonitor.js` detects a stall/`ended`/`error` on the `<video>`, then asks background to re-check the live API on demand (`liveMonitor:checkStillLive`) rather than trusting the last polled state. Still live → `location.reload()` (capped by `MAX_RELOAD_ATTEMPTS`, counted in `sessionStorage` so the cap survives the reload). Actually offline → shows the countdown overlay and closes the tab (`liveMonitor:closeTab`) unless the user clicks "닫지 않기".

### YouTube upload (background.js + vodFileInfo.js)

Uploading video (`videos.insert`) needs OAuth 2.0, unlike the read-only `youtubeApiKey` used for song search — handled via `chrome.identity.getAuthToken`, which requires an `oauth2.client_id` in `manifest.json` registered in Google Cloud Console as a "Chrome Extension" OAuth client tied to this extension's (stable, path-derived) unpacked ID. `chrome.identity` is extension-context-only, so the token fetch happens in `background.js`.

The upload itself also has to happen in `background.js` for the CORS reason above, but the file the user picks lives in `vodFileInfo.js` (a content script, via a plain `<input type="file">` — extensions can't read arbitrary local paths). The two talk over a long-lived `chrome.runtime.connect({name: 'youtubeUpload'})` port. **`chrome.runtime` messaging (both `sendMessage` and `Port.postMessage`) is JSON-serialization only — not structured clone.** Neither a `File`/`Blob` nor a raw `ArrayBuffer`/`Uint8Array` survives the trip: a `File` arrives with `size` reading `undefined` (this first broke the feature with YouTube returning "Failed to parse Content-Range header" because the declared size was `undefined`), and an `ArrayBuffer` arrives as `{}` (this then broke it a second way — the byte count in `Content-Range` no longer matched the near-empty body Chrome actually sent, YouTube error: "There were 15 byte(s) in the request body. There should have been 8388608..."). The working fix: base64-encode binary data to a plain string before posting it, and decode it back into a `Uint8Array` on the other side (`arrayBufferToBase64`/`base64ToUint8Array`, both plain and dependency-free — `btoa`/`atob` are available in both a content script and a service worker). Concretely, the content script sends `{type:'start', title, description, privacy, playlistId, fileName, fileType, fileSize}` (primitives only) and then, once background replies `{type:'ready'}` (session created), streams the file over as a sequence of `{type:'chunk', data, start, end, isLast}` messages — `data` is `file.slice(start, end).arrayBuffer()` run through `arrayBufferToBase64`. Background PUTs each chunk (`Content-Range: bytes {start}-{end-1}/{totalSize}`) and replies `{type:'chunkAck'}` to pull the next one, so at most one chunk is ever in flight (backpressure) rather than the content script racing ahead and buffering the whole file. Progress (`{type:'progress', ratio}`) is derived from bytes confirmed by each chunk PUT; the final chunk's response is the finished `videos` resource, followed by `{type:'done', video, playlistError}` or `{type:'error', message}`. Reuse this base64-chunk pattern — never a raw File/Blob/ArrayBuffer — for any future feature moving large binary data through `chrome.runtime` messaging.

### Legacy/unused files

`src/popup.html`, `popup.js`, `styles.css`, `soopHandler.js`, `taskRunner.js`, `dummy.js` are **not referenced by `manifest.json`** — superseded by the in-page panel (`content.js`) and the options page. Don't extend them and don't assume they run; they're kept around but dead.

## Conventions

- UI copy, comments, and commit messages are in Korean; match that when editing existing files.
- Logging in the live-monitor subsystem is tagged `[LiveMonitor]` in both `background.js` and `liveMonitor.js` — keep using that tag for related additions so logs stay filterable.
