# KickLens — Stream Analyzer

A Chrome extension that gives you actual useful data on Kick.com channels. Viewer counts are boring — KickLens digs into engagement quality, moderation activity, and channel metadata that Kick doesn't surface anywhere in the UI.

---

## What it does

**Engagement Scoring**
Not all chat is equal. KickLens weights messages by effort so spam and emoji floods don't inflate your numbers. The score runs on a rolling 3-minute window relative to CCV, so it reads more like a hype meter than a raw counter.

| Message Type | Points |
|---|---|
| Emoji / symbol spam | 0.2 |
| 1–3 words | 1.0 |
| 4–7 words | 2.0 |
| 8+ words | 3.0 |

**Moderation Log**
Live feed of bans, timeouts, and deleted messages pulled straight from the WebSocket — including stuff AutoMod nukes before you'd ever see it.

**Profile Inspector**
Channel IDs, User IDs, verification status, slow mode settings, follower-only durations. Useful stuff that's buried or missing from the normal UI.

**Session Stats**
CCV, peak viewers, average viewers, messages per minute. All tracked locally for your current session.

**Raw WebSocket Debugger**
See the raw Pusher payloads coming in if you want to know exactly what Kick is sending.

**Bot Filtering**
Add bots to an exclusion list in settings so they don't skew your engagement numbers.

---

## How it works

KickLens hooks into Kick's Pusher connection (key: `32cbd69e4b950bf97679`) and listens on:
- `chatrooms.{id}.v2` — chat messages, bans, deletions
- `channel.{id}` — title updates, follower alerts

---

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension config, permissions, script declarations |
| `content.js` | The main script — WebSocket handling, analytics, UI injection |
| `styles.css` | Scoped styles for the modal and badges (doesn't touch Kick's CSS) |
| `settings.html/js` | Options page for managing the bot exclusion list |

---

## Installation

1. Clone or download the repo
2. Go to `chrome://extensions/`
3. Turn on **Developer Mode** (top-right)
4. Click **Load unpacked** and select the project folder
5. Open any Kick.com channel

---

## Usage

- **The badge** — shows live engagement rate next to the Follow button. Click it for the full analytics dashboard.
- **The icon** — magnifying glass opens the Profile Inspector and moderation log.
- **Settings** — right-click the extension icon → Options to manage your bot list.

---

Made by [StonedLoser](https://stonedloser.com/)
