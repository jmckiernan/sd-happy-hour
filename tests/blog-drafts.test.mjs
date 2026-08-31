import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GitHubConfigError,
  describeGitHubError,
  describeRepoError,
  getGitHubTarget,
  isGitHubError,
  isGitHubNotFound,
} from '../src/lib/github.ts';
import { getBlogFile, parseFrontmatter, setField, splitFrontmatter } from '../src/lib/blogDrafts.ts';

// Shapes an Octokit rejection closely enough for the classifier: a numeric
// status plus the `request` it attaches to everything it throws.
function githubError(status, message, headers = {}) {
  return Object.assign(new Error(message), {
    status,
    request: { method: 'GET', url: 'https://api.github.com/repos/o/r/contents/x' },
    response: { status, headers, data: { message } },
  });
}

function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CONFIGURED = {
  GITHUB_OWNER: 'someone',
  GITHUB_REPO: 'sd-happy-hour',
  GITHUB_BRANCH: 'main',
  GITHUB_TOKEN: 'github_pat_example',
};

test('getGitHubTarget names exactly the env vars that are missing', () => {
  withEnv({ ...CONFIGURED, GITHUB_TOKEN: undefined }, () => {
    assert.throws(() => getGitHubTarget(), (err) => {
      assert.ok(err instanceof GitHubConfigError);
      assert.match(err.message, /GITHUB_TOKEN is not set/);
      assert.doesNotMatch(err.message, /GITHUB_OWNER/);
      return true;
    });
  });

  withEnv({ ...CONFIGURED, GITHUB_OWNER: undefined, GITHUB_TOKEN: undefined }, () => {
    assert.throws(() => getGitHubTarget(), /GITHUB_OWNER, GITHUB_TOKEN are not set/);
  });
});

test('getGitHubTarget trims a token that picked up whitespace', () => {
  // A newline pasted into a Netlify env field produces the same opaque 401 as
  // a revoked token, so it must never be able to reach the Authorization header.
  withEnv({ ...CONFIGURED, GITHUB_TOKEN: '  github_pat_example\n' }, () => {
    assert.equal(getGitHubTarget().token, 'github_pat_example');
  });
});

test('getGitHubTarget defaults the branch but requires owner, repo, and token', () => {
  withEnv({ ...CONFIGURED, GITHUB_BRANCH: undefined }, () => {
    const target = getGitHubTarget();
    assert.equal(target.branch, 'main');
    assert.equal(target.owner, 'someone');
    assert.equal(target.repo, 'sd-happy-hour');
  });
});

test('describeGitHubError tells missing, invalid, and unauthorized tokens apart', () => {
  const missing = describeGitHubError(new GitHubConfigError('GitHub is not configured: GITHUB_TOKEN is not set.'), 'list posts');
  assert.match(missing, /not set/);

  const invalid = describeGitHubError(githubError(401, 'Bad credentials'), 'list posts');
  assert.match(invalid, /expired, been revoked, or been mistyped/);

  const forbidden = describeGitHubError(githubError(403, 'Resource not accessible'), 'save your edits');
  assert.match(forbidden, /not allowed to do this/);
  assert.match(forbidden, /Contents/);

  const rateLimited = describeGitHubError(
    githubError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }),
    'save your edits'
  );
  assert.match(rateLimited, /rate limit/);

  // All three are distinct advice, which is the whole point of the split.
  assert.notEqual(invalid, forbidden);
  assert.notEqual(forbidden, rateLimited);
});

test('describeGitHubError never leaks GitHub response text to the admin UI', () => {
  const cases = [
    githubError(401, 'Bad credentials'),
    githubError(403, 'Resource not accessible by personal access token'),
    githubError(404, 'Not Found'),
    githubError(500, 'Server Error'),
    githubError(418, 'Some future status'),
  ];
  for (const err of cases) {
    const message = describeGitHubError(err, 'list posts');
    assert.doesNotMatch(message, /docs\.github\.com/);
    assert.doesNotMatch(message, /Bad credentials/);
    assert.doesNotMatch(message, /Resource not accessible/);
    assert.match(message, /^Could not list posts\./);
  }
});

