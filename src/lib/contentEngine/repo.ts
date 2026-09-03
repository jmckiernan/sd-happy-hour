import { sql, withTransaction, type QueryExecutor } from '../db';
import type {
  ContentEngineSettings,
  ContentSource,
  ContentSourceConfig,
  ContentSourceKind,
  EditorialCluster,
  GeneratedDraft,
  ImagePolicy,
  IngestionRunSummary,
  ItemProvenance,
  NormalizedContentItem,
} from './types';

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function jsonValue<T>(value: T | string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

interface SourceRow {
  id: string;
  name: string;
  kind: ContentSourceKind;
  url: string;
  enabled: boolean;
  trust_score: string | number;
  county_scoped: boolean;
  image_policy: ImagePolicy;
  config: ContentSourceConfig | string;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: Date | string | null;
  last_success_at: Date | string | null;
  last_error: string | null;
  consecutive_errors: number;
}

function mapSource(row: SourceRow): ContentSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    enabled: row.enabled,
    trustScore: Number(row.trust_score),
    countyScoped: row.county_scoped,
    imagePolicy: row.image_policy,
    config: jsonValue(row.config, {}),
    etag: row.etag,
    lastModified: row.last_modified,
    lastFetchedAt: iso(row.last_fetched_at),
    lastSuccessAt: iso(row.last_success_at),
    lastError: row.last_error,
    consecutiveErrors: row.consecutive_errors,
  };
}

export async function listContentSources(enabledOnly = false): Promise<ContentSource[]> {
  const rows = enabledOnly
    ? await sql<SourceRow>`SELECT * FROM content_sources WHERE enabled = true ORDER BY trust_score DESC, name`
    : await sql<SourceRow>`SELECT * FROM content_sources ORDER BY enabled DESC, trust_score DESC, name`;
  return rows.map(mapSource);
}

export async function createContentSource(input: {
  name: string;
  kind: ContentSourceKind;
  url: string;
  enabled?: boolean;
  trustScore?: number;
  countyScoped?: boolean;
  imagePolicy?: ImagePolicy;
  config?: ContentSourceConfig;
}): Promise<ContentSource> {
  const rows = await sql<SourceRow>`
    INSERT INTO content_sources (
      name, kind, url, enabled, trust_score, county_scoped, image_policy, config
    ) VALUES (
      ${input.name}, ${input.kind}, ${input.url}, ${input.enabled ?? true},
      ${input.trustScore ?? 0.6}, ${input.countyScoped ?? false},
      ${input.imagePolicy ?? 'none'}, ${JSON.stringify(input.config || {})}::jsonb
    )
    RETURNING *`;
  return mapSource(rows[0]);
}

export async function updateContentSource(input: ContentSource): Promise<ContentSource | null> {
  const rows = await sql<SourceRow>`
    UPDATE content_sources SET
      name = ${input.name}, kind = ${input.kind}, url = ${input.url}, enabled = ${input.enabled},
      trust_score = ${input.trustScore}, county_scoped = ${input.countyScoped},
      image_policy = ${input.imagePolicy}, config = ${JSON.stringify(input.config || {})}::jsonb
    WHERE id = ${input.id}
    RETURNING *`;
  return rows[0] ? mapSource(rows[0]) : null;
}

export async function recordSourceFetch(input: {
  id: string;
  success: boolean;
  etag?: string | null;
  lastModified?: string | null;
  error?: string | null;
}): Promise<void> {
  if (input.success) {
    await sql`
      UPDATE content_sources SET
        last_fetched_at = now(), last_success_at = now(), last_error = NULL,
        consecutive_errors = 0, etag = COALESCE(${input.etag ?? null}, etag),
        last_modified = COALESCE(${input.lastModified ?? null}, last_modified)
      WHERE id = ${input.id}`;
  } else {
    await sql`
      UPDATE content_sources SET
        last_fetched_at = now(), last_error = ${String(input.error || 'Unknown source error').slice(0, 1000)},
        consecutive_errors = consecutive_errors + 1
      WHERE id = ${input.id}`;
  }
}

