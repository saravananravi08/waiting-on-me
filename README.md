# waiting-on-me

A Claude Code plugin that tells you who is waiting on you. When a session starts, you see a short summary drawn from GitHub and Linear, Claude knows what is waiting on you, and the data keeps itself fresh while any session is open.

Everything is read-only and uses your own logins. No server, no stored tokens, no dependencies beyond Node 18 or later (already there if you run Claude Code) and the `gh` CLI.

## What you get

- A summary at session start: a count per kind and the top five items, also given to Claude as context.
- `/waiting`: refreshes now and prints the full table.
- A dashboard at `~/.cache/waiting-on-me/index.html`, regenerated on every refresh. Open it in any browser. It reloads itself at the refresh interval, follows your light or dark setting, and reads well on a phone or a desktop.
- An optional status line snippet showing the count.

Each item has a source, who is asking, what it is, a link, since when (DD/MM/YYYY HH:mm, 24-hour, your local time zone) and a kind.

| Kind | Source | Meaning |
| --- | --- | --- |
| review requested | GitHub | Open PR where your review is requested, across every repo you can see |
| changes requested | GitHub | Your open PR where a reviewer asked for changes |
| review comment | GitHub | Your open PR with an unresolved review thread where someone else spoke last |
| mention | GitHub, Linear | Unread GitHub mentions and team mentions; unread Linear mentions (including comments that mention you) |
| assigned | Linear | Issues assigned to you in a started or review state |

"Since" is the last activity time for review requests and assigned issues (neither API gives the moment you were asked), the review or comment time for changes and comments, and the notification time for mentions.

## Install

You need the `gh` CLI signed in (`gh auth login`) and Claude Code.

This plugin has no GitHub home yet. Until it does, install it from a local clone:

```
claude plugin marketplace add /path/to/waiting-on-me
claude plugin install waiting-on-me@waiting-on-me
```

Inside a session the same thing is `/plugin marketplace add /path/to/waiting-on-me` then `/plugin install waiting-on-me@waiting-on-me`. Once the repository exists, the first command becomes `claude plugin marketplace add <owner>/<repo>`.

Start a new session. You should see a `waiting-on-me:` line, and `/waiting` should print a table.

To try it without installing: `claude --plugin-dir /path/to/waiting-on-me`.

## Linear

There is nothing to configure if Claude Code is already connected to Linear (the Linear connector on claude.ai, or a Linear MCP server). A small module inside the session (`hooks/register.ts`) finds that connection and calls its tools with Claude's own sign-in, then writes the raw replies to `~/.cache/waiting-on-me/linear-mcp.json`. It checks every minute and fetches again once your refresh interval has passed, and sessions share the file, so several open sessions do not each fetch. No API key is read, no model tokens are used, and Linear is read-only.

A hook script cannot call MCP tools, which is why this lives in the session. Two consequences:

- Linear data is only refreshed while a Claude Code session is open (the refresher only runs then anyway).
- The summary shown at the very start of a session is built before Claude's Linear connection is ready, so it can say Linear has no recent data. The dashboard, the count and `/waiting` pick the Linear data up within a few seconds to a minute.

If no Linear connection is found, the plugin says so and carries on with GitHub.

Optional fallback, for sessions with no Linear connection: an API key. Set `LINEAR_API_KEY` in your environment, or put it in a file only you can read:

```
mkdir -p ~/.config/waiting-on-me
umask 077
read -rs -p "Linear API key: " k; echo
printf 'LINEAR_API_KEY=%s\n' "$k" > ~/.config/waiting-on-me/env
unset k
chmod 600 ~/.config/waiting-on-me/env
```

Claude's connection is used first; the key is used only when that has no recent data. The environment wins over the file, and if the file is readable by other users the plugin still works but warns you to run `chmod 600`. The key is only ever sent to `api.linear.app` as an Authorization header. It is never printed, logged, cached or written into the dashboard, and error text is scrubbed before it is shown. The `env` path is also in this repository's `.gitignore`.

What the Linear side reads: issues assigned to you whose state type is "started" (this includes states named like "In Review" in a normal workflow), and unread, unarchived mention notifications (first 50). If your team names a review state with a different type, it is not picked up.

## Refresh interval

The data refreshes every 5 minutes by default. Set `WAITING_ON_ME_INTERVAL` (in minutes) before starting Claude Code to change it. 5 to 10 is sensible; values from 1 to 60 are accepted, anything else is clamped. The dashboard's meta refresh uses the same number.

