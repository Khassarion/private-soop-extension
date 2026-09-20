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

- **All Soop API calls happen in `background.js`** (via `soopLiveApi.js`'s `isStreamerLive`/`getChannelBroad`, hitting `api-channel.sooplive.com`), never from content scripts — background/extension contexts get CORS-free fetches for `host_permissions` origins; content scripts don't (their fetch/XHR is bound by the *page's* origin for CORS, regardless of host_permissions). `soopLiveApi.js` is a minimal in-repo port of `GetChannelBroad` from the sibling project `../VOD-Master/src/.test/soop_api_standalone.js`; if more Soop API surface is needed later, that file is the source to port from (not a runtime dependency).
- **`chrome.alarms` (`liveCheck`, min. 1 minute — a Chrome-enforced floor)** drives periodic polling of registered streamers. `chrome.storage.session` holds the ephemeral `monitoredTabs: {tabId: streamerId}` map, which scopes "auto-managed" tabs. This is why `liveMonitor.js` always starts by asking background `liveMonitor:init` and does nothing if the answer is `monitored: false` — tabs the user opens manually are never touched.
- **The per-tick decision is level-triggered, not edge-triggered**: on every alarm tick, for each enabled streamer, the rule is simply "is live && has no open monitored tab" → open a tab. This single rule intentionally covers both the first time a stream goes live and recovery when a monitored tab was closed unexpectedly (crash, accidental close) while the stream was still live — no separate "previous state" bookkeeping needed.
- **Tabs are opened with a brief real focus, then handed back.** Soop's player does not appear to start streaming in a tab that's never been the active tab, so `runLiveCheck` creates the tab with `active: true`, remembers the previously-active tab, and `liveMonitor.js` detects true playback start (video `currentTime` advancing) and sends `liveMonitor:playbackStarted` so background can restore focus to the original tab (`FOCUS_RESTORE_FALLBACK_MS` is a safety timeout in case that signal never arrives). The video is muted (`muteVideo` in `liveMonitor.js`) as soon as it's found, precisely because this focus hand-off is real.
- **End-of-broadcast detection is deliberately two-step**, because "video stopped" is ambiguous (real end vs. network hiccup vs. being kicked): `liveMonitor.js` detects a stall/`ended`/`error` on the `<video>`, then asks background to re-check the live API on demand (`liveMonitor:checkStillLive`) rather than trusting the last polled state. Still live → `location.reload()` (capped by `MAX_RELOAD_ATTEMPTS`, counted in `sessionStorage` so the cap survives the reload). Actually offline → shows the countdown overlay and closes the tab (`liveMonitor:closeTab`) unless the user clicks "닫지 않기".

### YouTube upload helper (vodFileInfo.js + background.js + youtubeStudio.js)

Uploading is done through **YouTube Studio's own uploader**, not the YouTube Data API. An earlier version used `videos.insert` (OAuth via `chrome.identity`, resumable upload streamed from the content script through background) and was removed: in practice it was noticeably slower end-to-end than uploading in Studio directly (both the transfer and the post-upload processing/checks, as observed), and per YouTube's API policy videos uploaded via `videos.insert` from an unverified API project are locked to private until the project passes an audit. Don't reintroduce the API route without weighing that.

Flow: the "유튜브에 업로드" button in `vodFileInfo.js` sends `{action:'youtubeStudio:open', title, description}` to background, which opens `https://www.youtube.com/upload` (redirects into Studio's upload dialog) in a new tab and stores the title/description in `chrome.storage.session` under `pendingStudioUploads[tabId]` (per-tab, so several upload tabs opened back-to-back don't get mixed up; cleaned on `tabs.onRemoved`). `youtubeStudio.js` (content script on `studio.youtube.com`) asks `youtubeStudio:init` and does nothing unless the answer is `pending: true` — same "only touch tabs we opened" gate as `liveMonitor.js`. It then polls for the title/description boxes **inside `ytcp-uploads-dialog` only** (the same boxes exist on the edit page of already-uploaded videos, so unscoped filling could overwrite a real video's title), fills them via `execCommand` (plain value assignment isn't picked up by Studio's Polymer bindings) and re-verifies a few times because Studio also auto-fills the title from the filename after the box appears. The file itself can't be handed over as bytes — `chrome.runtime` messaging is JSON-only (a `File` arrives with `size` undefined and an `ArrayBuffer` as `{}`; base64 strings are the only way to move bytes through it) — and a path string can't fill an `<input type="file">`. The working route is the File System Access API: `youtubeStudio.js` shows a banner button (a folder picker needs a user click) that lets the user grant the download folder once; the `FileSystemDirectoryHandle` is kept in the **Studio page origin's** IndexedDB (a handle can't cross between the extension's own pages and a content script's page). Then `tryAttach()` finds the file by exact name (`buildNameMatchers`: the name, Chrome's ` (n)` duplicate suffix, and Windows-illegal characters replaced by `_` — never partial matches, since `_1.mp4` vs `_10.mp4` would otherwise collide), builds a `File` from the handle, puts it into the dialog's file input via `DataTransfer` and dispatches `input`/`change`. Failure at any point (no permission, file not found, Studio not reacting) falls back to the user picking the mp4 manually. Chrome blocks the OS-default Downloads folder itself in the picker, hence the `downloadSubfolder` setting (relative to Chrome's download dir; `chrome.downloads` only accepts relative paths) — background applies it in `download:start`, and `findDownloadedFile()` also descends into that subfolder if a parent was connected. To match the file that was *actually* saved (Chrome sanitizes names and appends ` (1)` on duplicates), `download:start` records `pendingDownloads[downloadId]` in `chrome.storage.local` (not memory — the service worker can be killed during a long download) and `chrome.downloads.onChanged` writes the final basename to `downloadedFiles['{videoId}:{fileOrder}']` on completion; `vodFileInfo.js` passes that (plus Soop's original `file_name`) as `fileNames` to `youtubeStudio:open`. Beyond file attachment and title/description it also applies the saved options `settings.features.vodFileInfo.{youtubeNotForKids, youtubePlaylists, youtubeVisibility}` (edited in the options page; background passes them in the `youtubeStudio:init` response so defaults stay in one place): click the "not made for kids" radio, open the playlist dropdown, **wait for the account's playlists to actually load** (the popup opens empty and fills asynchronously — `waitForPlaylistRows` waits until rows appear and their count stops changing for `PLAYLIST_STABLE_MS`, and each name then gets a short extra grace `PLAYLIST_ROW_GRACE_MS` for batches that arrive later than that window; ticking immediately made every name "not found"), and tick each configured playlist **by exact name** (multi-select; no partial matching, so a similarly named playlist is never picked silently), then jump to the visibility step and click the configured radio. Each step runs independently via `safely()` — one failing doesn't block the others — and the banner shows ✓/✗ per step. The final Save click is deliberately left to the user.

The Studio selectors (the `*_SELECTORS` / `*_SELECTOR` / `VISIBILITY_*` constants at the top of `youtubeStudio.js` — title/description boxes, not-for-kids radio, playlist trigger/popup/done button, visibility radios and step badge) were written from memory of Studio's DOM and have not been verified against the live page — if auto-fill stops working, inspect the relevant element in the upload dialog (the banner's ✗ line says which step failed) and update those constants. The banner's "제목 복사"/"설명 복사" buttons are the manual fallback.

### Legacy/unused files

`src/popup.html`, `popup.js`, `styles.css`, `soopHandler.js`, `taskRunner.js`, `dummy.js` are **not referenced by `manifest.json`** — superseded by the in-page panel (`content.js`) and the options page. Don't extend them and don't assume they run; they're kept around but dead.

## Conventions

- UI copy, comments, and commit messages are in Korean; match that when editing existing files.
- Logging in the live-monitor subsystem is tagged `[LiveMonitor]` in both `background.js` and `liveMonitor.js` — keep using that tag for related additions so logs stay filterable.
