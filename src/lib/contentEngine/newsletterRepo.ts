import { sql } from '../db';

export async function newsletterOperationsOverview() {
  const [counts, subscriptions, messages] = await Promise.all([
    sql<{ status: string; count: string }>`
      SELECT status, count(*)::text AS count
      FROM newsletter_subscriptions GROUP BY status ORDER BY status`,
    sql<any>`
      SELECT id, publisher_name AS "publisherName", subscriber_email AS "subscriberEmail",
             website_url AS "websiteUrl", signup_url AS "signupUrl", status,
             confirmation_status AS "confirmationStatus", confirmed_at AS "confirmedAt",
             last_message_at AS "lastMessageAt", last_error AS "lastError", updated_at AS "updatedAt"
      FROM newsletter_subscriptions
      ORDER BY
        CASE status WHEN 'failed' THEN 0 WHEN 'confirmation_pending' THEN 1
          WHEN 'signup_pending' THEN 2 WHEN 'active' THEN 3 ELSE 4 END,
        updated_at DESC
      LIMIT 250`,
    sql<any>`
      SELECT nm.id, ns.publisher_name AS "publisherName", nm.subject,
             nm.message_type AS "messageType", nm.status,
             nm.extracted_item_count AS "extractedItemCount",
             nm.sent_at AS "sentAt", nm.processed_at AS "processedAt", nm.last_error AS "lastError"
      FROM newsletter_messages nm
      JOIN newsletter_subscriptions ns ON ns.id = nm.subscription_id
      ORDER BY nm.received_at DESC
      LIMIT 100`,
  ]);
  return {
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
    subscriptions,
    messages,
  };
}
