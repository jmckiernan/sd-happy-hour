import type { Config } from '@netlify/functions';
import { runContentEngine } from '../../src/lib/contentEngine/pipeline';

export default async (): Promise<Response> => {
  try {
    const summary = await runContentEngine({ triggerType: 'scheduled' });
    console.log('[content-engine]', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), {
      status: summary.status === 'failed' ? 500 : 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[content-engine] failed:', message);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
};

// Twice daily. Netlify schedules in UTC; exact Pacific wall-clock hours vary
// by one hour across daylight-saving transitions, which is acceptable for a
// low-volume discovery sweep.
export const config: Config = { schedule: '5 15,23 * * *' };