interface ItemRow {
  id: string;
  canonical_key: string;
  venue_name: string | null;
  title: string;
  description: string;
  event_start_at: Date | string | null;
  event_end_at: Date | string | null;
  all_day: boolean;
  neighborhood: string | null;
  area: string | null;
  address: string | null;
  confidence_score: string | number;
  status: NormalizedContentItem['status'];
  event_types: string[] | string;
  tags: string[] | string;
  image_urls: string[] | string;
  quality_flags: string[] | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

interface ProvenanceRow {
  item_id: string;
  source_id: string;
  source_name: string;
  source_kind: ContentSourceKind;
  source_url: string;
  external_id: string | null;
  source_title: string;
  source_description: string;
  source_published_at: Date | string | null;
  fetched_at: Date | string;
  image_urls: string[] | string;
  attribution: string | null;
  trust_score: string | number;
  image_policy: ImagePolicy;
  raw_payload: Record<string, unknown> | string;
}

function mapItem(row: ItemRow, provenance: ItemProvenance[] = []): NormalizedContentItem {
  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    venueName: row.venue_name,
    title: row.title,
    description: row.description,
    eventStartAt: iso(row.event_start_at),
    eventEndAt: iso(row.event_end_at),
    allDay: row.all_day,
    neighborhood: row.neighborhood,
    area: row.area,
    address: row.address,
    county: 'San Diego',
    confidenceScore: Number(row.confidence_score),
    status: row.status,
    eventTypes: jsonValue(row.event_types, []),
    tags: jsonValue(row.tags, []),
    imageUrls: jsonValue(row.image_urls, []),
    qualityFlags: jsonValue(row.quality_flags, []),
    provenance,
    firstSeenAt: iso(row.first_seen_at) || undefined,
    lastSeenAt: iso(row.last_seen_at) || undefined,
  };
}

async function loadProvenance(itemIds: string[], executor: QueryExecutor = sql): Promise<Map<string, ItemProvenance[]>> {
  const output = new Map<string, ItemProvenance[]>();
  if (!itemIds.length) return output;
  const rows = await executor<ProvenanceRow>`
    SELECT cis.*, cs.name AS source_name, cs.kind AS source_kind,
           cs.trust_score, cs.image_policy
    FROM content_item_sources cis
    LEFT JOIN content_sources cs ON cs.id = cis.source_id
    WHERE cis.item_id = ANY(${itemIds}::uuid[])
    ORDER BY cis.fetched_at DESC`;
  for (const row of rows) {
    const item: ItemProvenance = {
      sourceId: row.source_id,
      sourceName: row.source_name || 'Deleted source',
      sourceKind: row.source_kind || 'webhook',
      sourceUrl: row.source_url,
      externalId: row.external_id,
      sourceTitle: row.source_title,
      sourceDescription: row.source_description,
      sourcePublishedAt: iso(row.source_published_at),
      fetchedAt: iso(row.fetched_at)!,
      imageUrls: jsonValue(row.image_urls, []),
      attribution: row.attribution,
      trustScore: Number(row.trust_score || 0),
      imagePolicy: row.image_policy || 'none',
      raw: jsonValue(row.raw_payload, {}),
    };
    output.set(row.item_id, [...(output.get(row.item_id) || []), item]);
  }
  return output;
}

async function attachProvenance(rows: ItemRow[], executor: QueryExecutor = sql): Promise<NormalizedContentItem[]> {
  const provenance = await loadProvenance(rows.map((row) => row.id), executor);
  return rows.map((row) => mapItem(row, provenance.get(row.id) || []));
}

export async function listRecentContentItems(options: {
  limit?: number;
  unclusteredOnly?: boolean;
  includeRejected?: boolean;
} = {}): Promise<NormalizedContentItem[]> {
  const limit = Math.max(1, Math.min(1000, options.limit || 400));
  let rows: ItemRow[];
  if (options.unclusteredOnly) {
    rows = await sql<ItemRow>`
      SELECT ci.* FROM content_items ci
      WHERE ci.status IN ('candidate', 'review', 'accepted')
        AND NOT EXISTS (SELECT 1 FROM content_cluster_items cci WHERE cci.item_id = ci.id)
        AND (ci.event_start_at IS NULL OR ci.event_start_at >= now() - interval '1 day')
      ORDER BY ci.confidence_score DESC, ci.event_start_at NULLS LAST, ci.last_seen_at DESC
      LIMIT ${limit}`;
  } else if (options.includeRejected) {
    rows = await sql<ItemRow>`
      SELECT * FROM content_items ORDER BY last_seen_at DESC LIMIT ${limit}`;
  } else {
    rows = await sql<ItemRow>`
      SELECT * FROM content_items
      WHERE status <> 'rejected'
      ORDER BY last_seen_at DESC LIMIT ${limit}`;
  }
  return attachProvenance(rows);
}

