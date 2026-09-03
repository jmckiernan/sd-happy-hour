import { sql } from './db';
import { findFeatureRequestMatches } from './feedback';

export type FeatureAuthorKind = 'user' | 'venue_owner';

export interface FeatureRequest {
  id: string;
  authorName: string;
  authorKind: FeatureAuthorKind;
  title: string;
  details: string;
  status: 'open' | 'planned' | 'complete' | 'closed';
  voteCount: number;
  viewerHasVoted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FeatureRequestRow {
  id: string;
  author_name: string;
  author_kind: FeatureAuthorKind;
  title: string;
  details: string;
  status: FeatureRequest['status'];
  vote_count: number | string;
  viewer_has_voted: boolean;
  created_at: string;
  updated_at: string;
}

function mapFeature(row: FeatureRequestRow): FeatureRequest {
  return {
    id: row.id,
    authorName: row.author_name || 'Community member',
    authorKind: row.author_kind,
    title: row.title,
    details: row.details,
    status: row.status,
    voteCount: Number(row.vote_count) || 0,
    viewerHasVoted: Boolean(row.viewer_has_voted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createBugReport(input: {
  reporterUserId: string | null;
  email: string;
  title: string;
  details: string;
  pageUrl: string;
  userAgent: string;
}): Promise<string> {
  const rows = await sql<{ id: string }>`
    INSERT INTO bug_reports (reporter_user_id, email, title, details, page_url, user_agent)
    VALUES (${input.reporterUserId}, ${input.email}, ${input.title}, ${input.details}, ${input.pageUrl}, ${input.userAgent})
    RETURNING id`;
  return rows[0].id;
}

export async function listFeatureRequests(viewerUserId: string): Promise<FeatureRequest[]> {
  const rows = await sql<FeatureRequestRow>`
    SELECT requests.id,
      users.name AS author_name,
      requests.author_kind,
      requests.title,
      requests.details,
      requests.status,
      requests.created_at,
      requests.updated_at,
      COUNT(votes.user_id)::integer AS vote_count,
      EXISTS(
        SELECT 1 FROM feature_request_votes viewer_vote
        WHERE viewer_vote.feature_request_id = requests.id
          AND viewer_vote.user_id = ${viewerUserId}
      ) AS viewer_has_voted
    FROM feature_requests requests
    JOIN users ON users.id = requests.author_user_id
    LEFT JOIN feature_request_votes votes ON votes.feature_request_id = requests.id
    GROUP BY requests.id, users.name
    ORDER BY vote_count DESC, requests.created_at DESC`;
  return rows.map(mapFeature);
}

export async function findFeatureMatches(query: string, viewerUserId: string): Promise<FeatureRequest[]> {
  const requests = await listFeatureRequests(viewerUserId);
  return findFeatureRequestMatches(query, requests).map((match) => match.request);
}

export async function createFeatureRequest(
  userId: string,
  title: string,
  details: string,
): Promise<FeatureRequest> {
  const ownership = await sql<{ owner: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM venue_claims WHERE user_id = ${userId} AND status = 'verified'
    ) AS owner`;
  const authorKind: FeatureAuthorKind = ownership[0]?.owner ? 'venue_owner' : 'user';
  const rows = await sql<{ id: string }>`
    INSERT INTO feature_requests (author_user_id, author_kind, title, details)
    VALUES (${userId}, ${authorKind}, ${title}, ${details})
    RETURNING id`;
  const requests = await listFeatureRequests(userId);
  return requests.find((request) => request.id === rows[0].id)!;
}

/** Adds a vote, or removes it if this account already voted. */
export async function toggleFeatureRequestVote(
  featureRequestId: string,
  userId: string,
): Promise<{ status: 'created' | 'removed' | 'closed' | 'not_found'; voteCount: number; viewerHasVoted: boolean }> {
  const requestRows = await sql<{ id: string; status: FeatureRequest['status'] }>`
    SELECT id, status FROM feature_requests WHERE id = ${featureRequestId}`;
  const request = requestRows[0];
  if (!request) {
    return { status: 'not_found', voteCount: 0, viewerHasVoted: false };
  }

  const existing = await sql<{ feature_request_id: string }>`
    SELECT feature_request_id FROM feature_request_votes
    WHERE feature_request_id = ${featureRequestId} AND user_id = ${userId}`;

  if (existing.length) {
    await sql`
      DELETE FROM feature_request_votes
      WHERE feature_request_id = ${featureRequestId} AND user_id = ${userId}`;
  } else if (request.status !== 'open' && request.status !== 'planned') {
    const closedVotes = await sql<{ vote_count: number | string }>`
      SELECT COUNT(*)::integer AS vote_count FROM feature_request_votes
      WHERE feature_request_id = ${featureRequestId}`;
    return {
      status: 'closed',
      voteCount: Number(closedVotes[0]?.vote_count) || 0,
      viewerHasVoted: false,
    };
  } else {
    await sql`
      INSERT INTO feature_request_votes (feature_request_id, user_id)
      VALUES (${featureRequestId}, ${userId})
      ON CONFLICT DO NOTHING`;
  }

  const rows = await sql<{ vote_count: number | string; viewer_has_voted: boolean }>`
    SELECT
      (SELECT COUNT(*)::integer FROM feature_request_votes WHERE feature_request_id = ${featureRequestId}) AS vote_count,
      EXISTS(
        SELECT 1 FROM feature_request_votes
        WHERE feature_request_id = ${featureRequestId} AND user_id = ${userId}
      ) AS viewer_has_voted`;
  return {
    status: existing.length ? 'removed' : 'created',
    voteCount: Number(rows[0]?.vote_count) || 0,
    viewerHasVoted: Boolean(rows[0]?.viewer_has_voted),
  };
}

const FEATURE_STATUSES = ['open', 'planned', 'complete', 'closed'] as const;

export function isFeatureRequestStatus(value: unknown): value is FeatureRequest['status'] {
  return typeof value === 'string' && (FEATURE_STATUSES as readonly string[]).includes(value);
}

export async function updateFeatureRequestStatus(
  featureRequestId: string,
  status: FeatureRequest['status'],
): Promise<FeatureRequest | null> {
  const rows = await sql<{ id: string }>`
    UPDATE feature_requests
    SET status = ${status}, updated_at = now()
    WHERE id = ${featureRequestId}
    RETURNING id`;
  if (!rows.length) return null;
  // Re-list would need a viewer; return a minimal refresh via direct select.
  const refreshed = await sql<FeatureRequestRow>`
    SELECT requests.id,
      users.name AS author_name,
      requests.author_kind,
      requests.title,
      requests.details,
      requests.status,
      requests.created_at,
      requests.updated_at,
      COUNT(votes.user_id)::integer AS vote_count,
      false AS viewer_has_voted
    FROM feature_requests requests
    JOIN users ON users.id = requests.author_user_id
    LEFT JOIN feature_request_votes votes ON votes.feature_request_id = requests.id
    WHERE requests.id = ${featureRequestId}
    GROUP BY requests.id, users.name`;
  return refreshed[0] ? mapFeature(refreshed[0]) : null;
}
