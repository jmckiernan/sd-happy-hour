import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  classifyBlogDestination,
  cleanAnalyticsPath,
  scrollPercent,
} from '../src/lib/blogAnalytics.ts';

const ROOT = process.cwd();

test('analytics paths exclude query parameters while retaining safe anchors', () => {
  assert.equal(
    cleanAnalyticsPath('https://happyhoursd.com/blog/best-bars/?email=private@example.test#details'),
    '/blog/best-bars/#details'
  );
});

test('blog destinations distinguish internal, external, and contact links', () => {
  assert.deepEqual(
    classifyBlogDestination('/venues/kindred/?invite=secret', 'https://happyhoursd.com', 'mentioned_venue'),
    { linkType: 'mentioned_venue', destinationPath: '/venues/kindred/' }
  );
  assert.deepEqual(
    classifyBlogDestination('https://restaurant.example/menu?customer=private', 'https://happyhoursd.com'),
    { linkType: 'external', destinationUrl: 'https://restaurant.example/menu' }
  );
  assert.deepEqual(
    classifyBlogDestination('mailto:hello@happyhoursd.com', 'https://happyhoursd.com'),
    { linkType: 'contact' }
  );
});

test('scroll depth is bounded and handles short pages', () => {
  assert.equal(scrollPercent({ scrollY: 500, viewportHeight: 500, documentHeight: 2000 }), 50);
  assert.equal(scrollPercent({ scrollY: 9000, viewportHeight: 500, documentHeight: 2000 }), 100);
  assert.equal(scrollPercent({ scrollY: 0, viewportHeight: 900, documentHeight: 700 }), 100);
});

test('browser tracking is blog-scoped and keeps invasive collection disabled', async () => {
  const [browserAnalytics, layout, blogPost, blogIndex] = await Promise.all([
    readFile(path.join(ROOT, 'src/lib/browserAnalytics.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/layouts/Layout.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/layouts/BlogPost.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/blog/index.astro'), 'utf8'),
  ]);
  assert.match(browserAnalytics, /pathname\.startsWith\('\/blog\/'\)/);
  assert.match(browserAnalytics, /PUBLIC_POSTHOG_ALLOW_LOCAL/);
  assert.match(browserAnalytics, /autocapture:\s*false/);
  assert.match(browserAnalytics, /disable_session_recording:\s*true/);
  assert.match(browserAnalytics, /capture_pageleave:\s*true/);
  assert.match(browserAnalytics, /blog_reading_completed/);
  assert.match(browserAnalytics, /blog_scroll_depth/);
  assert.match(layout, /initBrowserAnalytics\(\)/);
  assert.match(blogPost, /analyticsContentType="blog_post"/);
  assert.match(blogIndex, /analyticsContentType="blog_index"/);
});