async function writeProvenance(executor: QueryExecutor, itemId: string, sources: ItemProvenance[]): Promise<void> {
  for (const source of sources) {
    await executor`
      INSERT INTO content_item_sources (
        item_id, source_id, external_id, source_url, source_title, source_description,
        source_published_at, fetched_at, image_urls, attribution, raw_payload
      ) VALUES (
        ${itemId}, ${source.sourceId}, ${source.externalId || null}, ${source.sourceUrl},
        ${source.sourceTitle}, ${source.sourceDescription}, ${source.sourcePublishedAt || null},
        ${source.fetchedAt}, ${JSON.stringify(source.imageUrls)}::jsonb, ${source.attribution || null},
        ${JSON.stringify(source.raw || {})}::jsonb
      )
      ON CONFLICT (item_id, source_url) DO UPDATE SET
        source_title = EXCLUDED.source_title,
        source_description = EXCLUDED.source_description,
        source_published_at = COALESCE(EXCLUDED.source_published_at, content_item_sources.source_published_at),
        fetched_at = EXCLUDED.fetched_at,
        image_urls = EXCLUDED.image_urls,
        attribution = COALESCE(EXCLUDED.attribution, content_item_sources.attribution),
        raw_payload = EXCLUDED.raw_payload`;
  }
}

export async function saveContentItem(item: NormalizedContentItem): Promise<{ item: NormalizedContentItem; created: boolean }> {
  return withTransaction(async (tx) => {
    let rows: ItemRow[];
    let created = false;
    if (item.id) {
      rows = await tx<ItemRow>`
        UPDATE content_items SET
          venue_name = ${item.venueName || null}, title = ${item.title}, description = ${item.description},
          event_start_at = ${item.eventStartAt || null}, event_end_at = ${item.eventEndAt || null},
          all_day = ${item.allDay}, neighborhood = ${item.neighborhood || null}, area = ${item.area || null},
          address = ${item.address || null}, confidence_score = ${item.confidenceScore}, status = ${item.status},
          event_types = ${JSON.stringify(item.eventTypes)}::jsonb, tags = ${JSON.stringify(item.tags)}::jsonb,
          image_urls = ${JSON.stringify(item.imageUrls)}::jsonb,
          quality_flags = ${JSON.stringify(item.qualityFlags)}::jsonb, last_seen_at = now()
        WHERE id = ${item.id}
        RETURNING *`;
    } else {
      rows = await tx<ItemRow>`
        INSERT INTO content_items (
          canonical_key, venue_name, title, description, event_start_at, event_end_at,
          all_day, neighborhood, area, address, confidence_score, status,
          event_types, tags, image_urls, quality_flags
        ) VALUES (
          ${item.canonicalKey}, ${item.venueName || null}, ${item.title}, ${item.description},
          ${item.eventStartAt || null}, ${item.eventEndAt || null}, ${item.allDay},
          ${item.neighborhood || null}, ${item.area || null}, ${item.address || null},
          ${item.confidenceScore}, ${item.status}, ${JSON.stringify(item.eventTypes)}::jsonb,
          ${JSON.stringify(item.tags)}::jsonb, ${JSON.stringify(item.imageUrls)}::jsonb,
          ${JSON.stringify(item.qualityFlags)}::jsonb
        )
        ON CONFLICT (canonical_key) DO UPDATE SET last_seen_at = now()
        RETURNING *, (xmax = 0) AS inserted`;
      created = Boolean((rows[0] as any)?.inserted);
    }
    if (!rows[0]) throw new Error('Content item disappeared while saving.');
    await writeProvenance(tx, rows[0].id, item.provenance);
    const provenance = await loadProvenance([rows[0].id], tx);
    return { item: mapItem(rows[0], provenance.get(rows[0].id) || []), created };
  });
}

interface ClusterRow {
  id: string;
  angle: string;
  working_title: string;
  summary: string;
  cluster_type: EditorialCluster['clusterType'];
  editorial_score: string | number;
  confidence_score: string | number;
  event_start_at: Date | string | null;
  event_end_at: Date | string | null;
  tags: string[] | string;
  signature: string;
}

