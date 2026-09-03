// Small shared helpers for JSON API routes under src/pages/api/.

export interface JsonOptions {
  /** Override default cache-control (no-store). */
  cacheControl?: string;
}

export function json(body: unknown, status = 200, options?: JsonOptions): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': options?.cacheControl ?? 'no-store',
    },
  });
}

export function errorJson(errors: string[], status = 400): Response {
  return json({ errors }, status);
}

export async function readJsonBody(request: Request): Promise<Record<string, any>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}
