import type { Config } from '@netlify/functions';
import { runMerchantReportDispatch } from '../../src/lib/merchantReportSchedules';

export default async (): Promise<Response> => {
  try {
    const summary = await runMerchantReportDispatch();
    console.log('[dispatch-merchant-reports]', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200 });
  } catch (error) {
    console.error('[dispatch-merchant-reports] failed:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 500 });
  }
};

// Hourly is frequent enough to honor the selected local delivery hour while
// remaining resilient across Pacific daylight-saving transitions.
export const config: Config = { schedule: '17 * * * *' };