function mapCluster(row: ClusterRow, items: NormalizedContentItem[]): EditorialCluster {
  return {
    id: row.id,
    angle: row.angle,
    workingTitle: row.working_title,
    summary: row.summary,
    clusterType: row.cluster_type,
    editorialScore: Number(row.editorial_score),
    confidenceScore: Number(row.confidence_score),
    eventStartAt: iso(row.event_start_at),
    eventEndAt: iso(row.event_end_at),
    tags: jsonValue(row.tags, []),
    signature: row.signature,
    items,
  };
}

export async function saveEditorialCluster(cluster: EditorialCluster): Promise<{ cluster: EditorialCluster; created: boolean }> {
  return withTransaction(async (tx) => {
    const rows = await tx<ClusterRow & { inserted: boolean }>`
      INSERT INTO content_clusters (
        angle, working_title, summary, cluster_type, editorial_score, confidence_score,
        event_start_at, event_end_at, tags, signature
      ) VALUES (
        ${cluster.angle}, ${cluster.workingTitle}, ${cluster.summary}, ${cluster.clusterType},
        ${cluster.editorialScore}, ${cluster.confidenceScore}, ${cluster.eventStartAt || null},
        ${cluster.eventEndAt || null}, ${JSON.stringify(cluster.tags)}::jsonb, ${cluster.signature}
      )
      ON CONFLICT (signature) DO UPDATE SET updated_at = now()
      RETURNING *, (xmax = 0) AS inserted`;
    const row = rows[0];
    for (let index = 0; index < cluster.items.length; index++) {
      const itemId = cluster.items[index].id;
      if (!itemId) continue;
      await tx`
        INSERT INTO content_cluster_items (cluster_id, item_id, role, position)
        VALUES (${row.id}, ${itemId}, ${index === 0 ? 'lead' : 'supporting'}, ${index})
        ON CONFLICT (cluster_id, item_id) DO UPDATE SET position = EXCLUDED.position`;
    }
    return { cluster: mapCluster(row, cluster.items), created: Boolean(row.inserted) };
  });
}

export async function getEditorialCluster(id: string): Promise<EditorialCluster | null> {
  const rows = await sql<ClusterRow>`SELECT * FROM content_clusters WHERE id = ${id}`;
  if (!rows[0]) return null;
  const itemRows = await sql<ItemRow>`
    SELECT ci.* FROM content_cluster_items cci
    JOIN content_items ci ON ci.id = cci.item_id
    WHERE cci.cluster_id = ${id}
    ORDER BY cci.position`;
  return mapCluster(rows[0], await attachProvenance(itemRows));
}

export async function listEditorialClusters(limit = 100): Promise<EditorialCluster[]> {
  const rows = await sql<ClusterRow>`
    SELECT * FROM content_clusters ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}`;
  return Promise.all(rows.map(async (row) => (await getEditorialCluster(row.id))!));
}

