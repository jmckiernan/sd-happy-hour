// Centralized AI usage tracking for cost monitoring and analytics.
// All AI API calls should use this module to record usage.

import { sql } from './db';

export type APIProvider = 'anthropic' | 'gemini' | 'openai' | 'google_places' | 'resend' | 'twilio';
// Alias for backwards compatibility
export type AIProvider = APIProvider;

export type APIFeature =
  | 'content_engine_draft'
  | 'content_engine_newsletter'
  | 'content_engine_cluster_refinement'
  | 'content_engine_image'
  | 'manual_draft_generation'
  | 'admin_image_generation'
  | 'admin_image_edit'
  | 'photo_moderation'
  | 'email_alert'
  | 'sms_alert'
  | 'venue_import'
  | 'other';
// Alias for backwards compatibility
export type AIFeature = APIFeature;

export interface AIUsageRecord {
  provider: APIProvider;
  model: string;
  feature: APIFeature;
  contentRunId?: string | null;
  draftId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  imageCount?: number | null;
  messageCount?: number | null;
  costCents: number;
  requestMetadata?: Record<string, unknown>;
  success: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
}

// Pricing in USD per 1M tokens, per image, or per message (as of late 2026)
// Update these when pricing changes
const PRICING = {
  anthropic: {
    // Claude Sonnet 4/5 pricing
    'claude-sonnet-4': { input: 3.00, output: 15.00 },
    'claude-sonnet-5': { input: 3.00, output: 15.00 },
    'claude-opus-4': { input: 15.00, output: 75.00 },
    // Default fallback
    default: { input: 3.00, output: 15.00 },
  },
  gemini: {
    // Gemini Flash pricing (very cheap)
    'gemini-2.5-flash': { input: 0.075, output: 0.30 },
    'gemini-2.5-flash-image': { perImage: 0.02 }, // $0.02 per image
    'gemini-3.6-flash': { input: 0.075, output: 0.30 },
    // Default fallback
    default: { input: 0.10, output: 0.40, perImage: 0.02 },
  },
  openai: {
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    default: { input: 2.50, output: 10.00 },
  },
  // Google Places API pricing (per 1,000 requests)
  google_places: {
    'nearby_search': { perRequest: 35.00 / 1000 }, // $35/1k - Enterprise
    'place_details': { perRequest: 20.00 / 1000 }, // $20/1k - Enterprise
    'place_details_atmosphere': { perRequest: 25.00 / 1000 }, // $25/1k
    'place_details_essentials': { perRequest: 5.00 / 1000 }, // $5/1k (first 10k free)
    'place_photo': { perRequest: 7.00 / 1000 }, // $7/1k
    'text_search': { perRequest: 35.00 / 1000 }, // $35/1k
    default: { perRequest: 20.00 / 1000 },
  },
  // Resend email pricing - free tier up to 3k/month, then $0.00028/email
  resend: {
    email: { perMessage: 0 }, // Free tier - update if you exceed
    default: { perMessage: 0 },
  },
  // Twilio SMS pricing
  twilio: {
    sms: { perMessage: 0.0079 }, // ~$0.0079 per SMS segment
    default: { perMessage: 0.0079 },
  },
} as const;

/**
 * Calculate cost in USD cents based on token usage, image count, or message count.
 */
export function calculateCost(input: {
  provider: APIProvider;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  imageCount?: number | null;
  messageCount?: number | null;
  requestCount?: number | null;
}): number {
  const providerPricing = PRICING[input.provider] || PRICING.anthropic;
  const modelPricing = (providerPricing as any)[input.model] || (providerPricing as any).default;

  let costUsd = 0;

  // Text token costs (per 1M tokens)
  if (input.inputTokens && modelPricing.input) {
    costUsd += (input.inputTokens / 1_000_000) * modelPricing.input;
  }
  if (input.outputTokens && modelPricing.output) {
    costUsd += (input.outputTokens / 1_000_000) * modelPricing.output;
  }

  // Image costs
  if (input.imageCount && modelPricing.perImage) {
    costUsd += input.imageCount * modelPricing.perImage;
  }

  // Message costs (email/SMS)
  if (input.messageCount && modelPricing.perMessage) {
    costUsd += input.messageCount * modelPricing.perMessage;
  }

  // Per-request costs (Google Places API)
  if (input.requestCount && modelPricing.perRequest) {
    costUsd += input.requestCount * modelPricing.perRequest;
  }

  // Convert to cents and round to 4 decimal places
  return Math.round(costUsd * 100 * 10000) / 10000;
}

