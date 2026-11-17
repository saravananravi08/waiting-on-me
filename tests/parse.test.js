'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const parse = require('../scripts/lib/parse');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

test('review requested: maps author, repo, link and last activity', () => {
  const items = parse.parseReviewRequested(fixture('github-review-requested.json'));
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    source: 'github',
    kind: 'review requested',
    who: 'alex-example',
    title: 'Add retry to the export job',
    ref: 'example-org/widgets#41',
    url: 'https://github.com/example-org/widgets/pull/41',
    since: '2026-11-16T22:30:00Z',
  });
  assert.equal(items[2].who, 'unknown', 'a deleted author must not crash');
});

test('review requested: rejects output that is not a list', () => {
  assert.throws(() => parse.parseReviewRequested({ message: 'Bad credentials' }), /not a list/);
});

test('my PRs: changes requested names the latest reviewer who asked', () => {
  const items = parse.parseMyPrs(fixture('github-my-prs.json'), 'me-example');
  const changes = items.filter((i) => i.kind === 'changes requested');
  assert.equal(changes.length, 2);
  const pr120 = changes.find((i) => i.ref.endsWith('#120'));
  assert.equal(pr120.who, 'alex-example');
  assert.equal(pr120.since, '2026-11-15T23:00:00Z');
});

test('my PRs: when latestReviews is empty, the review history says who is asking', () => {
  const items = parse.parseMyPrs(fixture('github-my-prs.json'), 'me-example');
  const pr123 = items.find((i) => i.kind === 'changes requested' && i.ref.endsWith('#123'));
  // alex-example asked most recently; jo-example approved after asking, so no longer asks.
  assert.equal(pr123.who, 'alex-example');
  assert.equal(pr123.since, '2026-11-17T10:55:00Z');
});

test('my PRs: with no review data at all the decision still shows, naming no one', () => {
  const data = { data: { search: { nodes: [{ number: 5, title: 't', url: 'https://github.com/o/r/pull/5', updatedAt: '2026-11-17T01:00:00Z', repository: { nameWithOwner: 'o/r' }, reviewDecision: 'CHANGES_REQUESTED' }] } } };
  const [item] = parse.parseMyPrs(data, 'me');
  assert.equal(item.who, 'unknown');
  assert.equal(item.since, '2026-11-17T01:00:00Z');
});

test('my PRs: review comments ignore resolved, outdated and my own threads', () => {
  const items = parse.parseMyPrs(fixture('github-my-prs.json'), 'me-example');
  const comments = items.filter((i) => i.kind === 'review comment');
  // PR 120 has one open thread from alex-example left (others resolved, outdated or mine).
  const pr120 = comments.find((i) => i.ref.endsWith('#120'));
  assert.ok(pr120);
  assert.match(pr120.title, /1 open thread\)$/);
  assert.equal(pr120.who, 'alex-example');
  // PR 121 has two real threads and one from a deleted author (skipped).
  const pr121 = comments.find((i) => i.ref.endsWith('#121'));
  assert.match(pr121.title, /2 open threads\)$/);
  assert.equal(pr121.since, '2026-11-16T08:00:00Z', 'since is the oldest waiting thread');
  assert.deepEqual(pr121.who.split(', ').sort(), ['alex-example', 'sam-example']);
});

test('my PRs: an approved quiet PR produces nothing, empty nodes are skipped', () => {
  const items = parse.parseMyPrs(fixture('github-my-prs.json'), 'me-example');
  assert.equal(items.some((i) => i.ref.endsWith('#122')), false);
});

test('my PRs: a malformed response is an error, not an empty list', () => {
  assert.throws(() => parse.parseMyPrs({ errors: [{ message: 'nope' }] }, 'x'), /unexpected/);
});

