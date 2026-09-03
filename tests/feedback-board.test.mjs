import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findFeatureRequestMatches, normalizeFeedbackText } from '../src/lib/feedback.ts';

const ROOT = process.cwd();

function request(id, title, details, voteCount = 0, status = 'open') {
  return { id, title, details, voteCount, status };
}

function testDeterministicFeatureMatching() {
  const candidates = [
    request('map', 'Add an interactive map', 'Show venue pins by neighborhood', 22),
    request('time', 'Filter by start and end time', 'Find happy hours within a visit window', 8),
    request('patio', 'Dog-friendly patio filter', 'Only venues that allow dogs outside', 14),
    request('closed', 'Map view', 'An old duplicate', 99, 'closed'),
  ];

  assert.equal(normalizeFeedbackText('  Dog-friendly PATIO! '), 'dog friendly patio');
  assert.deepEqual(
    findFeatureRequestMatches('Could we add a dog friendly patio filter?', candidates).map(({ request }) => request.id),
    ['patio'],
  );
  assert.equal(findFeatureRequestMatches('interactive map', candidates)[0].request.id, 'map');
  assert.deepEqual(findFeatureRequestMatches('unrelated loyalty rewards', candidates), []);
  assert.ok(findFeatureRequestMatches('map view', candidates).every(({ request }) => request.status !== 'closed'));
}

async function testSchemaAndSurfaces() {
  const [migration, layout, featuresPage, bugPage, featureRoute, voteRoute, statusRoute, bugRoute, store] = await Promise.all([
    readFile(path.join(ROOT, 'migrations', '0020_feedback_board.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'layouts', 'Layout.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'features.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'report-a-bug.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'feature-requests', 'index.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'feature-requests', '[id]', 'vote.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'feature-requests', '[id]', 'status.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'bug-reports.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'feedbackStore.ts'), 'utf8'),
  ]);

  for (const table of ['bug_reports', 'feature_requests', 'feature_request_votes']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /PRIMARY KEY \(feature_request_id, user_id\)/);
  assert.match(migration, /author_kind\s+text NOT NULL CHECK \(author_kind IN \('user', 'venue_owner'\)\)/);
  assert.match(layout, /href="\/report-a-bug\/">Report a bug<\/a>/);
  assert.match(layout, /href="\/features\/">Request a feature<\/a>/);

  assert.match(featureRoute, /if \(!user\) return errorJson\(\['Sign in to view feature requests\.'\], 401\)/);
  assert.match(featureRoute, /viewerIsAdmin:\s*Boolean\(admin\)/);
  assert.match(featureRoute, /needsConfirmation:\s*true/);
  assert.match(featureRoute, /if \(!body\.confirmCreate\)/);
  assert.match(voteRoute, /if \(!user\) return errorJson\(\['Sign in to upvote feature requests\.'\], 401\)/);
  assert.match(voteRoute, /toggleFeatureRequestVote/);
  assert.match(statusRoute, /getAdminUser\(cookies\)/);
  assert.match(statusRoute, /updateFeatureRequestStatus/);
  assert.match(store, /toggleFeatureRequestVote/);
  assert.match(store, /DELETE FROM feature_request_votes/);
  assert.match(store, /updateFeatureRequestStatus/);
  assert.match(store, /ORDER BY vote_count DESC, requests\.created_at DESC/);
  assert.match(store, /venue_claims WHERE user_id = \$\{userId\} AND status = 'verified'/);

  assert.match(featuresPage, /Possibly|similar requests|Is one of these what you’re looking for\?/i);
  assert.match(featuresPage, /No similar requests found/);
  assert.match(featuresPage, /None match — submit as new/);
  assert.match(featuresPage, /Yes — upvote this/);
  assert.match(featuresPage, /toggleVote/);
  assert.match(featuresPage, /Remove/);
  assert.match(featuresPage, /status-select/);
  assert.match(featuresPage, /updateStatus/);
  assert.match(featuresPage, /accountSignInHref\('\/features\/'\)/);
  assert.match(featuresPage, /Could not load the board/);
  // Checking similar must not auto-create; submit happens via the confirm button.
  assert.doesNotMatch(featuresPage, /await createDraft\(false\)/);
  assert.match(bugPage, /fetch\('\/api\/bug-reports'/);
  assert.match(bugRoute, /reporterUserId:\s*user\?\.id \|\| null/);
  assert.match(bugRoute, /A valid email is required/);
}

testDeterministicFeatureMatching();
await testSchemaAndSurfaces();
console.log('feedback board: matching, vote toggle, admin status, auth gates, and UI contracts passed');
