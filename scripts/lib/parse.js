'use strict';
// Pure parsing: raw API output in, normalised items out. No network, no files.
//
// Item shape:
//   { source: 'github'|'linear'|'slack', kind, who, title, ref, url, since }
// kind is one of: nudge, changes requested, review requested, review comment, mention, assigned.
// since is an ISO 8601 string (formatted for people at render time).

const KINDS = ['nudge', 'changes requested', 'review requested', 'review comment', 'mention', 'assigned'];

// Which sources can supply which kind. Used so a failed or unconfigured
// source is never shown as a confident zero.
const KIND_PROVIDERS = {
  nudge: ['slack'],
  'changes requested': ['github'],
  'review requested': ['github'],
  'review comment': ['github'],
  mention: ['github', 'linear'],
  assigned: ['linear'],
};

const GITHUB_NOTIFICATION_REASONS = {
  review_requested: 'review requested',
  mention: 'mention',
  team_mention: 'mention',
};

function login(user) {
  return (user && user.login) || 'unknown';
}

// gh search prs --review-requested=@me --state open --json number,title,url,author,updatedAt,repository
function parseReviewRequested(prs) {
  if (!Array.isArray(prs)) throw new Error('unexpected review-request output (not a list)');
  // A draft is not ready for review, so it is not waiting on anyone yet.
  return prs.filter((pr) => pr && pr.isDraft !== true).map((pr) => ({
    source: 'github',
    kind: 'review requested',
    who: login(pr.author),
    title: pr.title || '(untitled)',
    ref: `${(pr.repository && pr.repository.nameWithOwner) || 'unknown'}#${pr.number}`,
    url: pr.url,
    since: pr.updatedAt || pr.createdAt,
  }));
}

// GitHub's latestReviews can come back empty while the decision is CHANGES_REQUESTED, so
// the review history is read as well. For each reviewer the latest review that is not a
// plain comment decides; those still asking for changes are returned, newest first.
function reviewersAskingForChanges(pr) {
  const decisive = new Set(['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED']);
  const all = [
    ...((pr.latestReviews && pr.latestReviews.nodes) || []),
    ...((pr.reviews && pr.reviews.nodes) || []),
  ].filter((r) => r && decisive.has(r.state));
  const byAuthor = new Map();
  for (const r of all) {
    const key = (r.author && r.author.login) || 'unknown';
    const prev = byAuthor.get(key);
    if (!prev || Date.parse(r.submittedAt) > Date.parse(prev.submittedAt)) byAuthor.set(key, r);
  }
  return [...byAuthor.values()]
    .filter((r) => r.state === 'CHANGES_REQUESTED')
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
}

// GraphQL search of my open PRs. Emits "changes requested" when the review
// decision says so, and "review comment" when someone else has the last word
// in an unresolved review thread.
function parseMyPrs(response, myLogin) {
  const nodes = response && response.data && response.data.search && response.data.search.nodes;
  if (!Array.isArray(nodes)) throw new Error('unexpected pull request response');
  const items = [];
  for (const pr of nodes) {
    if (!pr || !pr.url) continue;
    const ref = `${(pr.repository && pr.repository.nameWithOwner) || 'unknown'}#${pr.number}`;

    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      const asking = reviewersAskingForChanges(pr);
      const latest = asking[0];
      items.push({
        source: 'github',
        kind: 'changes requested',
        who: latest ? login(latest.author) : 'unknown',
        title: pr.title,
        ref,
        url: pr.url,
        since: (latest && latest.submittedAt) || pr.updatedAt,
      });
    }

    const waiting = [];
    for (const t of (pr.reviewThreads && pr.reviewThreads.nodes) || []) {
      if (!t || t.isResolved || t.isOutdated) continue;
      const last = t.comments && t.comments.nodes && t.comments.nodes[0];
      if (!last || !last.author) continue;
      if (myLogin && last.author.login === myLogin) continue;
      waiting.push(last);
    }
    if (waiting.length > 0) {
      waiting.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const people = [...new Set(waiting.map((c) => c.author.login))];
      const n = waiting.length;
      items.push({
        source: 'github',
        kind: 'review comment',
        who: people.slice(0, 3).join(', ') + (people.length > 3 ? ' and others' : ''),
        title: `${pr.title} (${n} open ${n === 1 ? 'thread' : 'threads'})`,
        ref,
        url: pr.url,
        since: waiting[0].createdAt,
      });
    }
  }
  return items;
}

