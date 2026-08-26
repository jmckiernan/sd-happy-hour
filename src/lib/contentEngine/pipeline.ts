import { getEnv } from '../env';
import { generateDraftBundle, refineClusterEditorialJudgment, type TextModel } from './ai';
import { buildEditorialClusters } from './cluster';
import { findDuplicate, mergeContentItems } from './dedupe';
import { resolveDraftImage } from './images';
import { normalizeSourceItem } from './normalize';
import { canAutoPublish } from './quality';
import { publishContentDraft } from './publish';
import {
  finishIngestionRun,
  getContentEngineSettings,
  getEditorialCluster,
  getGeneratedDraft,
  listContentSources,
  listClustersAwaitingDrafts,
  listDueScheduledDrafts,
  listRecentContentItems,
  recordContentEngineEvent,
  recordSourceFetch,
  saveContentItem,
  saveEditorialCluster,
  saveGeneratedDraft,
  setDraftLifecycle,
  startIngestionRun,
  updateGeneratedDraft,
} from './repo';
import { fetchSourceItems } from './sourceAdapters';
import type {
  ContentSource,
  GeneratedDraft,
  IngestionRunSummary,
  RawSourceItem,
} from './types';

export interface RunContentEngineOptions {
  triggerType?: IngestionRunSummary['triggerType'];
  sourceIds?: string[];
  injectedItems?: Record<string, RawSourceItem[]>;
  model?: TextModel;
  skipDraftGeneration?: boolean;
}

function replaceItem<T extends { id?: string; canonicalKey: string }>(items: T[], item: T): void {
  const index = items.findIndex((candidate) =>
    (item.id && candidate.id === item.id) || candidate.canonicalKey === item.canonicalKey
  );
  if (index >= 0) items[index] = item;
  else items.push(item);
}

async function recordEventSafely(input: Parameters<typeof recordContentEngineEvent>[0]): Promise<void> {
  try { await recordContentEngineEvent(input); }
  catch (error) { console.warn('[content-engine] analytics event failed:', error); }
}

async function createDraftsForCluster(input: {
  clusterId: string;
  model?: TextModel;
  generateImages: boolean;
}): Promise<{ blog: GeneratedDraft; newsletter: GeneratedDraft }> {
  const cluster = await getEditorialCluster(input.clusterId);
  if (!cluster) throw new Error('Cluster not found after creation.');
  const generated = await generateDraftBundle(cluster, input.model);

  try {
    const image = await resolveDraftImage({
      cluster,
      draft: generated.blog,
      allowGeneration: input.generateImages,
    });
    generated.blog.heroImageUrl = image.url;
    generated.blog.imageMetadata = image.metadata;
    if (image.outcome === 'unavailable') {
      generated.blog.qualityFlags = [...new Set([...generated.blog.qualityFlags, 'missing_image'])];
    }
    if (image.outcome !== 'unavailable') {
      await recordEventSafely({
        eventName: image.outcome === 'generated' ? 'image_generated' : 'image_attached',
        clusterId: cluster.id,
        properties: image.metadata,
      });
    }
  } catch (error) {
    generated.blog.qualityFlags = [...new Set([...generated.blog.qualityFlags, 'image_generation_failed'])];
    generated.blog.imageMetadata = {
      origin: 'fallback', error: error instanceof Error ? error.message : String(error),
    };
    await recordEventSafely({
      eventName: 'image_failed', clusterId: cluster.id,
      properties: { message: error instanceof Error ? error.message : String(error) },
    });
  }

  const blog = await saveGeneratedDraft(cluster.id!, generated.blog);
  const newsletter = await saveGeneratedDraft(cluster.id!, generated.newsletter);
  await Promise.all([
    recordEventSafely({ eventName: 'draft_created', clusterId: cluster.id, draftId: blog.id }),
    recordEventSafely({ eventName: 'newsletter_created', clusterId: cluster.id, draftId: newsletter.id }),
  ]);
  return { blog, newsletter };
}

export async function publishApprovedDraft(draftId: string): Promise<GeneratedDraft> {
  const draft = await getGeneratedDraft(draftId);
  if (!draft) throw new Error('Draft not found.');
  if (draft.contentType !== 'blog') throw new Error('Newsletter drafts remain internal and are not site posts.');
  if (!['approved', 'scheduled'].includes(draft.status || '')) {
    throw new Error('Draft must be approved before publishing.');
  }
  if (draft.status === 'scheduled' && draft.scheduledFor && new Date(draft.scheduledFor) > new Date()) {
    throw new Error('The scheduled publication time has not arrived.');
  }
  const cluster = await getEditorialCluster(draft.clusterId!);
  if (!cluster) throw new Error('Source cluster not found.');
  const published = await publishContentDraft({ draft, cluster });
  const updated = await setDraftLifecycle({ id: draftId, status: 'published', githubPath: published.path });
  if (!updated) throw new Error('Draft disappeared after publishing.');
  await recordEventSafely({
    eventName: 'post_published', draftId, clusterId: cluster.id,
    properties: { slug: published.slug, github_path: published.path },
  });
  return { ...updated, slug: published.slug };
}

