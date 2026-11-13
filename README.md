# Claude Code Usage Status Bar

Shows your **Claude Code** subscription quota in the Cursor / VS Code status bar:

`Claude 5h 12% · 7d 41%`

Hover for reset countdowns. Click the status item (or run **Claude Usage: Refresh**) to refresh.

## Requirements

- [Claude Code](https://code.claude.com/) installed and logged in (`claude auth login`)
- A Claude Pro / Max (or similar) subscription that exposes OAuth usage windows
- Cursor or VS Code `^1.85.0`

The extension reads the local OAuth token from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`) and calls Anthropic’s usage endpoint — the same source Claude Code’s `/usage` uses. No separate API key.

## Install in Cursor

### From a VSIX (recommended)

```bash
npm install
npm run package
```

Then in Cursor: **Extensions** → `…` → **Install from VSIX…** → pick the generated `.vsix`.

Or from a terminal (adjust the path):

```bash
cursor --install-extension claude-code-usage-statusbar-0.1.1.vsix
```

The extension refreshes expired Claude Code OAuth tokens automatically (same flow as Claude Code). You should only need `claude auth login` again if the refresh token itself was revoked.

### From source (Extension Development Host)

```bash
npm install
npm run compile
```

Open this folder in Cursor/VS Code and press `F5` to launch an Extension Development Host.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeUsage.refreshIntervalSeconds` | `180` | Poll interval (minimum 60) |
| `claudeUsage.warningThreshold` | `60` | Warning color from this utilization % |
| `claudeUsage.errorThreshold` | `80` | Error color from this utilization % |
| `claudeUsage.showSevenDay` | `true` | Show 7-day window next to 5-hour |
| `claudeUsage.claudeDir` | `""` | Override Claude config dir (`~/.claude` by default) |
| `claudeUsage.statusBarPriority` | `100` | Status bar position priority |

## Commands

- **Claude Usage: Refresh** — force a fresh fetch
- **Claude Usage: Open Settings** — open this extension’s settings

## Privacy

- Credentials are read **locally** only.
- The access token is sent only to `api.anthropic.com` and (for refresh) `console.anthropic.com`.
- No telemetry. Multiple Cursor windows share a temp-file cache so they do not hammer the usage API.

## Notes

- The OAuth usage endpoint is **undocumented** and may change. On failure the last good reading stays on the status bar when available.
- HTTP 429 triggers exponential backoff (up to ~10 minutes).
- API-key-only accounts (no Claude.ai OAuth login) will not get subscription windows — run `claude auth login` with a subscription account.

## License

MIT