// Maps an API URL to the page a person opens.
//   https://api.github.com/repos/o/r/pulls/12  ->  https://github.com/o/r/pull/12
function apiUrlToHtml(apiUrl, repoFullName) {
  const fallback = repoFullName ? `https://github.com/${repoFullName}` : 'https://github.com/notifications';
  if (typeof apiUrl !== 'string') return fallback;
  const m = apiUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/?#]+)/);
  if (!m) return fallback;
  const seg = { pulls: 'pull', issues: 'issues', commits: 'commit' }[m[2]];
  return `https://github.com/${m[1]}/${seg}/${m[3]}`;
}

// notifications: GET /notifications (unread). authors: { [notificationId]: login }
// fetched separately, since the list does not say who is asking.
// me: my own login. A mention on a thread where I wrote the latest comment is dropped:
// I have already answered, so nobody is waiting on me there.
function parseNotifications(list, authors = {}, me = '') {
  if (!Array.isArray(list)) throw new Error('unexpected notifications output (not a list)');
  const items = [];
  for (const n of list) {
    const kind = GITHUB_NOTIFICATION_REASONS[n && n.reason];
    if (!kind || n.unread === false) continue;
    if (kind === 'mention' && me && authors[n.id] === me) continue;
    const repo = n.repository && n.repository.full_name;
    const subject = n.subject || {};
    const number = typeof subject.url === 'string' ? subject.url.match(/\/(\d+)$/) : null;
    items.push({
      source: 'github',
      kind,
      who: authors[n.id] || 'unknown',
      title: subject.title || '(untitled)',
      ref: repo ? (number ? `${repo}#${number[1]}` : repo) : 'unknown',
      url: apiUrlToHtml(subject.url, repo),
      since: n.updated_at,
    });
  }
  return items;
}

const LINEAR_NOTIFICATION_KINDS = [
  [/mention/i, 'mention'],
];

// response: the data of the Linear GraphQL call
//   { data: { viewer: { assignedIssues: { nodes } }, notifications: { nodes } } }
function parseLinear(response) {
  const data = response && response.data;
  if (!data || !data.viewer) throw new Error('unexpected Linear response');
  const items = [];

  const issues = (data.viewer.assignedIssues && data.viewer.assignedIssues.nodes) || [];
  for (const issue of issues) {
    if (!issue) continue;
    const state = issue.state || {};
    const reviewState = /review/i.test(state.name || '');
    if (state.type !== 'started' && !reviewState) continue;
    if (state.type === 'completed' || state.type === 'canceled') continue;
    items.push({
      source: 'linear',
      kind: 'assigned',
      who: (issue.creator && issue.creator.name) || 'unknown',
      title: issue.title,
      ref: issue.identifier,
      url: issue.url,
      since: issue.updatedAt,
    });
  }

  const notes = (data.notifications && data.notifications.nodes) || [];
  for (const n of notes) {
    if (!n || n.readAt || n.archivedAt || !n.issue) continue;
    const match = LINEAR_NOTIFICATION_KINDS.find(([re]) => re.test(n.type || ''));
    if (!match) continue;
    items.push({
      source: 'linear',
      kind: match[1],
      who: (n.actor && n.actor.name) || 'unknown',
      title: n.issue.title,
      ref: n.issue.identifier,
      url: (n.comment && n.comment.url) || n.issue.url,
      since: n.createdAt,
    });
  }
  return items;
}

// Removes repeats of the same kind and link, keeping the first.
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.kind}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Most urgent kinds first, then longest waiting first.
function sortItems(items) {
  return [...items].sort((a, b) => {
    const k = KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
    if (k !== 0) return k;
    return (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0);
  });
}