export async function approveDraft(draftId: string, publishNow = false): Promise<GeneratedDraft> {
  const draft = await getGeneratedDraft(draftId);
  if (!draft) throw new Error('Draft not found.');
  const updated = await setDraftLifecycle({ id: draftId, status: 'approved' });
  if (!updated) throw new Error('Draft disappeared while approving.');
  await recordEventSafely({
    eventName: 'draft_approved', draftId, clusterId: draft.clusterId,
    properties: { content_type: draft.contentType },
  });
  if (publishNow && draft.contentType === 'blog') return publishApprovedDraft(draftId);
  return updated;
}

export async function scheduleDraft(draftId: string, scheduledFor: string): Promise<GeneratedDraft> {
  const parsed = new Date(scheduledFor);
  if (!Number.isFinite(parsed.valueOf()) || parsed <= new Date()) throw new Error('Choose a future publication time.');
  const draft = await getGeneratedDraft(draftId);
  if (!draft || draft.contentType !== 'blog') throw new Error('Blog draft not found.');
  const updated = await setDraftLifecycle({ id: draftId, status: 'scheduled', scheduledFor: parsed.toISOString() });
  if (!updated) throw new Error('Draft disappeared while scheduling.');
  await recordEventSafely({
    eventName: 'post_scheduled', draftId, clusterId: draft.clusterId,
    properties: { scheduled_for: parsed.toISOString() },
  });
  return updated;
}

export async function rejectDraft(draftId: string): Promise<GeneratedDraft> {
  const draft = await getGeneratedDraft(draftId);
  if (!draft) throw new Error('Draft not found.');
  const updated = await setDraftLifecycle({ id: draftId, status: 'rejected' });
  if (!updated) throw new Error('Draft disappeared while rejecting.');
  await recordEventSafely({
    eventName: 'draft_rejected', draftId, clusterId: draft.clusterId,
    properties: { content_type: draft.contentType },
  });
  return updated;
}

export async function regenerateClusterDrafts(clusterId: string, model?: TextModel) {
  const settings = await getContentEngineSettings();
  return createDraftsForCluster({ clusterId, model, generateImages: settings.generateImages });
}

export async function regenerateDraftImage(draftId: string): Promise<GeneratedDraft> {
  const draft = await getGeneratedDraft(draftId);
  if (!draft || draft.contentType !== 'blog') throw new Error('Blog draft not found.');
  const cluster = await getEditorialCluster(draft.clusterId!);
  if (!cluster) throw new Error('Source cluster not found.');
  const image = await resolveDraftImage({ cluster, draft, allowGeneration: true, forceGenerate: true });
  if (!image.url) throw new Error('Image generation is unavailable. Configure GEMINI_API_KEY first.');
  const updated = await updateGeneratedDraft({
    ...draft,
    id: draft.id!,
    heroImageUrl: image.url,
    imageMetadata: image.metadata,
    qualityFlags: draft.qualityFlags.filter((flag) => flag !== 'image_generation_failed'),
  });
  if (!updated) throw new Error('Draft disappeared while saving the image.');
  await recordEventSafely({ eventName: 'image_generated', draftId, clusterId: cluster.id, properties: image.metadata });
  return updated;
}

