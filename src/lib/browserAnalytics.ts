import posthog from 'posthog-js';
import { classifyBlogDestination, cleanAnalyticsPath, scrollPercent } from './blogAnalytics';

type AnalyticsProperty = string | number | boolean;

let initialized = false;

function blogContext(): Record<string, AnalyticsProperty> {
  const body = document.body;
  const contentType = body.dataset.analyticsContentType || 'blog';
  const output: Record<string, AnalyticsProperty> = {
    content_type: contentType,
    page_path: cleanAnalyticsPath(window.location.href),
  };
  if (body.dataset.analyticsContentSlug) output.post_slug = body.dataset.analyticsContentSlug.slice(0, 120);
  if (body.dataset.analyticsContentTitle) output.post_title = body.dataset.analyticsContentTitle.slice(0, 160);
  return output;
}

function linkArea(anchor: HTMLAnchorElement): string {
  if (anchor.closest('[data-admin-only]')) return 'admin';
  if (anchor.closest('.post-body')) return 'article_body';
  if (anchor.closest('.related-venues')) return 'mentioned_venues';
  if (anchor.closest('.post-pager')) return 'post_pager';
  if (anchor.closest('.post-list')) return 'blog_index';
  if (anchor.closest('.site-nav')) return 'site_navigation';
  if (anchor.closest('.site-footer')) return 'footer';
  return 'other';
}

export function initBrowserAnalytics(): void {
  if (initialized || typeof window === 'undefined') return;
  if (!window.location.pathname.startsWith('/blog/')) return;

  const localHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  if (localHost && import.meta.env.PUBLIC_POSTHOG_ALLOW_LOCAL !== 'true') return;

  const apiKey = import.meta.env.PUBLIC_POSTHOG_PROJECT_API_KEY?.trim();
  const enabled = import.meta.env.PUBLIC_POSTHOG_ENABLED !== 'false';
  if (!enabled || !apiKey) return;
  initialized = true;

  posthog.init(apiKey, {
    api_host: import.meta.env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    ui_host: 'https://us.posthog.com',
    defaults: '2026-05-30',
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: true,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: true,
    disable_session_recording: true,
    disable_surveys: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    respect_dnt: true,
    property_denylist: [
      'email', 'name', 'phone', 'password', 'comment', 'description',
      'list_title', 'latitude', 'longitude',
    ],
  });

  const context = blogContext();
  posthog.capture('$pageview', context);
  posthog.capture(context.content_type === 'blog_post' ? 'blog_post_viewed' : 'blog_index_viewed', context);

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || anchor.closest('[data-admin-only]')) return;
    const destination = classifyBlogDestination(
      anchor.href,
      window.location.origin,
      anchor.dataset.analyticsLink
    );
    if (!destination) return;
    posthog.capture('blog_link_clicked', {
      ...context,
      link_type: destination.linkType,
      link_area: linkArea(anchor),
      opens_new_tab: anchor.target === '_blank',
      ...(destination.destinationPath ? { destination_path: destination.destinationPath } : {}),
      ...(destination.destinationUrl ? { destination_url: destination.destinationUrl } : {}),
    });
  });

  const thresholds = [25, 50, 75, 100];
  const capturedThresholds = new Set<number>();
  let maxScrollPercent = 0;
  let scrollFrame = 0;
  const measureScroll = () => {
    scrollFrame = 0;
    const percent = scrollPercent({
      scrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    });
    maxScrollPercent = Math.max(maxScrollPercent, percent);
    for (const threshold of thresholds) {
      if (percent < threshold || capturedThresholds.has(threshold)) continue;
      capturedThresholds.add(threshold);
      posthog.capture('blog_scroll_depth', { ...context, percent: threshold });
    }
  };
  window.addEventListener('scroll', () => {
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(measureScroll);
  }, { passive: true });
  measureScroll();

  let activeStartedAt = document.visibilityState === 'visible' ? performance.now() : null;
  let activeMilliseconds = 0;
  let readingSummarySent = false;
  const pauseActiveTimer = () => {
    if (activeStartedAt === null) return;
    activeMilliseconds += performance.now() - activeStartedAt;
    activeStartedAt = null;
  };
  const activeSeconds = () => {
    const current = activeStartedAt === null ? 0 : performance.now() - activeStartedAt;
    return Math.max(0, Math.round((activeMilliseconds + current) / 1000));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') activeStartedAt = performance.now();
    else pauseActiveTimer();
  });
  window.addEventListener('pagehide', () => {
    if (readingSummarySent) return;
    readingSummarySent = true;
    pauseActiveTimer();
    measureScroll();
    posthog.capture('blog_reading_completed', {
      ...context,
      active_seconds: activeSeconds(),
      max_scroll_percent: maxScrollPercent,
    });
  });
}
