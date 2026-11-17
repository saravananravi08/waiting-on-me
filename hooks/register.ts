import type { Register } from 'claude-code'

// Fetches Linear through the Linear MCP server this Claude Code session is already
// signed in to, so no API key is needed. It only writes the raw results to a cache file;
// scripts/lib parses them, so the parsing is tested without a session. A hook script
// cannot call MCP tools, which is why this runs inside the session.

const CHECK_EVERY_MS = 60_000
const DEFAULT_INTERVAL_MIN = 5
const FILE = 'linear-mcp.json'
const FIND_ATTEMPTS = 10
const FIND_WAIT_MS = 4_000

type Block = { type?: string; text?: string }
type Reply = { content?: Block[]; isError?: boolean }

const textOf = (r: Reply): string => (r.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')

let busy = false

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

async function tick($: any, force: boolean) {
  if (busy) return
  busy = true
  try {
    const dir = await cacheDir($)
    const every = await intervalMs($, dir)
    if (!force) {
      try {
        const { mtimeMs } = await $.fs.stat(`${dir}/${FILE}`)
        if ((await $.clock.now()) - mtimeMs < every - 30_000) return // another session fetched recently
      } catch {
        // no file yet
      }
    }

    // MCP servers can finish connecting after the session starts, so look for a while.
    let found: RegExpExecArray | null | undefined
    for (let attempt = 0; attempt < FIND_ATTEMPTS && !found; attempt++) {
      if (attempt > 0) await $.clock.sleep(FIND_WAIT_MS)
      const names: string[] = (await $.tool.list()).map((t: { name: string }) => t.name)
      found = names.map(n => /^mcp__(.+?)__list_issues$/.exec(n)).find(m => m && /linear/i.test(m[1]))
      if (!found) $.ui.log(`waiting-on-me: no Linear MCP tools yet (${names.filter(n => n.startsWith('mcp__')).length} MCP tools listed)`, { to: 'debug' })
    }
    const record: Record<string, unknown> = { fetchedAt: new Date().toISOString() }
    if (!found) {
      record.error = 'no Linear MCP server is connected to this session'
    } else {
      const server = found[1]
      record.server = server
      const [issues, notes] = await Promise.allSettled([
        $.mcp.call(server, 'list_issues', { assignee: 'me', state: 'started', limit: 100, fields: ['title', 'url', 'updatedAt', 'status', 'statusType', 'createdBy'] }),
        $.mcp.call(server, 'get_notifications', { unreadOnly: true, limit: 50 }),
      ])
      for (const [key, r] of [['issues', issues], ['notifications', notes]] as const) {
        if (r.status === 'fulfilled' && !r.value.isError) record[key] = { text: textOf(r.value) }
        else record[key] = { error: String(r.status === 'fulfilled' ? textOf(r.value) : (r.reason as Error)?.message ?? r.reason).slice(0, 200) }
      }
    }
    await $.fs.write(`${dir}/${FILE}`, JSON.stringify(record))
    // Rebuild latest.json, the dashboard and the count with the new Linear data.
    await $.process.run(['node', `${$.plugin.root}/scripts/collect`, '--quiet'], { timeoutMs: 90_000 })
  } catch (err) {
    $.ui.log(`waiting-on-me: Linear fetch failed: ${(err as Error).message}`, { to: 'debug' })
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void tick($, true)
    $.clock.every(CHECK_EVERY_MS, () => tick($, false))
    return started
  })
}
