import PDFDocument from 'pdfkit';
import type { MerchantReportData, MerchantReportSummary } from './merchantReporting';

const COLORS = {
  night: '#201238',
  nightSoft: '#5D526B',
  orange: '#FF6B35',
  gold: '#F4C05C',
  ocean: '#0E7490',
  green: '#16835A',
  sand: '#FFF7ED',
  line: '#E9E2F0',
  white: '#FFFFFF',
};

function csvCell(value: unknown): string {
  const raw = String(value ?? '');
  // Prevent spreadsheet formula execution when a restaurant or campaign
  // title begins with a formula marker.
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function merchantReportCsv(report: MerchantReportData): string {
  const rows: unknown[][] = [
    ['Happy Hour SD Merchant Report'],
    ['Venue', report.venue.name],
    ['Range', report.range.label],
    ['Generated', report.generatedAt],
    [],
    ['Metric', 'Value', 'Definition'],
    ['Unique visits', report.summary.uniqueVisits, report.definitions.uniqueVisits],
    ['Unique users', report.summary.uniqueUsers, report.definitions.uniqueUsers],
    ['Total views', report.summary.totalViews, 'All venue page views'],
    ['Authenticated views', report.summary.authenticatedViews, 'Views by signed-in users'],
    ['Unauthenticated views', report.summary.unauthenticatedViews, 'Views by signed-out visitors'],
    ['Website clicks', report.summary.websiteClicks, `${report.summary.websiteRate}% of unique visits`],
    ['Call clicks', report.summary.callClicks, `${report.summary.callRate}% of unique visits`],
    ['Directions clicks', report.summary.directionsClicks, `${report.summary.directionsRate}% of unique visits`],
    ['Saves', report.summary.saves, `${report.summary.saveRate}% of unique visits`],
    ['Shares', report.summary.shares, `${report.summary.shareRate}% of unique visits`],
    ['Follows', report.summary.follows, `${report.summary.followRate}% of unique visits`],
    ['Promotion views', report.summary.promotionViews, 'Promotion impressions'],
    ['Promotion clicks', report.summary.promotionClicks, `${report.summary.campaignEngagementRate}% campaign engagement`],
    ['Campaigns launched', report.summary.campaignsLaunched, 'Distinct campaigns launched'],
    ['Current savers', report.audience.currentSavers, 'Current audience snapshot'],
    ['Current followers', report.audience.currentFollowers, 'Current audience snapshot'],
    ['Current alert subscribers', report.audience.currentAlertSubscribers, 'Current audience snapshot'],
    [],
    ['Daily trend'],
    ['Date', 'Views', 'Unique visits', 'Website clicks', 'Call clicks', 'Directions clicks', 'Promotion clicks'],
    ...report.trend.map((point) => [
      point.date, point.views, point.uniqueVisits, point.websiteClicks,
      point.callClicks, point.directionsClicks, point.promotionClicks,
    ]),
    [],
    ['Campaign performance'],
    ['Campaign', 'State', 'Views', 'Clicks', 'Unique view visits', 'Unique click visits', 'Engagement rate'],
    ...report.campaigns.map((campaign) => [
      campaign.title, campaign.state, campaign.views, campaign.clicks,
      campaign.uniqueViewVisits, campaign.uniqueClickVisits, `${campaign.engagementRate}%`,
    ]),
    [],
    ['Note', report.definitions.revenueProxy],
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function asciiPunctuation(value: string): string {
  return value
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '-');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 ? 1 : 0)}%`;
}

function roundedRect(doc: PDFKit.PDFDocument, x: number, y: number, width: number, height: number, color: string) {
  doc.roundedRect(x, y, width, height, 10).fill(color);
}

function metricCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  detail: string,
  accent = COLORS.orange
) {
  roundedRect(doc, x, y, width, 82, COLORS.white);
  doc.rect(x, y, 5, 82).fill(accent);
  doc.fillColor(COLORS.nightSoft).font('Helvetica-Bold').fontSize(8)
    .text(asciiPunctuation(label.toUpperCase()), x + 15, y + 13, { width: width - 27, characterSpacing: 0.5 });
  doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(23)
    .text(value, x + 15, y + 29, { width: width - 27 });
  doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(8)
    .text(asciiPunctuation(detail), x + 15, y + 59, { width: width - 27, lineBreak: false, ellipsis: true });
}

function pageHeader(doc: PDFKit.PDFDocument, report: MerchantReportData, subtitle: string) {
  doc.rect(0, 0, doc.page.width, 116).fill(COLORS.night);
  doc.fillColor(COLORS.gold).font('Helvetica-Bold').fontSize(9)
    .text('HAPPY HOUR SD', 44, 30, { characterSpacing: 1.8 });
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(24)
    .text(asciiPunctuation(report.venue.name), 44, 49, { width: 410, lineBreak: false, ellipsis: true });
  doc.fillColor('#D8D0E2').font('Helvetica').fontSize(9)
    .text(`${asciiPunctuation(subtitle)}  |  ${asciiPunctuation(report.range.label)}`, 44, 82);
  doc.fillColor('#D8D0E2').fontSize(8).text(
    `Generated ${new Date(report.generatedAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} PT`,
    412, 31, { width: 140, align: 'right' }
  );
}

function pageFooter(doc: PDFKit.PDFDocument, pageNumber: number) {
  doc.strokeColor(COLORS.line).lineWidth(0.7).moveTo(44, 728).lineTo(568, 728).stroke();
  doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(7.5)
    .text('Intent metrics are directional proxies, not attributed revenue.', 44, 736, { width: 390, lineBreak: false });
  doc.text(`Happy Hour SD  |  Page ${pageNumber}`, 445, 736, { width: 123, align: 'right', lineBreak: false });
}

function drawTrendChart(doc: PDFKit.PDFDocument, report: MerchantReportData, x: number, y: number, width: number, height: number) {
  roundedRect(doc, x, y, width, height, COLORS.white);
  doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(12).text('Visit trend', x + 16, y + 14);
  doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(8)
    .text('Daily total views and unique visits', x + 16, y + 31);
  const points = report.trend;
  const chartX = x + 40;
  const chartY = y + 57;
  const chartW = width - 60;
  const chartH = height - 88;
  const max = Math.max(1, ...points.flatMap((point) => [point.views, point.uniqueVisits]));
  doc.strokeColor(COLORS.line).lineWidth(0.6);
  for (let line = 0; line <= 4; line += 1) {
    const ly = chartY + (chartH * line) / 4;
    doc.moveTo(chartX, ly).lineTo(chartX + chartW, ly).stroke();
    doc.fillColor(COLORS.nightSoft).fontSize(6.5).text(String(Math.round(max * (1 - line / 4))), x + 8, ly - 3, { width: 26, align: 'right' });
  }
  if (points.length) {
    const pointX = (index: number) => chartX + (points.length === 1 ? chartW / 2 : (index * chartW) / (points.length - 1));
    const pointY = (value: number) => chartY + chartH - (value / max) * chartH;
    for (const [key, color] of [['views', COLORS.orange], ['uniqueVisits', COLORS.ocean]] as const) {
      doc.strokeColor(color).lineWidth(2);
      points.forEach((point, index) => {
        const px = pointX(index);
        const py = pointY(point[key]);
        if (index === 0) doc.moveTo(px, py); else doc.lineTo(px, py);
      });
      doc.stroke();
    }
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    for (const index of labelIndexes) {
      doc.fillColor(COLORS.nightSoft).fontSize(6.5).text(points[index].date.slice(5), pointX(index) - 18, chartY + chartH + 8, { width: 36, align: 'center' });
    }
  }
  doc.fillColor(COLORS.orange).circle(x + width - 128, y + 22, 3).fill();
  doc.fillColor(COLORS.nightSoft).fontSize(7).text('Views', x + width - 120, y + 18);
  doc.fillColor(COLORS.ocean).circle(x + width - 75, y + 22, 3).fill();
  doc.fillColor(COLORS.nightSoft).text('Unique', x + width - 67, y + 18);
}

function actionRows(summary: MerchantReportSummary) {
  return [
    ['Website', summary.websiteClicks, summary.websiteRate],
    ['Calls', summary.callClicks, summary.callRate],
    ['Directions', summary.directionsClicks, summary.directionsRate],
    ['Saves', summary.saves, summary.saveRate],
    ['Shares', summary.shares, summary.shareRate],
    ['Follows', summary.follows, summary.followRate],
  ] as const;
}

function drawActionTable(doc: PDFKit.PDFDocument, report: MerchantReportData, x: number, y: number, width: number) {
  roundedRect(doc, x, y, width, 164, COLORS.white);
  doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(12).text('High-intent actions', x + 16, y + 14);
  doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(7.5)
    .text('Rate = unique action visits / unique venue visits', x + 16, y + 31);
  let rowY = y + 52;
  for (const [label, count, rate] of actionRows(report.summary)) {
    doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(8.5).text(label, x + 16, rowY);
    doc.fillColor(COLORS.nightSoft).font('Helvetica').text(formatNumber(count), x + width - 110, rowY, { width: 40, align: 'right' });
    doc.fillColor(rate >= 10 ? COLORS.green : COLORS.ocean).font('Helvetica-Bold').text(formatPercent(rate), x + width - 62, rowY, { width: 46, align: 'right' });
    rowY += 17;
  }
}

export function merchantReportPdf(report: MerchantReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 36, left: 44, right: 44, bottom: 42 }, info: {
      Title: `${report.venue.name} - Merchant Analytics Report`,
      Author: 'Happy Hour SD',
      Subject: report.range.label,
    } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.sand);
    pageHeader(doc, report, 'Merchant performance report');
    const cardWidth = 124;
    metricCard(doc, 44, 136, cardWidth, 'Unique visits', formatNumber(report.summary.uniqueVisits), `${formatNumber(report.summary.totalViews)} total views`);
    metricCard(doc, 178, 136, cardWidth, 'Website CTR', formatPercent(report.summary.websiteRate), `${formatNumber(report.summary.websiteClicks)} clicks`, COLORS.ocean);
    metricCard(doc, 312, 136, cardWidth, 'Directions rate', formatPercent(report.summary.directionsRate), `${formatNumber(report.summary.directionsClicks)} opens`, COLORS.green);
    metricCard(doc, 446, 136, 122, 'Campaign rate', formatPercent(report.summary.campaignEngagementRate), `${formatNumber(report.summary.promotionClicks)} clicks`, '#7C3AED');
    drawTrendChart(doc, report, 44, 234, 524, 245);
    drawActionTable(doc, report, 44, 493, 330);
    roundedRect(doc, 386, 493, 182, 164, COLORS.night);
    doc.fillColor(COLORS.gold).font('Helvetica-Bold').fontSize(9).text('AUDIENCE NOW', 402, 510, { characterSpacing: 1 });
    const audience = [
      ['Savers', report.audience.currentSavers],
      ['Followers', report.audience.currentFollowers],
      ['Alert subscribers', report.audience.currentAlertSubscribers],
    ] as const;
    let ay = 538;
    for (const [label, value] of audience) {
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(17).text(formatNumber(value), 402, ay);
      doc.fillColor('#D8D0E2').font('Helvetica').fontSize(8).text(label, 456, ay + 6, { width: 94 });
      ay += 35;
    }
    doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(8).text(asciiPunctuation(report.definitions.conversionRate), 44, 679, { width: 524, lineGap: 2 });
    pageFooter(doc, 1);

    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.sand);
    pageHeader(doc, report, 'Campaign and venue comparison');
    doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(14).text('Campaign performance', 44, 137);
    const columns = [44, 284, 360, 414, 468, 524];
    const headers = ['Campaign', 'State', 'Views', 'Clicks', 'Unique', 'Rate'];
    doc.fillColor(COLORS.nightSoft).font('Helvetica-Bold').fontSize(7.5);
    headers.forEach((header, index) => doc.text(header.toUpperCase(), columns[index], 162, { width: index === 0 ? 220 : 44, align: index > 1 ? 'right' : 'left' }));
    doc.strokeColor(COLORS.line).moveTo(44, 177).lineTo(568, 177).stroke();
    const campaignRows = report.campaigns.slice(0, 9);
    let cy = 188;
    if (!campaignRows.length) {
      doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(9).text('No campaigns in this reporting range.', 44, cy);
      cy += 30;
    } else {
      for (const campaign of campaignRows) {
        doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(8).text(asciiPunctuation(campaign.title), columns[0], cy, { width: 220, lineBreak: false, ellipsis: true });
        doc.fillColor(COLORS.nightSoft).font('Helvetica').text(campaign.state, columns[1], cy, { width: 60 });
        doc.text(formatNumber(campaign.views), columns[2], cy, { width: 40, align: 'right' });
        doc.text(formatNumber(campaign.clicks), columns[3], cy, { width: 40, align: 'right' });
        doc.text(formatNumber(campaign.uniqueViewVisits), columns[4], cy, { width: 40, align: 'right' });
        doc.fillColor(COLORS.ocean).font('Helvetica-Bold').text(formatPercent(campaign.engagementRate), columns[5], cy, { width: 44, align: 'right' });
        cy += 25;
        doc.strokeColor(COLORS.line).lineWidth(0.5).moveTo(44, cy - 8).lineTo(568, cy - 8).stroke();
      }
    }

    const comparisonY = Math.max(410, cy + 24);
    doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(14).text('Restaurant comparison', 44, comparisonY);
    doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(8).text('Unique visits and high-intent action rate across restaurants you control.', 44, comparisonY + 20);
    const comparisons = report.comparison.slice(0, 7);
    const maxVisits = Math.max(1, ...comparisons.map((item) => item.uniqueVisits));
    let vy = comparisonY + 48;
    for (const venue of comparisons) {
      doc.fillColor(COLORS.night).font('Helvetica-Bold').fontSize(8.5).text(asciiPunctuation(venue.venueName), 44, vy, { width: 170, lineBreak: false, ellipsis: true });
      doc.roundedRect(222, vy, 240, 10, 5).fill('#E9E2F0');
      if (venue.uniqueVisits) doc.roundedRect(222, vy, Math.max(5, (venue.uniqueVisits / maxVisits) * 240), 10, 5).fill(COLORS.orange);
      doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(8).text(`${formatNumber(venue.uniqueVisits)} visits`, 470, vy, { width: 55, align: 'right' });
      doc.fillColor(COLORS.ocean).font('Helvetica-Bold').text(formatPercent(venue.actionRate), 530, vy, { width: 38, align: 'right' });
      vy += 27;
    }
    doc.fillColor(COLORS.nightSoft).font('Helvetica').fontSize(8).text(asciiPunctuation(report.definitions.uniqueUsers), 44, 706, { width: 524 });
    pageFooter(doc, 2);
    doc.end();
  });
}
