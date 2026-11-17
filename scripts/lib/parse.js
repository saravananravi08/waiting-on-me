'use strict';
// Pure parsing: raw API output in, normalised items out. No network, no files.
//
// Item shape:
//   { source: 'github'|'linear', kind, who, title, ref, url, since }
// kind is one of: review requested, changes requested, review comment, mention, assigned.
// since is an ISO 8601 string (formatted for people at render time).

const KINDS = ['changes requested', 'review requested', 'review comment', 'mention', 'assigned'];

// Which sources can supply which kind. Used so a failed or unconfigured
// source is never shown as a confident zero.
const KIND_PROVIDERS = {
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
  return prs.map((pr) => ({
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
function parseNotifications(list, authors = {}) {
  if (!Array.isArray(list)) throw new Error('unexpected notifications output (not a list)');
  const items = [];
  for (const n of list) {
    const kind = GITHUB_NOTIFICATION_REASONS[n && n.reason];
    if (!kind || n.unread === false) continue;
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
