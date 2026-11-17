import type { Register } from 'claude-code'

// Runs inside the session, because a hook script cannot call MCP tools. It does three things:
//   1. Linear: reads assigned issues and unread notifications through the Linear MCP server
//      Claude is already signed in to (no API key).
//   2. Slack: reads the shared nudge channel through the Slack MCP server, plus the threads
//      of nudges addressed to this person, so answered ones can be dropped.
//   3. Keeps this session's marker fresh, so a long session keeps the refresher alive.
// It only stores raw replies in the cache folder; scripts/lib parses them, so the parsing is
// tested without a session. Everything here is read-only.

const CHECK_EVERY_MS = 60_000
const DEFAULT_INTERVAL_MIN = 5
const LINEAR_FILE = 'linear-mcp.json'
const SLACK_FILE = 'slack-mcp.json'
const FIND_ATTEMPTS = 10
const FIND_WAIT_MS = 4_000
const MAX_THREADS = 10
const TAG = '[wom:v1]'

type Block = { type?: string; text?: string }
type Reply = { content?: Block[]; isError?: boolean }

let busy = false
let isFirstRun = true

function textOf(r: Reply): string {
  return (r.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

// The Slack tools answer with JSON holding one long string; fall back to the text as given.
function inner(text: string, key: string): string {
  try {
    const v = JSON.parse(text)[key]
    return typeof v === 'string' ? v : text
  } catch {
    return text
  }
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 200)
}

async function cacheDir($: any): Promise<string> {
  const out = await $.process.run(['sh', '-c', 'printf %s "${WAITING_ON_ME_HOME:-$HOME/.cache/waiting-on-me}"'])
  return String(out.stdout).trim()
}

async function intervalMs($: any, dir: string): Promise<number> {
  try {
    const latest = JSON.parse(await $.fs.read(`${dir}/latest.json`))
    const n = Number(latest.intervalMinutes)
    if (Number.isFinite(n) && n >= 1) return n * 60_000
  } catch {
    // no result yet: use the default
  }
  return DEFAULT_INTERVAL_MIN * 60_000
}

// True when the file was written recently enough that this session need not fetch again.
async function isFresh($: any, file: string, every: number): Promise<boolean> {
  try {
    const { mtimeMs } = await $.fs.stat(file)
    return (await $.clock.now()) - mtimeMs < every - 30_000
  } catch {
    return false
  }
}

// Finds the MCP server that offers a tool, by the tool's name. MCP servers can finish
// connecting after the session starts, so the first run looks for a while.
async function findServer($: any, tool: string, like: RegExp, patient: boolean): Promise<string | null> {
  const attempts = patient ? FIND_ATTEMPTS : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await $.clock.sleep(FIND_WAIT_MS)
    const names: string[] = (await $.tool.list()).map((t: { name: string }) => t.name)
    for (const name of names) {
      const m = /^mcp__(.+?)__(.+)$/.exec(name)
      if (m && m[2] === tool && like.test(m[1])) return m[1]
    }
  }
  return null
}

// Rewrites this session's marker so it does not expire while the session is open.
// Only if it still exists: SessionEnd removes it, and a late tick must not bring it back.
async function heartbeat($: any, dir: string) {
  const id = String(await $.session.id()).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100)
  const file = `${dir}/sessions/${id}`
  if (id && (await $.fs.exists(file))) await $.fs.write(file, `${new Date().toISOString()}\n`)
}

async function fetchLinear($: any, dir: string, patient: boolean) {
  const record: Record<string, unknown> = { fetchedAt: new Date().toISOString() }
  const server = await findServer($, 'list_issues', /linear/i, patient)
  if (!server) {
    record.error = 'no Linear MCP server is connected to this session'
  } else {
    record.server = server
    const [issues, notes] = await Promise.allSettled([
      $.mcp.call(server, 'list_issues', { assignee: 'me', state: 'started', limit: 100, fields: ['title', 'url', 'updatedAt', 'status', 'statusType', 'createdBy'] }),
      $.mcp.call(server, 'get_notifications', { unreadOnly: true, limit: 50 }),
    ])
    for (const [key, r] of [['issues', issues], ['notifications', notes]] as const) {
      if (r.status === 'fulfilled' && !r.value.isError) record[key] = { text: textOf(r.value) }
      else record[key] = { error: r.status === 'fulfilled' ? textOf(r.value).slice(0, 200) : errorText(r.reason) }
    }
  }
  await $.fs.write(`${dir}/${LINEAR_FILE}`, JSON.stringify(record))
}