module.exports = {
  KINDS,
  KIND_PROVIDERS,
  parseReviewRequested,
  parseMyPrs,
  parseNotifications,
  parseLinear,
  apiUrlToHtml,
  dedupe,
  sortItems,
};

// ---- Linear through Claude's own MCP connection --------------------------------------
// The session module (hooks/register.ts) stores the raw MCP replies; these read them.
//   list_issues      -> { issues: [{ id, title, url, updatedAt, status, statusType, createdBy }] }
//   get_notifications -> { notifications: [{ type, subtitle, url, createdAt, readAt, archivedAt, title }] }

const SUBTITLE_VERB = /^(.+?) (?:mentioned|commented|replied|assigned|reviewed|approved|requested|reacted|left|added|asked)\b/i;

function issueKeyFromUrl(url) {
  const m = typeof url === 'string' ? url.match(/\/(?:issue|review)\/([A-Za-z][A-Za-z0-9]*-\d+)/) : null;
  return m ? m[1].toUpperCase() : '';
}

function parseMcpJson(part, what) {
  if (!part) return null;
  if (part.error) throw new Error(`${what}: ${part.error}`);
  try {
    return JSON.parse(part.text);
  } catch {
    throw new Error(`${what} returned something that is not JSON`);
  }
}

function parseLinearMcp(record) {
  const issues = parseMcpJson(record.issues, 'list_issues');
  const notes = parseMcpJson(record.notifications, 'get_notifications');
  const items = [];

  for (const issue of (issues && issues.issues) || []) {
    if (!issue || !issue.url) continue;
    const reviewState = /review/i.test(issue.status || '');
    if (issue.statusType !== 'started' && !reviewState) continue;
    if (issue.statusType === 'completed' || issue.statusType === 'canceled') continue;
    items.push({
      source: 'linear',
      kind: 'assigned',
      who: issue.createdBy || 'unknown',
      title: issue.title,
      ref: issue.id || issueKeyFromUrl(issue.url),
      url: issue.url,
      since: issue.updatedAt,
    });
  }

  for (const n of (notes && notes.notifications) || []) {
    if (!n || n.readAt || n.archivedAt || !/mention/i.test(n.type || '')) continue;
    const who = typeof n.subtitle === 'string' ? (n.subtitle.match(SUBTITLE_VERB) || [])[1] : '';
    items.push({
      source: 'linear',
      kind: 'mention',
      who: who || 'unknown',
      title: n.title,
      ref: issueKeyFromUrl(n.url),
      url: n.url,
      since: n.createdAt,
    });
  }
  return items;
}

module.exports.parseLinearMcp = parseLinearMcp;

// ---- Slack nudges through Claude's own MCP connection ---------------------------------
// The session module stores the raw text of the channel and of each nudge's thread.
// A message block looks like:
//   === Message from NAME <email> (U123) at 2026-11-17 17:39:40 IST ===
//   Message TS: 1794917380.727619
//   the text, possibly over several lines
const NUDGE_TAG = '[wom:v1]';

function unwrap(text, key) {
  try {
    const v = JSON.parse(text)[key];
    return typeof v === 'string' ? v : String(text);
  } catch {
    return String(text == null ? '' : text);
  }
}

function parseSlackMessages(raw) {
  const out = [];
  for (const block of unwrap(raw, 'messages').split(/^=== Message from /m).slice(1)) {
    const head = block.match(/^(.*?)(?: <([^>\n]*)>)? \((U[A-Z0-9]+)\) at [^\n]*?===[ \t]*\n/);
    if (!head) continue;
    const rest = block.slice(head[0].length);
    const ts = (rest.match(/^Message TS: ([0-9]+\.[0-9]+)[ \t]*\n?/) || [])[1];
    if (!ts) continue;
    const text = rest.replace(/^Message TS: [^\n]*\n?/, '').trim();
    out.push({ name: head[1].trim() || 'unknown', email: head[2] || '', userId: head[3], ts, text });
  }
  return out;
}

