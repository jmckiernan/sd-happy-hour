export type ContentSourceKind =
  | 'rss'
  | 'atom'
  | 'google_alert'
  | 'reddit_rss'
  | 'json_ld'
  | 'webhook';

export type ImagePolicy = 'none' | 'first_party' | 'attributed';

export interface ContentSourceConfig {
  publisher?: string;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  defaultArea?: string;
  defaultVenue?: string;
  attribution?: string;
  requestHeaders?: Record<string, string>;
}

export interface ContentSource {
  id: string;
  name: string;
  kind: ContentSourceKind;
  url: string;
  enabled: boolean;
  trustScore: number;
  countyScoped: boolean;
  imagePolicy: ImagePolicy;
  config: ContentSourceConfig;
  etag?: string | null;
  lastModified?: string | null;
  lastFetchedAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  consecutiveErrors?: number;
}

export interface RawSourceItem {
  externalId?: string | null;
  url: string;
  title: string;
  description?: string | null;
  venueName?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  allDay?: boolean;
  neighborhood?: string | null;
  area?: string | null;
  address?: string | null;
  county?: string | null;
  publishedAt?: string | null;
  imageUrls?: string[];
  eventTypes?: string[];
  tags?: string[];
  attribution?: string | null;
  raw?: Record<string, unknown>;
}

export interface ItemProvenance {
  sourceId: string;
  sourceName: string;
  sourceKind: ContentSourceKind;
  sourceUrl: string;
  externalId?: string | null;
  sourceTitle: string;
  sourceDescription: string;
  sourcePublishedAt?: string | null;
  fetchedAt: string;
  imageUrls: string[];
  attribution?: string | null;
  trustScore: number;
  imagePolicy: ImagePolicy;
  raw: Record<string, unknown>;
}

export type ContentItemStatus = 'candidate' | 'review' | 'accepted' | 'rejected' | 'expired';

export interface NormalizedContentItem {
  id?: string;
  canonicalKey: string;
  venueName?: string | null;
  title: string;
  description: string;
  eventStartAt?: string | null;
  eventEndAt?: string | null;
  allDay: boolean;
  neighborhood?: string | null;
  area?: string | null;
  address?: string | null;
  county: 'San Diego';
  confidenceScore: number;
  status: ContentItemStatus;
  eventTypes: string[];
  tags: string[];
  imageUrls: string[];
  qualityFlags: string[];
  provenance: ItemProvenance[];
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface NormalizationResult {
  accepted: boolean;
  reason?: string;
  item?: NormalizedContentItem;
}

export type ClusterType =
  | 'single'
  | 'date_roundup'
  | 'weekend_roundup'
  | 'neighborhood_roundup'
  | 'event_type_roundup'
  | 'evergreen';

export interface EditorialCluster {
  id?: string;
  angle: string;
  workingTitle: string;
  summary: string;
  clusterType: ClusterType;
  editorialScore: number;
  confidenceScore: number;
  eventStartAt?: string | null;
  eventEndAt?: string | null;
  tags: string[];
  signature: string;
  items: NormalizedContentItem[];
}

export interface SeoMetadata {
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  hashtags: string[];
  searchIntent?: string;
}

export interface GeneratedDraft {
  id?: string;
  clusterId?: string;
  contentType: 'blog' | 'newsletter';
  status?: 'generating' | 'review' | 'approved' | 'rejected' | 'scheduled' | 'published' | 'error';
  title: string;
  slug?: string | null;
  description: string;
  bodyMarkdown: string;
  seoMetadata: SeoMetadata;
  structuredBlocks?: Array<Record<string, unknown>>;
  tags: string[];
  dates: string[];
  locations: string[];
  brands: string[];
  eventTypes: string[];
  heroImageUrl?: string | null;
  imageMetadata?: Record<string, unknown>;
  qualityScore: number;
  qualityFlags: string[];
  scheduledFor?: string | null;
  approvedAt?: string | null;
  publishedAt?: string | null;
  githubPath?: string | null;
  generationVersion?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentEngineSettings {
  paused: boolean;
  autoPublishEnabled: boolean;
  autoPublishMinQuality: number;
  minItemConfidence: number;
  minClusterScore: number;
  requireMultipleSources: boolean;
  generateImages: boolean;
  runSchedule: string;
}

export interface IngestionRunSummary {
  runId?: string;
  triggerType: 'scheduled' | 'manual' | 'event';
  status: 'running' | 'completed' | 'partial' | 'failed';
  sourcesAttempted: number;
  sourcesSucceeded: number;
  itemsFetched: number;
  itemsCreated: number;
  itemsMerged: number;
  itemsOutsideCounty: number;
  clustersCreated: number;
  draftsCreated: number;
  errors: Array<{ source?: string; stage: string; message: string }>;
}