interface DraftRow {
  id: string;
  cluster_id: string;
  content_type: GeneratedDraft['contentType'];
  status: NonNullable<GeneratedDraft['status']>;
  title: string;
  slug: string | null;
  description: string;
  body_markdown: string;
  seo_metadata: GeneratedDraft['seoMetadata'] | string;
  structured_blocks: Array<Record<string, unknown>> | string;
  tags: string[] | string;
  dates: string[] | string;
  locations: string[] | string;
  brands: string[] | string;
  event_types: string[] | string;
  hero_image_url: string | null;
  image_metadata: Record<string, unknown> | string;
  quality_score: string | number;
  quality_flags: string[] | string;
  scheduled_for: Date | string | null;
  approved_at: Date | string | null;
  published_at: Date | string | null;
  github_path: string | null;
  generation_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapDraft(row: DraftRow): GeneratedDraft {
  return {
    id: row.id,
    clusterId: row.cluster_id,
    contentType: row.content_type,
    status: row.status,
    title: row.title,
    slug: row.slug,
    description: row.description,
    bodyMarkdown: row.body_markdown,
    seoMetadata: jsonValue(row.seo_metadata, {
      metaDescription: row.description, ogTitle: row.title, ogDescription: row.description, hashtags: [],
    }),
    structuredBlocks: jsonValue(row.structured_blocks, []),
    tags: jsonValue(row.tags, []),
    dates: jsonValue(row.dates, []),
    locations: jsonValue(row.locations, []),
    brands: jsonValue(row.brands, []),
    eventTypes: jsonValue(row.event_types, []),
    heroImageUrl: row.hero_image_url,
    imageMetadata: jsonValue(row.image_metadata, {}),
    qualityScore: Number(row.quality_score),
    qualityFlags: jsonValue(row.quality_flags, []),
    scheduledFor: iso(row.scheduled_for),
    approvedAt: iso(row.approved_at),
    publishedAt: iso(row.published_at),
    githubPath: row.github_path,
    generationVersion: row.generation_version,
    createdAt: iso(row.created_at) || undefined,
    updatedAt: iso(row.updated_at) || undefined,
  };
}

export async function saveGeneratedDraft(clusterId: string, draft: GeneratedDraft): Promise<GeneratedDraft> {
  const rows = await sql<DraftRow>`
    INSERT INTO content_drafts (
      cluster_id, content_type, status, title, slug, description, body_markdown,
      seo_metadata, structured_blocks, tags, dates, locations, brands, event_types,
      hero_image_url, image_metadata, quality_score, quality_flags, generation_version
    ) VALUES (
      ${clusterId}, ${draft.contentType}, ${draft.status || 'review'}, ${draft.title},
      ${draft.slug || null}, ${draft.description}, ${draft.bodyMarkdown},
      ${JSON.stringify(draft.seoMetadata)}::jsonb, ${JSON.stringify(draft.structuredBlocks || [])}::jsonb,
      ${JSON.stringify(draft.tags)}::jsonb, ${JSON.stringify(draft.dates)}::jsonb,
      ${JSON.stringify(draft.locations)}::jsonb, ${JSON.stringify(draft.brands)}::jsonb,
      ${JSON.stringify(draft.eventTypes)}::jsonb, ${draft.heroImageUrl || null},
      ${JSON.stringify(draft.imageMetadata || {})}::jsonb, ${draft.qualityScore},
      ${JSON.stringify(draft.qualityFlags)}::jsonb, ${draft.generationVersion || 1}
    )
    ON CONFLICT (cluster_id, content_type) DO UPDATE SET
      status = 'review', title = EXCLUDED.title, slug = EXCLUDED.slug,
      description = EXCLUDED.description, body_markdown = EXCLUDED.body_markdown,
      seo_metadata = EXCLUDED.seo_metadata, structured_blocks = EXCLUDED.structured_blocks,
      tags = EXCLUDED.tags, dates = EXCLUDED.dates, locations = EXCLUDED.locations,
      brands = EXCLUDED.brands, event_types = EXCLUDED.event_types,
      quality_score = EXCLUDED.quality_score, quality_flags = EXCLUDED.quality_flags,
      generation_version = content_drafts.generation_version + 1
    RETURNING *`;
  await sql`
    UPDATE content_clusters SET status = 'drafted' WHERE id = ${clusterId}`;
  return mapDraft(rows[0]);
}

export async function listGeneratedDrafts(options: { status?: string; limit?: number } = {}): Promise<GeneratedDraft[]> {
  const limit = Math.max(1, Math.min(500, options.limit || 200));
  const rows = options.status
    ? await sql<DraftRow>`SELECT * FROM content_drafts WHERE status = ${options.status} ORDER BY created_at DESC LIMIT ${limit}`
    : await sql<DraftRow>`SELECT * FROM content_drafts ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(mapDraft);
}

export async function listClustersAwaitingDrafts(limit = 25): Promise<EditorialCluster[]> {
  const rows = await sql<ClusterRow>`
    SELECT cc.* FROM content_clusters cc
    WHERE cc.status <> 'rejected'
      AND (SELECT count(DISTINCT cd.content_type) FROM content_drafts cd WHERE cd.cluster_id = cc.id) < 2
    ORDER BY cc.editorial_score DESC, cc.created_at
    LIMIT ${Math.max(1, Math.min(100, limit))}`;
  return Promise.all(rows.map(async (row) => (await getEditorialCluster(row.id))!));
}

export async function getGeneratedDraft(id: string): Promise<GeneratedDraft | null> {
  const rows = await sql<DraftRow>`SELECT * FROM content_drafts WHERE id = ${id}`;
  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function updateGeneratedDraft(input: GeneratedDraft & { id: string }): Promise<GeneratedDraft | null> {
  const rows = await sql<DraftRow>`
    UPDATE content_drafts SET
      title = ${input.title}, slug = ${input.slug || null}, description = ${input.description},
      body_markdown = ${input.bodyMarkdown}, seo_metadata = ${JSON.stringify(input.seoMetadata)}::jsonb,
      structured_blocks = ${JSON.stringify(input.structuredBlocks || [])}::jsonb,
      tags = ${JSON.stringify(input.tags)}::jsonb, dates = ${JSON.stringify(input.dates)}::jsonb,
      locations = ${JSON.stringify(input.locations)}::jsonb, brands = ${JSON.stringify(input.brands)}::jsonb,
      event_types = ${JSON.stringify(input.eventTypes)}::jsonb, hero_image_url = ${input.heroImageUrl || null},
      image_metadata = ${JSON.stringify(input.imageMetadata || {})}::jsonb,
      quality_score = ${input.qualityScore}, quality_flags = ${JSON.stringify(input.qualityFlags)}::jsonb
    WHERE id = ${input.id}
    RETURNING *`;
  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function setDraftLifecycle(input: {
  id: string;
  status: NonNullable<GeneratedDraft['status']>;
  scheduledFor?: string | null;
  githubPath?: string | null;
}): Promise<GeneratedDraft | null> {
  const approvedAt = input.status === 'approved' || input.status === 'scheduled' || input.status === 'published'
    ? new Date().toISOString() : null;
  const publishedAt = input.status === 'published' ? new Date().toISOString() : null;
  const rows = await sql<DraftRow>`
    UPDATE content_drafts SET
      status = ${input.status}, scheduled_for = ${input.scheduledFor || null},
      approved_at = COALESCE(approved_at, ${approvedAt}),
      published_at = COALESCE(published_at, ${publishedAt}),
      github_path = COALESCE(${input.githubPath || null}, github_path)
    WHERE id = ${input.id}
    RETURNING *`;
  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function getContentEngineSettings(): Promise<ContentEngineSettings> {
  const rows = await sql<any>`SELECT * FROM content_engine_settings WHERE singleton = true`;
  const row = rows[0];
  return {
    paused: Boolean(row.paused),
    autoPublishEnabled: Boolean(row.auto_publish_enabled),
    autoPublishMinQuality: Number(row.auto_publish_min_quality),
    minItemConfidence: Number(row.min_item_confidence),
    minClusterScore: Number(row.min_cluster_score),
    requireMultipleSources: Boolean(row.require_multiple_sources),
    generateImages: Boolean(row.generate_images),
    runSchedule: row.run_schedule,
  };
}

export async function saveContentEngineSettings(settings: ContentEngineSettings): Promise<ContentEngineSettings> {
  await sql`
    UPDATE content_engine_settings SET
      paused = ${settings.paused},
      auto_publish_enabled = ${settings.autoPublishEnabled},
      auto_publish_min_quality = ${settings.autoPublishMinQuality},
      min_item_confidence = ${settings.minItemConfidence},
      min_cluster_score = ${settings.minClusterScore},
      require_multiple_sources = ${settings.requireMultipleSources},
      generate_images = ${settings.generateImages}, run_schedule = ${settings.runSchedule}
    WHERE singleton = true`;
  return getContentEngineSettings();
}

export async function startIngestionRun(triggerType: IngestionRunSummary['triggerType']): Promise<string> {
  const rows = await sql<{ id: string }>`
    INSERT INTO content_ingestion_runs (trigger_type) VALUES (${triggerType}) RETURNING id`;
  return rows[0].id;
}

export async function finishIngestionRun(summary: IngestionRunSummary): Promise<void> {
  if (!summary.runId) return;
  
  // Calculate costs for this run from ai_usage_log
  let costs = { contentGeneration: 0, clusterRefinement: 0, imageGeneration: 0, total: 0 };
  try {
    const costRows = await sql<any>`
      SELECT feature, COALESCE(sum(cost_cents), 0)::numeric AS cost_cents
      FROM ai_usage_log WHERE content_run_id = ${summary.runId} GROUP BY feature`;
    for (const row of costRows) {
      const cents = Number(row.cost_cents);
      costs.total += cents;
      if (row.feature === 'content_engine_draft' || row.feature === 'content_engine_newsletter') {
        costs.contentGeneration += cents;
      } else if (row.feature === 'content_engine_cluster_refinement') {
        costs.clusterRefinement += cents;
      } else if (row.feature === 'content_engine_image') {
        costs.imageGeneration += cents;
      }
    }
  } catch { /* Cost tracking is optional */ }
  
  await sql`
    UPDATE content_ingestion_runs SET
      status = ${summary.status}, sources_attempted = ${summary.sourcesAttempted},
      sources_succeeded = ${summary.sourcesSucceeded}, items_fetched = ${summary.itemsFetched},
      items_created = ${summary.itemsCreated}, items_merged = ${summary.itemsMerged},
      items_outside_county = ${summary.itemsOutsideCounty}, clusters_created = ${summary.clustersCreated},
      drafts_created = ${summary.draftsCreated}, errors = ${JSON.stringify(summary.errors)}::jsonb,
      costs = ${JSON.stringify(costs)}::jsonb,
      finished_at = now()
    WHERE id = ${summary.runId}`;
}

export type ContentEngineEventName =
  | 'source_fetched' | 'item_created' | 'item_merged' | 'item_rejected'
  | 'cluster_created' | 'draft_created' | 'draft_approved' | 'draft_rejected'
  | 'post_scheduled' | 'post_published' | 'newsletter_created'
  | 'image_attached' | 'image_generated' | 'image_failed'
  | 'article_view' | 'article_link_click';

export async function recordContentEngineEvent(input: {
  eventName: ContentEngineEventName;
  sourceId?: string | null;
  itemId?: string | null;
  clusterId?: string | null;
  draftId?: string | null;
  properties?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO content_engine_events (
      event_name, source_id, item_id, cluster_id, draft_id, properties
    ) VALUES (
      ${input.eventName}, ${input.sourceId || null}, ${input.itemId || null},
      ${input.clusterId || null}, ${input.draftId || null}, ${JSON.stringify(input.properties || {})}::jsonb
    )`;
}

function computeNextScheduledRun(settings: ContentEngineSettings): string | null {
  if (settings.paused || settings.runSchedule === 'manual') return null;

  const now = new Date();
  // Schedule runs at 15:05 UTC and 23:05 UTC (twice_daily) or just 15:05 UTC (daily)
  const scheduleHours = settings.runSchedule === 'daily' ? [15] : [15, 23];
  const scheduleMinute = 5;

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const hour of scheduleHours) {
      const candidate = new Date(now);
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      candidate.setUTCHours(hour, scheduleMinute, 0, 0);
      if (candidate > now) return candidate.toISOString();
    }
  }
  // Fallback: next occurrence of first scheduled hour tomorrow
  const fallback = new Date(now);
  fallback.setUTCDate(fallback.getUTCDate() + 1);
  fallback.setUTCHours(scheduleHours[0], scheduleMinute, 0, 0);
  return fallback.toISOString();
}