/**
 * Record an API usage event to the database.
 */
export async function recordAIUsage(record: AIUsageRecord): Promise<void> {
  try {
    await sql`
      INSERT INTO ai_usage_log (
        provider, model, feature, content_run_id, draft_id,
        input_tokens, output_tokens, image_count, message_count, cost_cents,
        request_metadata, success, error_message, duration_ms
      ) VALUES (
        ${record.provider}, ${record.model}, ${record.feature},
        ${record.contentRunId || null}, ${record.draftId || null},
        ${record.inputTokens || null}, ${record.outputTokens || null},
        ${record.imageCount || null}, ${record.messageCount || null}, ${record.costCents},
        ${JSON.stringify(record.requestMetadata || {})}::jsonb,
        ${record.success}, ${record.errorMessage || null},
        ${record.durationMs || null}
      )`;
  } catch (error) {
    // Don't let usage tracking failures break the main flow
    console.warn('[api-usage] Failed to record usage:', error);
  }
}

/**
 * Helper to wrap an AI API call with automatic usage tracking.
 */
export async function trackAICall<T>(
  options: {
    provider: AIProvider;
    model: string;
    feature: AIFeature;
    contentRunId?: string | null;
    draftId?: string | null;
    metadata?: Record<string, unknown>;
  },
  fn: () => Promise<{
    result: T;
    inputTokens?: number;
    outputTokens?: number;
    imageCount?: number;
  }>
): Promise<T> {
  const startTime = Date.now();
  let success = true;
  let errorMessage: string | null = null;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let imageCount: number | undefined;
  let result: T;

  try {
    const response = await fn();
    result = response.result;
    inputTokens = response.inputTokens;
    outputTokens = response.outputTokens;
    imageCount = response.imageCount;
  } catch (error) {
    success = false;
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const durationMs = Date.now() - startTime;
    const costCents = calculateCost({
      provider: options.provider,
      model: options.model,
      inputTokens,
      outputTokens,
      imageCount,
    });

    // Fire and forget - don't await
    recordAIUsage({
      provider: options.provider,
      model: options.model,
      feature: options.feature,
      contentRunId: options.contentRunId,
      draftId: options.draftId,
      inputTokens,
      outputTokens,
      imageCount,
      costCents,
      requestMetadata: options.metadata,
      success,
      errorMessage,
      durationMs,
    }).catch(() => {});
  }

  return result!;
}

// ============================================================================
// Dashboard/Analytics Queries
// ============================================================================

export interface DailyCostSummary {
  day: string;
  provider: AIProvider;
  model: string;
  feature: AIFeature;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalImages: number;
  totalCostCents: number;
  successCount: number;
  errorCount: number;
}

export interface CostOverview {
  totalCostCents: number;
  totalCalls: number;
  byProvider: Array<{ provider: string; costCents: number; calls: number }>;
  byFeature: Array<{ feature: string; costCents: number; calls: number }>;
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  recentCalls: Array<{
    id: string;
    provider: string;
    model: string;
    feature: string;
    costCents: number;
    inputTokens: number | null;
    outputTokens: number | null;
    imageCount: number | null;
    messageCount: number | null;
    success: boolean;
    createdAt: string;
  }>;
}

/**
 * Refresh the daily summary materialized view.
 * Call this periodically (e.g., every hour or after batch operations).
 */
