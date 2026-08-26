import type { ContentEngineSettings, EditorialCluster, GeneratedDraft } from './types';

export interface DraftQualityResult {
  score: number;
  flags: string[];
}

export function evaluateDraftQuality(draft: GeneratedDraft, cluster: EditorialCluster): DraftQualityResult {
  const flags: string[] = [];
  const words = draft.bodyMarkdown.trim().split(/\s+/).filter(Boolean).length;
  const sourceUrls = new Set(cluster.items.flatMap((item) => item.provenance.map((source) => source.sourceUrl)));
  const distinctSources = new Set(cluster.items.flatMap((item) => item.provenance.map((source) => source.sourceId)));

  if (draft.title.length < 25 || draft.title.length > 75) flags.push('title_length');
  if (draft.description.length < 90 || draft.description.length > 170) flags.push('description_length');
  if (draft.contentType === 'blog' && words < 500) flags.push('thin_content');
  if (draft.contentType === 'newsletter' && words < 120) flags.push('thin_content');
  if (!sourceUrls.size) flags.push('missing_provenance');
  if (distinctSources.size < 2) flags.push('single_source');
  if (cluster.items.some((item) => item.qualityFlags.includes('location_unverified'))) flags.push('location_unverified');
  if (cluster.items.some((item) => item.qualityFlags.includes('missing_event_date'))) flags.push('missing_event_date');
  if (draft.dates.length && !draft.bodyMarkdown.includes('/blog/date/')) flags.push('dates_not_linked');
  if (!draft.tags.length) flags.push('missing_tags');
  if (cluster.confidenceScore < 0.75) flags.push('low_cluster_confidence');

  let score = cluster.confidenceScore * 0.52 + cluster.editorialScore * 0.28 + 0.2;
  const severe = new Set(['thin_content', 'missing_provenance', 'missing_event_date', 'dates_not_linked']);
  score -= flags.reduce((sum, flag) => sum + (severe.has(flag) ? 0.1 : 0.035), 0);
  return { score: Number(Math.max(0, Math.min(0.99, score)).toFixed(3)), flags: [...new Set(flags)] };
}

export function canAutoPublish(
  draft: GeneratedDraft,
  cluster: EditorialCluster,
  settings: ContentEngineSettings
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!settings.autoPublishEnabled) reasons.push('auto_publish_disabled');
  if (draft.contentType !== 'blog') reasons.push('blog_only');
  if (draft.qualityScore < settings.autoPublishMinQuality) reasons.push('below_quality_threshold');
  if (draft.qualityFlags.length) reasons.push(...draft.qualityFlags.map((flag) => `quality:${flag}`));
  if (cluster.confidenceScore < Math.max(0.8, settings.minClusterScore)) reasons.push('low_cluster_confidence');
  const sourceCount = new Set(cluster.items.flatMap((item) => item.provenance.map((source) => source.sourceId))).size;
  if (settings.requireMultipleSources && sourceCount < 2) reasons.push('needs_corroboration');
  if (cluster.items.some((item) => !item.eventStartAt || !(item.area || item.neighborhood || item.address))) {
    reasons.push('incomplete_date_or_location');
  }
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