export async function contentEngineOverview(): Promise<Record<string, unknown>> {
  const [counts, recentRuns, analytics, settings] = await Promise.all([
    sql<any>`SELECT
      (SELECT count(*) FROM content_sources WHERE enabled) AS enabled_sources,
      (SELECT count(*) FROM content_items) AS items,
      (SELECT count(*) FROM content_items WHERE status = 'review') AS items_in_review,
      (SELECT count(*) FROM content_clusters) AS clusters,
      (SELECT count(*) FROM content_drafts WHERE status = 'review') AS drafts_in_review,
      (SELECT count(*) FROM content_drafts WHERE status = 'scheduled') AS scheduled,
      (SELECT count(*) FROM content_drafts WHERE status = 'published') AS published,
      (SELECT count(*) FROM content_drafts WHERE content_type = 'blog') AS articles,
      (SELECT count(*) FROM content_drafts WHERE content_type = 'newsletter') AS newsletters`,
    sql<any>`SELECT * FROM content_ingestion_runs ORDER BY started_at DESC LIMIT 10`,
    sql<any>`
      SELECT event_name, count(*)::integer AS count
      FROM content_engine_events
      WHERE created_at >= now() - interval '30 days'
      GROUP BY event_name ORDER BY event_name`,
    getContentEngineSettings(),
  ]);

  const lastRun = recentRuns[0] || null;
  const lastRunAt = lastRun?.started_at ? new Date(lastRun.started_at).toISOString() : null;
  const nextScheduledRun = computeNextScheduledRun(settings);

  return { counts: counts[0], recentRuns, analytics, lastRunAt, nextScheduledRun };
}

export async function listDueScheduledDrafts(): Promise<GeneratedDraft[]> {
  const rows = await sql<DraftRow>`
    SELECT * FROM content_drafts
    WHERE status = 'scheduled' AND scheduled_for <= now()
    ORDER BY scheduled_for LIMIT 25`;
  return rows.map(mapDraft);
}
