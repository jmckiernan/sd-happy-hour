import type { Config, Context } from '@netlify/functions';
import { POST as handleNewsletterEmail } from '../../../src/pages/api/content-engine/newsletter-email';

/**
 * Public ingress for Resend. The existing handler performs Svix signature
 * verification before it parses, stores, confirms, or ingests any message.
 * Keeping this adapter tiny ensures the private application and its admin
 * routes never need to be exposed to the internet.
 */
export default async (request: Request, _context: Context): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ errors: ['Method not allowed.'] }), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }

  const response = await handleNewsletterEmail({ request } as Parameters<typeof handleNewsletterEmail>[0]);
  const summary: { status: number; error?: string } = { status: response.status };
  if (response.status >= 400) {
    const body = await response.clone().json().catch(() => null) as { errors?: unknown } | null;
    if (Array.isArray(body?.errors) && typeof body.errors[0] === 'string') {
      summary.error = body.errors[0].slice(0, 200);
    }
  }
  console.log('[newsletter-relay]', JSON.stringify(summary));
  return response;
};

export const config: Config = {
  path: '/resend/newsletter-email',
};
