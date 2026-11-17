'use strict';
// Network side: read-only calls to GitHub (via the gh CLI login) and Linear
// (GraphQL, key from the environment or ~/.config/waiting-on-me/env).
// Each fetcher resolves to { status, items, error?, warning?, parts? } and never throws.
//   status: ok | partial | failed | not-configured
const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');
const parse = require('./parse');

const GH_TIMEOUT_MS = 20000;
const LINEAR_TIMEOUT_MS = 15000;
const MAX_AUTHOR_LOOKUPS = 20;

function gh(args, secrets = []) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.code === 'ENOENT') return reject(new Error('the gh CLI is not installed or not on PATH'));
        if (err.killed) return reject(new Error('gh timed out'));
        const first = String(stderr || err.message).trim().split('\n')[0] || 'gh failed';
        reject(new Error(config.scrub(first, secrets).slice(0, 300)));
      }
    );
  });
}

const json = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} returned something that is not JSON`);
  }
};

const MY_PRS_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url updatedAt isDraft
        repository { nameWithOwner }
        reviewDecision
        latestReviews(first: 10) { nodes { state submittedAt author { login } } }
        reviews(last: 30, states: [CHANGES_REQUESTED, APPROVED, DISMISSED]) { nodes { state submittedAt author { login } } }
        reviewThreads(first: 50) {
          nodes { isResolved isOutdated comments(last: 1) { nodes { createdAt author { login } } } }
        }
      }
    }
  }
}`;

async function githubReviewRequested() {
  const out = await gh([
    'search', 'prs', '--review-requested=@me', '--state', 'open', '--limit', '100',
    '--json', 'number,title,url,author,updatedAt,createdAt,repository',
  ]);
  return parse.parseReviewRequested(json(out, 'gh search'));
}

async function githubMyPrs() {
  const me = (await gh(['api', 'user', '--jq', '.login'])).trim();
  if (!me) throw new Error('could not work out the GitHub login');
  const out = await gh(['api', 'graphql', '-f', `query=${MY_PRS_QUERY}`, '-f', `q=is:pr is:open author:${me} archived:false`]);
  return parse.parseMyPrs(json(out, 'gh graphql'), me);
}

async function githubNotifications() {
  const me = await gh(['api', 'user', '--jq', '.login']).then((t) => t.trim()).catch(() => '');
  const out = await gh(['api', 'notifications?all=false&per_page=50']);
  const list = json(out, 'gh notifications');
  if (!Array.isArray(list)) throw new Error('unexpected notifications output (not a list)');
  const wanted = list
    .filter((n) => n && ['mention', 'team_mention', 'review_requested'].includes(n.reason))
    .slice(0, MAX_AUTHOR_LOOKUPS);
  // The list does not say who is asking. Look at the latest comment, else the subject, best effort.
  const authors = {};
  await Promise.all(
    wanted.map(async (n) => {
      const url = (n.subject && (n.subject.latest_comment_url || n.subject.url)) || null;
      if (!url || !/^https:\/\/api\.github\.com\//.test(url)) return;
      try {
        const who = (await gh(['api', url, '--jq', '.user.login // empty'])).trim();
        if (who) authors[n.id] = who;
      } catch {
        // leave as unknown
      }
    })
  );
  return parse.parseNotifications(list, authors, me);
}

async function fetchGithub() {
  const parts = [
    ['review requests', githubReviewRequested],
    ['my pull requests', githubMyPrs],
    ['notifications', githubNotifications],
  ];
  const settled = await Promise.allSettled(parts.map(([, fn]) => fn()));
  const items = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failures.push({ part: parts[i][0], message: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
  });
  if (failures.length === 0) return { status: 'ok', items };
  const distinct = [...new Set(failures.map((f) => f.message))];
  const error =
    failures.length === parts.length && distinct.length === 1
      ? distinct[0]
      : failures.map((f) => `${f.part}: ${f.message}`).join('; ');
  return {
    status: failures.length === parts.length ? 'failed' : 'partial',
    items: failures.length === parts.length ? [] : items,
    error,
    parts: failures.map((f) => f.part),
  };
}

const LINEAR_QUERY = `query {
  viewer {
    id name
    assignedIssues(first: 100, orderBy: updatedAt, filter: { state: { type: { in: ["started"] } } }) {
      nodes { identifier title url updatedAt creator { name } state { name type } }
    }
  }
  notifications(first: 50) {
    nodes {
      id type createdAt readAt archivedAt
      actor { name }
      ... on IssueNotification { issue { identifier title url } comment { url } }
    }
  }
}`;

// Data fetched inside a running Claude Code session through its MCP connections.
// hooks/register.ts stores the raw replies; these read them. Returns null when there is no
// usable file (absent, unreadable, stale, or the feature is off), otherwise
// { status: 'ok'|'failed', items, error? }.
function readMcpFile(name, label, parser, env = process.env, now = Date.now()) {
  const p = config.paths(env);
  const file = require('path').join(p.cacheDir, name);
  let stat;
  let record;
  try {
    stat = fs.statSync(file);
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const maxAgeMs = Math.max(10, config.intervalMinutes(env) * 3) * 60 * 1000;
  if (now - Math.max(stat.mtimeMs, Date.parse(record.fetchedAt) || 0) > maxAgeMs) return null;
  if (record.off) return null;
  if (record.error) return { status: 'failed', items: [], error: `${label}: ${record.error}` };
  try {
    return { status: 'ok', items: parser(record) };
  } catch (err) {
    return { status: 'failed', items: [], error: config.scrub(`${label}: ${err.message}`).slice(0, 300) };
  }
}

const readLinearMcp = (env, now) => readMcpFile('linear-mcp.json', 'Linear through Claude', parse.parseLinearMcp, env, now);

// Slack nudges are optional: null means the source is simply left out.
const readSlackMcp = (env, now) => readMcpFile('slack-mcp.json', 'Slack through Claude', parse.parseSlackMcp, env, now);

// Claude's own Linear connection first (nothing to configure), then an API key if there is one.
async function fetchLinear(env = process.env, fetchImpl = globalThis.fetch) {
  const viaClaude = readLinearMcp(env);
  if (viaClaude && viaClaude.status === 'ok') return viaClaude;
  const viaKey = await fetchLinearApi(env, fetchImpl);
  if (viaKey.status === 'not-configured' && viaClaude) return viaClaude;
  return viaKey;
}

async function fetchLinearApi(env, fetchImpl) {
  const { key, warning } = config.loadLinearKey(env);
  if (!key) {
    return {
      status: 'not-configured',
      items: [],
      error: "Linear is not configured (no recent data from Claude's Linear connection, which only reports while a session is open, and no LINEAR_API_KEY)",
      warning,
    };
  }
  try {
    const res = await fetchImpl('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query: LINEAR_QUERY }),
      signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Linear rejected the API key (HTTP ${res.status})`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Linear returned HTTP ${res.status} with no JSON`);
    }
    if (body.errors && body.errors.length) {
      throw new Error(`Linear error: ${String(body.errors[0].message).slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`Linear returned HTTP ${res.status}`);
    return { status: 'ok', items: parse.parseLinear(body), warning };
  } catch (err) {
    const message = err && err.name === 'TimeoutError' ? 'Linear timed out' : err && err.message ? err.message : String(err);
    return { status: 'failed', items: [], error: config.scrub(message, [key]).slice(0, 300), warning };
  }
}

module.exports = { fetchGithub, fetchLinear, readLinearMcp, readSlackMcp, LINEAR_QUERY, MY_PRS_QUERY };