export async function publishDueScheduledDrafts(): Promise<{ published: number; errors: string[] }> {
  const due = await listDueScheduledDrafts();
  let published = 0;
  const errors: string[] = [];
  for (const draft of due) {
    try {
      await publishApprovedDraft(draft.id!);
      published++;
    } catch (error) {
      errors.push(`${draft.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { published, errors };
}

export async function runContentEngine(options: RunContentEngineOptions = {}): Promise<IngestionRunSummary> {
  const triggerType = options.triggerType || 'scheduled';
  const summary: IngestionRunSummary = {
    triggerType,
    status: 'running',
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    itemsFetched: 0,
    itemsCreated: 0,
    itemsMerged: 0,
    itemsOutsideCounty: 0,
    clustersCreated: 0,
    draftsCreated: 0,
    errors: [],
  };
  summary.runId = await startIngestionRun(triggerType);

  try {
    const settings = await getContentEngineSettings();
    if (triggerType === 'scheduled' && settings.runSchedule === 'manual') {
      summary.status = 'completed';
      return summary;
    }
    if (triggerType === 'scheduled' && settings.runSchedule === 'daily' && new Date().getUTCHours() !== 15) {
      summary.status = 'completed';
      return summary;
    }
    const allSources = await listContentSources(true);
    const selectedSources = options.sourceIds?.length
      ? allSources.filter((source) => options.sourceIds!.includes(source.id))
      : allSources;
    const knownItems = await listRecentContentItems({ limit: 1000 });

    for (const source of selectedSources) {
      summary.sourcesAttempted++;
      try {
        const injected = options.injectedItems?.[source.id];
        const fetched = injected
          ? { items: injected, notModified: false, etag: source.etag, lastModified: source.lastModified }
          : await fetchSourceItems(source);
        summary.sourcesSucceeded++;
        summary.itemsFetched += fetched.items.length;
        await recordSourceFetch({
          id: source.id, success: true, etag: fetched.etag, lastModified: fetched.lastModified,
        });
        await recordEventSafely({
          eventName: 'source_fetched', sourceId: source.id,
          properties: { items: fetched.items.length, not_modified: fetched.notModified },
        });

        for (const raw of fetched.items) {
          const normalized = normalizeSourceItem(source, raw);
          if (!normalized.accepted || !normalized.item) {
            if (normalized.reason === 'outside_san_diego_county') summary.itemsOutsideCounty++;
            await recordEventSafely({
              eventName: 'item_rejected', sourceId: source.id,
              properties: { reason: normalized.reason || 'normalization_failed', source_url: raw.url.slice(0, 400) },
            });
            continue;
          }
          const duplicate = findDuplicate(normalized.item, knownItems);
          if (duplicate) {
            const merged = mergeContentItems(duplicate.item, normalized.item);
            merged.id = duplicate.item.id;
            const saved = await saveContentItem(merged);
            replaceItem(knownItems, saved.item);
            summary.itemsMerged++;
            await recordEventSafely({ eventName: 'item_merged', sourceId: source.id, itemId: saved.item.id });
          } else {
            const saved = await saveContentItem(normalized.item);
            replaceItem(knownItems, saved.item);
            if (saved.created) summary.itemsCreated++;
            else summary.itemsMerged++;
            await recordEventSafely({
              eventName: saved.created ? 'item_created' : 'item_merged',
              sourceId: source.id, itemId: saved.item.id,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push({ source: source.name, stage: 'fetch', message });
        await recordSourceFetch({ id: source.id, success: false, error: message }).catch(() => {});
      }
    }

    const unclustered = await listRecentContentItems({ limit: 500, unclusteredOnly: true });
    let clusters = buildEditorialClusters(unclustered, {
      minItemConfidence: settings.minItemConfidence,
      minClusterScore: settings.minClusterScore,
    });
    try {
      clusters = await refineClusterEditorialJudgment(clusters, options.model);
    } catch (error) {
      summary.errors.push({ stage: 'cluster_ai', message: error instanceof Error ? error.message : String(error) });
    }

    const configuredMax = Number(getEnv('CONTENT_ENGINE_MAX_DRAFT_BUNDLES') || 3);
    const maxDraftBundles = Number.isFinite(configuredMax) ? Math.max(1, Math.min(10, configuredMax)) : 3;
    for (const proposal of clusters) {
      try {
        const saved = await saveEditorialCluster(proposal);
        if (!saved.created) continue;
        summary.clustersCreated++;
        await recordEventSafely({ eventName: 'cluster_created', clusterId: saved.cluster.id });
      } catch (error) {
        summary.errors.push({
          stage: 'cluster_save',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!options.skipDraftGeneration) for (const pendingCluster of await listClustersAwaitingDrafts(maxDraftBundles)) {
      try {
        const drafts = await createDraftsForCluster({
          clusterId: pendingCluster.id!, model: options.model, generateImages: settings.generateImages,
        });
        summary.draftsCreated += 2;
        const cluster = await getEditorialCluster(pendingCluster.id!);
        if (!cluster) continue;
        const gate = canAutoPublish(drafts.blog, cluster, settings);
        if (gate.allowed) {
          await approveDraft(drafts.blog.id!);
          await publishApprovedDraft(drafts.blog.id!);
        }
      } catch (error) {
        summary.errors.push({
          stage: 'draft',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const due = await publishDueScheduledDrafts();
    summary.errors.push(...due.errors.map((message) => ({ stage: 'scheduled_publish', message })));
    summary.status = summary.errors.length
      ? (summary.sourcesSucceeded || summary.clustersCreated ? 'partial' : 'failed')
      : 'completed';
  } catch (error) {
    summary.status = 'failed';
    summary.errors.push({ stage: 'pipeline', message: error instanceof Error ? error.message : String(error) });
  } finally {
    await finishIngestionRun(summary).catch((error) => {
      console.error('[content-engine] could not finish run record:', error);
    });
  }
  return summary;
}

export function contentEngineConfigured(): boolean {
  return Boolean(getEnv('DATABASE_URL') && getEnv('ANTHROPIC_API_KEY'));
}

export function webhookSourceIsStrong(source: ContentSource): boolean {
  return source.kind === 'webhook' && source.trustScore >= 0.8;
}