test('isGitHubError separates GitHub rejections from our own and the database', () => {
  assert.equal(isGitHubError(githubError(401, 'Bad credentials')), true);
  assert.equal(isGitHubError(new Error('No venue with id 4.')), false);
  assert.equal(isGitHubError(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' })), false);
});

test('describeRepoError keeps database detail but classifies GitHub failures', () => {
  assert.match(
    describeRepoError(new Error('relation "venue_overrides" does not exist'), 'load the current live venue'),
    /relation "venue_overrides" does not exist/
  );
  assert.match(
    describeRepoError(githubError(401, 'Bad credentials'), 'load the current live venue'),
    /expired, been revoked, or been mistyped/
  );
});

test('isGitHubNotFound is true only for 404', () => {
  assert.equal(isGitHubNotFound(githubError(404, 'Not Found')), true);
  assert.equal(isGitHubNotFound(githubError(401, 'Bad credentials')), false);
  assert.equal(isGitHubNotFound(new Error('nope')), false);
});

const target = { owner: 'someone', repo: 'sd-happy-hour', branch: 'main', token: 't' };

function fakeOctokit(getContent) {
  return { repos: { getContent } };
}

test('getBlogFile returns null for a post that really is absent', async () => {
  const octokit = fakeOctokit(async () => {
    throw githubError(404, 'Not Found');
  });
  assert.equal(await getBlogFile(octokit, target, 'never-existed'), null);
});

test('getBlogFile rethrows an auth failure instead of reporting a missing draft', async () => {
  // Bug A surfaced on /admin/drafts/[slug] as "Draft not found — it may have
  // already been published or discarded" because every error became null.
  // A 401 has to stay an error so the page can say the token is the problem.
  const octokit = fakeOctokit(async () => {
    throw githubError(401, 'Bad credentials');
  });
  await assert.rejects(() => getBlogFile(octokit, target, 'welcome-to-sd-happy-hours'), /Bad credentials/);

  const forbidden = fakeOctokit(async () => {
    throw githubError(403, 'Resource not accessible');
  });
  await assert.rejects(() => getBlogFile(forbidden, target, 'welcome-to-sd-happy-hours'), /Resource not accessible/);
});

test('getBlogFile loads an already-published post so it can be edited', async () => {
  // Published posts sit at the same src/content/blog path as drafts, only with
  // draft: false. Nothing about the read is draft-specific, so the editor gets
  // a live post exactly as it gets a draft — pubDate and slug included.
  const raw = [
    '---',
    'title: "Welcome to SD Happy Hours"',
    'description: "The first post."',
    'pubDate: 2026-07-24',
    'author: "SD Happy Hours"',
    'draft: false',
    'aiGenerated: false',
    'venues: ["craft-and-commerce"]',
    '---',
    'Live body copy.',
  ].join('\n');

  const octokit = fakeOctokit(async ({ path }) => {
    assert.equal(path, 'src/content/blog/welcome-to-sd-happy-hours.md');
    return {
      data: {
        type: 'file',
        sha: 'abc123',
        content: Buffer.from(raw, 'utf-8').toString('base64'),
      },
    };
  });

  const file = await getBlogFile(octokit, target, 'welcome-to-sd-happy-hours');
  assert.ok(file);
  assert.equal(file.data.draft, false);
  assert.equal(file.slug, 'welcome-to-sd-happy-hours');
  assert.equal(file.data.title, 'Welcome to SD Happy Hours');
  assert.equal(file.data.pubDate, '2026-07-24');
  assert.equal(file.sha, 'abc123');
  assert.match(file.body, /Live body copy\./);
});

test('editing a published post preserves its identity and stays published', () => {
  // What the PATCH route writes: title/description/body change, updatedDate is
  // stamped, and pubDate, slug and draft: false are left exactly as they were,
  // so existing links and the post's publish date survive the edit and it does
  // not fork into a hidden draft.
  const raw = [
    '---',
    'title: "Old Title"',
    'description: "Old description."',
    'pubDate: 2026-07-24',
    'author: "SD Happy Hours"',
    'draft: false',
    'aiGenerated: true',
    'venues: ["craft-and-commerce"]',
    'heroImage: "/api/images/hero.png"',
    '---',
    'Old body.',
  ].join('\n');

  const { lines } = splitFrontmatter(raw);
  let next = setField(lines, 'title', 'New Title');
  next = setField(next, 'description', 'New description.');
  next = setField(next, 'updatedDate', '2026-08-31');

  const data = parseFrontmatter(next);
  assert.equal(data.title, 'New Title');
  assert.equal(data.description, 'New description.');
  assert.equal(data.updatedDate, '2026-08-31');
  assert.equal(data.draft, false, 'an edit must not send a live post back to draft');
  assert.equal(data.pubDate, '2026-07-24', 'editing must not re-date the post');
  assert.equal(data.heroImage, '/api/images/hero.png');
  assert.deepEqual(data.venues, ['craft-and-commerce']);
});