// True if `me` wrote anything in the thread after the parent message. Slack formats a thread
// differently from a channel (a "THREAD PARENT MESSAGE" block with "From:" lines), so this
// looks at every author line after the parent, whichever form it takes.
function repliedInThread(raw, parentTs, me) {
  const text = unwrap(raw, 'messages');
  const at = text.indexOf(`Message TS: ${parentTs}`);
  const after = at === -1 ? text : text.slice(at + 1);
  return after
    .split('\n')
    .some((line) => /^(From:|=== Message from )/.test(line.trim()) && line.includes(`(${me})`));
}

// The pull requests and Linear issues a nudge points at.
function nudgeLinks(text) {
  const t = String(text || '');
  const prs = [...t.matchAll(/https:\/\/github\.com\/[^\s/|>]+\/[^\s/|>]+\/pull\/\d+/g)].map((m) => m[0]);
  const issues = [...t.matchAll(/linear\.app\/[^\s/|>]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/g)].map((m) => m[1].toUpperCase());
  return { prs: [...new Set(prs)], issues: [...new Set(issues)] };
}

// A nudge about a pull request is settled once the pull request is merged or closed,
// or once I have reviewed it after the nudge was sent.
//   pr: { state, latestReviews: [{ author: { login }, submittedAt }] } from gh pr view
function prSettlesNudge(pr, me, sinceIso) {
  if (!pr || !pr.state) return false;
  if (pr.state !== 'OPEN') return true;
  const since = Date.parse(sinceIso) || 0;
  return (pr.latestReviews || []).some((r) => r && r.author && r.author.login === me && Date.parse(r.submittedAt) >= since);
}

// True when a stored Linear reply says the issue is finished (done or cancelled).
function linearIssueFinished(part) {
  if (!part || !part.text) return false;
  const m = String(part.text).match(/"statusType"\s*:\s*"([a-zA-Z]+)"/);
  return Boolean(m) && (m[1] === 'completed' || m[1] === 'canceled');
}

// Nudges addressed to me that I have not answered in the thread.
function parseSlackMcp(record) {
  if (!record || !record.me || !record.channelId || !record.channel) throw new Error('unexpected Slack data');
  const me = record.me;
  const items = [];
  for (const msg of parseSlackMessages(record.channel.text)) {
    if (msg.userId === me || !msg.text.includes(NUDGE_TAG) || !msg.text.includes(`<@${me}`)) continue;
    const thread = record.threads && record.threads[msg.ts];
    if (thread && thread.text && repliedInThread(thread.text, msg.ts, me)) continue; // answered
    const links = nudgeLinks(msg.text);
    // The ticket the nudge is about is finished, so nobody is waiting any more.
    if (links.issues.length > 0 && links.issues.every((id) => linearIssueFinished(record.linearIssues && record.linearIssues[id]))) continue;
    const title = msg.text
      .replace(/\n?\*Sent using\*[^\n]*$/i, '') // footer Slack adds to messages posted through Claude
      .split(NUDGE_TAG).join('')
      .replace(/<@U[A-Z0-9]+(?:\|[^>]*)?>/g, '')
      .replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, '$1')
      .replace(/^\s*waiting on you:\s*/i, '')
      .trim();
    items.push({
      source: 'slack',
      kind: 'nudge',
      who: msg.name,
      title: title || '(no text)',
      ref: `#${record.channelName || 'waiting-on-me'}`,
      url: `https://slack.com/app_redirect?channel=${record.channelId}&message_ts=${msg.ts}`,
      since: new Date(Number(msg.ts) * 1000).toISOString(),
      ...(links.prs.length ? { prUrls: links.prs } : {}),
    });
  }
  return items;
}

module.exports.parseSlackMessages = parseSlackMessages;
module.exports.parseSlackMcp = parseSlackMcp;
module.exports.nudgeLinks = nudgeLinks;
module.exports.prSettlesNudge = prSettlesNudge;