export async function refreshDailySummary(): Promise<void> {
  await sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ai_usage_daily_summary`;
}

/**
 * Get cost summary for a date range.
 */
export async function getCostSummary(options: {
  startDate?: string;
  endDate?: string;
} = {}): Promise<CostOverview> {
  const startDate = options.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endDate = options.endDate || new Date().toISOString().slice(0, 10);

  const [totals, byProvider, byFeature, byModel, recentCalls] = await Promise.all([
    sql<any>`
      SELECT 
        COALESCE(sum(cost_cents), 0)::numeric AS total_cost_cents,
        count(*)::integer AS total_calls
      FROM ai_usage_log
      WHERE created_at >= ${startDate}::date
        AND created_at < (${endDate}::date + interval '1 day')
    `,
    sql<any>`
      SELECT 
        provider,
        COALESCE(sum(cost_cents), 0)::numeric AS cost_cents,
        count(*)::integer AS calls
      FROM ai_usage_log
      WHERE created_at >= ${startDate}::date
        AND created_at < (${endDate}::date + interval '1 day')
      GROUP BY provider
      ORDER BY cost_cents DESC
    `,
    sql<any>`
      SELECT 
        feature,
        COALESCE(sum(cost_cents), 0)::numeric AS cost_cents,
        count(*)::integer AS calls
      FROM ai_usage_log
      WHERE created_at >= ${startDate}::date
        AND created_at < (${endDate}::date + interval '1 day')
      GROUP BY feature
      ORDER BY cost_cents DESC
    `,
    sql<any>`
      SELECT 
        model,
        COALESCE(sum(cost_cents), 0)::numeric AS cost_cents,
        count(*)::integer AS calls
      FROM ai_usage_log
      WHERE created_at >= ${startDate}::date
        AND created_at < (${endDate}::date + interval '1 day')
      GROUP BY model
      ORDER BY cost_cents DESC
    `,
    sql<any>`
      SELECT 
        id, provider, model, feature, cost_cents,
        input_tokens, output_tokens, image_count, message_count, success, created_at
      FROM ai_usage_log
      WHERE created_at >= ${startDate}::date
        AND created_at < (${endDate}::date + interval '1 day')
      ORDER BY created_at DESC
      LIMIT 100
    `,
  ]);

  return {
    totalCostCents: Number(totals[0]?.total_cost_cents || 0),
    totalCalls: totals[0]?.total_calls || 0,
    byProvider: byProvider.map((row: any) => ({
      provider: row.provider,
      costCents: Number(row.cost_cents),
      calls: row.calls,
    })),
    byFeature: byFeature.map((row: any) => ({
      feature: row.feature,
      costCents: Number(row.cost_cents),
      calls: row.calls,
    })),
    byModel: byModel.map((row: any) => ({
      model: row.model,
      costCents: Number(row.cost_cents),
      calls: row.calls,
    })),
    recentCalls: recentCalls.map((row: any) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      feature: row.feature,
      costCents: Number(row.cost_cents),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      imageCount: row.image_count,
      messageCount: row.message_count,
      success: row.success,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/**
 * Get daily cost breakdown for charting.
 */
export async function getDailyCosts(options: {
  days?: number;
} = {}): Promise<Array<{ day: string; costCents: number; calls: number }>> {
  const days = options.days || 30;
  const rows = await sql<any>`
    SELECT 
      date_trunc('day', created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
      COALESCE(sum(cost_cents), 0)::numeric AS cost_cents,
      count(*)::integer AS calls
    FROM ai_usage_log
    WHERE created_at >= now() - make_interval(days => ${days})
    GROUP BY 1
    ORDER BY 1
  `;

  return rows.map((row: any) => ({
    day: row.day,
    costCents: Number(row.cost_cents),
    calls: row.calls,
  }));
}

/**
 * Get costs for a specific content engine run.
 */
export async function getRunCosts(runId: string): Promise<{
  contentGeneration: number;
  clusterRefinement: number;
  imageGeneration: number;
  total: number;
}> {
  const rows = await sql<any>`
    SELECT 
      feature,
      COALESCE(sum(cost_cents), 0)::numeric AS cost_cents
    FROM ai_usage_log
    WHERE content_run_id = ${runId}
    GROUP BY feature
  `;

  const costs = {
    contentGeneration: 0,
    clusterRefinement: 0,
    imageGeneration: 0,
    total: 0,
  };

  for (const row of rows) {
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

  return costs;
}