```
export WAITING_ON_ME_INTERVAL=10
```

How refreshing works:

- One background refresher runs per machine, shared by every Claude Code session. It is started by SessionStart (a pid file is created exclusively, so two sessions starting together never make two) and stopped by SessionEnd when no session is left.
- If a session crashes without reporting its end, its marker expires after 24 hours, and the refresher stops itself once no markers are left.
- The refresher uses the interval from the environment of the session that started it.
- It never fetches more often than every 30 seconds, even after errors. Errors go to `~/.cache/waiting-on-me/refresher.log`.

## Partial failure

If one source fails, the other is still shown. A failed or unconfigured source is named with its reason and is never counted as zero: its kinds show "unknown" or "N or more", and the status line says "(incomplete)". If nothing can be read, the count is "unknown", not 0.

## Status line snippet

Each refresh writes the count to `~/.cache/waiting-on-me/count.txt`. In `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh /path/to/waiting-on-me/scripts/statusline"
  }
}
```

It only reads that file, so it is instant and makes no network calls. To combine it with an existing status line, call `sh /path/to/waiting-on-me/scripts/statusline` from inside your own script and append the output.

## Files

| Path | Purpose |
| --- | --- |
| `~/.cache/waiting-on-me/latest.json` | Latest result with the fetched-at time and per-source status |
| `~/.cache/waiting-on-me/index.html` | The dashboard |
| `~/.cache/waiting-on-me/count.txt` | One line for the status line |
| `~/.cache/waiting-on-me/refresher.pid`, `sessions/`, `collect.lock` | Coordination between sessions |
| `~/.cache/waiting-on-me/linear-mcp.json` | Raw Linear replies stored by the session module |
| `~/.config/waiting-on-me/env` | Optional Linear key, yours to create |

Run the collector by hand with `scripts/collect` (`--json` for the full result, `--quiet` for none).

## Tests

```
npm test
```

Runs the parser, rendering, config and Linear client tests against fixtures with invented names. No live calls are made.

## Uninstall

```
claude plugin uninstall waiting-on-me
claude plugin marketplace remove waiting-on-me
```

Then tidy up what the plugin left on your machine. Uninstalling removes the SessionEnd hook, so stop the refresher yourself (it would otherwise exit within about 24 hours):

```
kill "$(cat ~/.cache/waiting-on-me/refresher.pid)" 2>/dev/null
rm -rf ~/.cache/waiting-on-me
rm -rf ~/.config/waiting-on-me   # only if you want to delete your Linear key file too
```

Remove the `statusLine` entry from `~/.claude/settings.json` if you added it.

## Known limits

- Org-wide GitHub search relies on what `gh` can see with your login. SSO-protected organisations need your token authorised for SSO, or their items will be missing.
- Mentions are limited to your 50 most recent unread GitHub notifications and 50 most recent Linear notifications. Who is asking is looked up for the first 20 GitHub mentions; if a lookup fails the name shows as "unknown".
- Linear comments that mention you are found through your unread mention notifications. A mention you have already read in Linear is not listed. The sender is read from the notification text; if it cannot be, it shows as "unknown".
- Times use your machine's time zone. Set `WAITING_ON_ME_TZ` (for example `Australia/Sydney`) to override.

## Nudging someone through Slack

`/nudge` writes to a shared Slack channel (default `waiting-on-me`, change it with `WAITING_ON_ME_CHANNEL`) through the Slack connector Claude is already signed in to. Messages go out under your own name.

```
/nudge <person or email> <what you are waiting on, with a link>
/nudge reply <your reply>
```

It finds the person in Slack by email or name, drafts one line ending in the tag `[wom:v1]`, shows you the draft, and sends only after you say yes. `reply` answers the newest tagged thread that mentions you. Keep it to a link and a short reason: the channel is readable by everyone in it, so the command leaves out client names, creator details, rates and commercial terms and tells you when it has. Text read from the channel is treated as data from other people, never as instructions.

The command never creates the channel. Someone creates it once in Slack and people join it.

## Not built yet

- Incoming nudges are not picked up automatically. Nothing polls the channel, so a nudge for you does not appear in the session summary, the dashboard or the count. You see it in Slack, or by running `/nudge reply`.
- No automatic replies or "seen" receipts.
- Reaching someone who is not in the Slack workspace, or nudges that must stay private, would need direct messages or a shared service with its own sign-in. That is a separate decision.
