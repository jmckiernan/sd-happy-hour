import { sql, type QueryExecutor } from './db';

export async function createPromotionImage(
  venueId: number,
  imageKey: string,
  uploadedByUserId: string,
  executor: QueryExecutor = sql
): Promise<void> {
  await executor`
    INSERT INTO promotion_images (image_key, venue_id, uploaded_by_user_id)
    VALUES (${imageKey}, ${venueId}, ${uploadedByUserId})`;
}

export async function promotionImageBelongsToVenue(
  venueId: number,
  imageKey: string,
  executor: QueryExecutor = sql
): Promise<boolean> {
  const rows = await executor<{ present: boolean }>`
    SELECT true AS present
    FROM promotion_images
    WHERE image_key = ${imageKey} AND venue_id = ${venueId}`;
  return rows[0]?.present === true;
}

export async function countPromotionImagesForVenue(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<number> {
  const rows = await executor<{ count: string | number }>`
    SELECT count(*) AS count FROM promotion_images WHERE venue_id = ${venueId}`;
  return Number(rows[0]?.count ?? 0);
}