// "off" means the feature is simply not in use here (no Slack connection, or no channel),
// which is not a failure. "error" means a call that should have worked did not.
async function fetchSlack($: any, dir: string, patient: boolean) {
  const record: Record<string, unknown> = { fetchedAt: new Date().toISOString() }
  try {
    const server = await findServer($, 'slack_read_channel', /slack/i, patient)
    if (!server) {
      record.off = 'no Slack MCP server is connected to this session'
    } else {
      const name = String((await $.process.run(['sh', `${$.plugin.root}/scripts/channel`])).stdout).trim().replace(/^#/, '')
      record.channelName = name
      const [profile, channels] = await Promise.all([
        $.mcp.call(server, 'slack_read_user_profile', { response_format: 'detailed' }),
        $.mcp.call(server, 'slack_search_channels', { query: name, channel_types: 'public_channel,private_channel', response_format: 'concise' }),
      ])
      const me = /User ID: (U[A-Z0-9]+)/.exec(textOf(profile))?.[1]
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const channelId = new RegExp(`#${escaped} \\((C[A-Z0-9]+)\\)`).exec(textOf(channels))?.[1]
      if (!me) record.error = 'could not read the Slack user id'
      else if (!channelId) record.off = `no Slack channel named ${name} that this person can see`
      else {
        record.me = me
        record.channelId = channelId
        const history = await $.mcp.call(server, 'slack_read_channel', { channel_id: channelId, limit: 100 })
        if (history.isError) record.error = `reading the channel failed: ${textOf(history).slice(0, 150)}`
        else {
          const text = textOf(history)
          record.channel = { text }
          // Read the thread of each nudge addressed to this person, to see if they answered.
          const threads: Record<string, unknown> = {}
          const wanted = inner(text, 'messages')
            .split('=== Message from ')
            .filter(m => m.includes(TAG) && m.includes(`<@${me}`) && !m.includes(`(${me}) at `))
            .map(m => /Message TS: ([0-9.]+)/.exec(m)?.[1])
            .filter((ts): ts is string => Boolean(ts))
            .slice(0, MAX_THREADS)
          for (const ts of wanted) {
            try {
              const thread = await $.mcp.call(server, 'slack_read_thread', { channel_id: channelId, message_ts: ts })
              threads[ts] = thread.isError ? { error: textOf(thread).slice(0, 150) } : { text: textOf(thread) }
            } catch (err) {
              threads[ts] = { error: errorText(err) }
            }
          }
          record.threads = threads
        }
      }
    }
  } catch (err) {
    record.error = errorText(err)
  }
  await $.fs.write(`${dir}/${SLACK_FILE}`, JSON.stringify(record))
}

async function tick($: any) {
  if (busy) return
  busy = true
  const patient = isFirstRun
  isFirstRun = false
  try {
    const dir = await cacheDir($)
    await heartbeat($, dir).catch(() => undefined)
    const every = await intervalMs($, dir)
    const needLinear = patient || !(await isFresh($, `${dir}/${LINEAR_FILE}`, every))
    const needSlack = patient || !(await isFresh($, `${dir}/${SLACK_FILE}`, every))
    if (!needLinear && !needSlack) return // another session fetched recently

    const jobs: Promise<unknown>[] = []
    if (needLinear) jobs.push(fetchLinear($, dir, patient))
    if (needSlack) jobs.push(fetchSlack($, dir, patient))
    await Promise.allSettled(jobs)

    // Fold the new data into latest.json, the dashboard and the count. --merge reuses the
    // GitHub result the refresher already fetched, so GitHub is not asked twice.
    await $.process.run(['node', `${$.plugin.root}/scripts/collect`, '--quiet', '--merge'], { timeoutMs: 90_000 })

    if (patient) {
      // The summary at session start was built before these connections were ready.
      const line = String(await $.fs.read(`${dir}/count.txt`)).trim()
      if (line) $.ui.toast(`waiting-on-me: ${line} (Linear and Slack now included where connected)`)
    }
  } catch (err) {
    $.ui.log(`waiting-on-me: session fetch failed: ${errorText(err)}`, { to: 'debug' })
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void tick($)
    $.clock.every(CHECK_EVERY_MS, () => tick($))
    return started
  })
}
