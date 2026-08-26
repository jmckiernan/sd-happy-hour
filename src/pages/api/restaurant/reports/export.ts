import type { APIRoute } from 'astro';
import { errorJson } from '../../../../lib/api';
import { authorizeMerchantReport, listMerchantReportVenues } from '../../../../lib/merchantEntitlements';
import { captureMerchantEvent } from '../../../../lib/merchantAnalytics';
import { merchantReportCsv, merchantReportPdf } from '../../../../lib/merchantReportExport';
import { getMerchantReportData, resolveMerchantReportRange } from '../../../../lib/merchantReporting';

export const prerender = false;

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'restaurant';
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const venueId = Number(url.searchParams.get('venueId'));
  const format = url.searchParams.get('format') || 'csv';
  if (format !== 'csv' && format !== 'pdf') return errorJson(['Export format must be csv or pdf.'], 422);
  const authorization = await authorizeMerchantReport(cookies, venueId);
  if (!authorization) return errorJson(['Paid owner or admin reporting access is required.'], 403);
  let range;
  try {
    range = resolveMerchantReportRange({
      preset: url.searchParams.get('range'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Invalid report range.'], 422);
  }
  const venues = await listMerchantReportVenues(authorization.userId, authorization.siteAdmin);
  const report = await getMerchantReportData({
    venueId,
    ownerUserId: authorization.venue.ownerUserId,
    accessibleVenues: venues.filter((item) => item.paid).map((item) => ({
      venueId: item.venueId,
      ownerUserId: item.ownerUserId,
    })),
    range,
  });
  await captureMerchantEvent({
    eventName: 'export_generated', venueId, userId: authorization.userId,
    authenticated: true, source: 'merchant_reports', properties: { format, range: range.preset },
  });
  const filename = `${safeFilename(report.venue.name)}-${range.preset}-report.${format}`;
  if (format === 'pdf') {
    let body: Buffer;
    try {
      body = await merchantReportPdf(report);
    } catch (error) {
      console.error('[merchant reports] PDF export failed:', error);
      return errorJson([error instanceof Error ? error.message : 'PDF export failed.'], 502);
    }
    const responseBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(responseBody, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, no-store',
      },
    });
  }
  return new Response(merchantReportCsv(report), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
};