test('notifications: keeps mentions and review requests only, uses fetched authors', () => {
  const items = parse.parseNotifications(fixture('github-notifications.json'), { 1001: 'jo-example' });
  assert.deepEqual(items.map((i) => i.kind), ['mention', 'review requested', 'mention', 'mention']);
  assert.equal(items[0].who, 'jo-example');
  assert.equal(items[1].who, 'unknown');
  assert.equal(items[0].url, 'https://github.com/example-org/widgets/issues/55');
  assert.equal(items[0].ref, 'example-org/widgets#55');
  assert.equal(items[1].url, 'https://github.com/example-org/widgets/pull/41');
});

test('notifications: commits and subjects with no url fall back safely', () => {
  const items = parse.parseNotifications(fixture('github-notifications.json'));
  assert.equal(items[2].url, 'https://github.com/example-org/tools/commit/abc123');
  assert.equal(items[3].url, 'https://github.com/example-org/tools');
});

test('apiUrlToHtml handles pulls, issues and unknown shapes', () => {
  assert.equal(parse.apiUrlToHtml('https://api.github.com/repos/o/r/pulls/12'), 'https://github.com/o/r/pull/12');
  assert.equal(parse.apiUrlToHtml('https://api.github.com/repos/o/r/issues/3'), 'https://github.com/o/r/issues/3');
  assert.equal(parse.apiUrlToHtml('https://evil.example/x', 'o/r'), 'https://github.com/o/r');
  assert.equal(parse.apiUrlToHtml(undefined), 'https://github.com/notifications');
});

test('linear: assigned issues keep Backlog and Todo only, not in progress, in review or done', () => {
  const items = parse.parseLinear(fixture('linear-response.json')).filter((i) => i.kind === 'assigned');
  assert.deepEqual(items.map((i) => i.ref), ['EX-15', 'EX-16']);
  assert.equal(items[0].who, 'Jo Example');
  assert.equal(items[1].who, 'unknown', 'a missing creator must not crash');
});

test('linear: unread mentions only, comment link preferred, other types ignored', () => {
  const items = parse.parseLinear(fixture('linear-response.json')).filter((i) => i.kind === 'mention');
  assert.deepEqual(items.map((i) => i.ref), ['EX-20', 'EX-21']);
  assert.equal(items[0].url, 'https://linear.app/example/issue/EX-20/plan-the-launch#comment-abc');
  assert.equal(items[1].who, 'unknown');
});

test('linear: a response without a viewer is an error', () => {
  assert.throws(() => parse.parseLinear({ errors: [{ message: 'AUTHENTICATION_ERROR' }] }), /unexpected/);
});

test('dedupe keeps one item per kind and link; sort puts urgent and oldest first', () => {
  const a = { kind: 'mention', url: 'u1', since: '2026-11-16T00:00:00Z' };
  const b = { kind: 'mention', url: 'u1', since: '2026-11-17T00:00:00Z' };
  const c = { kind: 'changes requested', url: 'u2', since: '2026-11-17T00:00:00Z' };
  const d = { kind: 'mention', url: 'u3', since: '2026-11-10T00:00:00Z' };
  const out = parse.sortItems(parse.dedupe([a, b, c, d]));
  assert.deepEqual(out, [c, d, a]);
});

test('notifications: a mention where I wrote the latest comment is dropped, a review request is kept', () => {
  const authors = { 1001: 'me-example', 1002: 'me-example', 1003: 'jo-example' };
  const items = parse.parseNotifications(fixture('github-notifications.json'), authors, 'me-example');
  assert.equal(items.some((i) => i.ref === 'example-org/widgets#55'), false, 'I answered last on that thread');
  assert.equal(items.some((i) => i.kind === 'review requested'), true);
  assert.equal(items.filter((i) => i.kind === 'mention').length, 2);
});

test('review requested: draft pull requests are left out', () => {
  const prs = fixture('github-review-requested.json').map((p, i) => ({ ...p, isDraft: i === 0 }));
  const items = parse.parseReviewRequested(prs);
  assert.equal(items.length, 2);
  assert.equal(items.some((i) => i.ref === 'example-org/widgets#41'), false);
});
