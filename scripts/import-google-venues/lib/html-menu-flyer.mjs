/**
 * Render a gallery JPEG from a structured happy-hour menu (AI-extracted
 * items/prices). Used when the venue publishes HTML instead of a flyer image.
 */

import { createCanvas } from '@napi-rs/canvas';

const WIDTH = 1080;
const PAD = 52;
const TITLE_SIZE = 40;
const META_SIZE = 20;
const SECTION_SIZE = 18;
const ITEM_SIZE = 24;
const LINE = 42;

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const next = `${current} ${word}`;
    if (ctx.measureText(next).width <= maxWidth) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function itemRowHeight(ctx, name, colWidth, price) {
  ctx.font = `500 ${ITEM_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const priceWidth = price ? ctx.measureText(price).width : 0;
  const nameMax = Math.max(80, colWidth - priceWidth - 36);
  return wrapText(ctx, name, nameMax).length * LINE;
}

function drawItem(ctx, x, y, width, name, price) {
  ctx.font = `500 ${ITEM_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const priceWidth = price ? ctx.measureText(price).width : 0;
  const nameMax = Math.max(80, width - priceWidth - 36);
  const lines = wrapText(ctx, name, nameMax);
  ctx.fillStyle = '#f4ead4';
  ctx.textAlign = 'left';
  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * LINE);
  });
  if (price) {
    ctx.fillStyle = '#c4a574';
    ctx.textAlign = 'right';
    ctx.fillText(price, x + width, y);
  }
  const lastY = y + (lines.length - 1) * LINE;
  const nameWidth = ctx.measureText(lines[0]).width;
  const gapLeft = x + nameWidth + 10;
  const gapRight = x + width - priceWidth - 10;
  if (price && lines.length === 1 && gapRight - gapLeft > 18) {
    ctx.strokeStyle = 'rgba(232, 213, 163, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(gapLeft, y - 6);
    ctx.lineTo(gapRight, y - 6);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return lastY + LINE;
}

function layoutHeight(board, venueName, ctx) {
  const sections = board.sections || [];
  const twoCol = sections.length === 2;
  ctx.font = `500 ${ITEM_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const colWidth = twoCol ? (WIDTH - PAD * 2 - 40) / 2 : WIDTH - PAD * 2;
  const sectionHeights = sections.map((section) => (
    48 + section.items.reduce((sum, item) => sum + itemRowHeight(ctx, item.name, colWidth, item.price), 0)
  ));
  const body = twoCol ? Math.max(...sectionHeights) : sectionHeights.reduce((a, b) => a + b, 0);
  const extra = (board.hours ? 36 : 0) + (board.note ? 36 : 0);
  const titleLines = Math.ceil(String(venueName || 'Happy Hour').length / 26);
  return Math.min(2200, Math.max(720, PAD * 2 + titleLines * 48 + extra + 56 + body + 24));
}

/** Rasterize a structured happy-hour menu into a JPEG buffer. */
export function renderMenuBoardJpeg(board, venue = {}) {
  if (!board?.sections?.length) return null;
  const venueName = String(venue.name || 'Happy Hour').replace(/\s+/g, ' ').trim();
  const measure = createCanvas(WIDTH, 100).getContext('2d');
  const height = layoutHeight(board, venueName, measure);
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#14110e';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.strokeStyle = '#c4a574';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, WIDTH - 48, height - 48);

  let y = PAD + 10;
  ctx.fillStyle = '#f4ead4';
  ctx.font = `600 ${TITLE_SIZE}px "Georgia", "Times New Roman", serif`;
  ctx.textAlign = 'center';
  ctx.fillText(venueName, WIDTH / 2, y);
  y += 34;
  ctx.font = `500 ${META_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = '#c4a574';
  ctx.fillText('Happy Hour Menu', WIDTH / 2, y);
  y += 32;

  if (board.note || board.hours) {
    ctx.font = `500 ${META_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillStyle = '#f4ead4';
    if (board.note) {
      ctx.fillText(board.note, WIDTH / 2, y);
      y += 28;
    }
    if (board.hours) {
      ctx.fillStyle = '#e8d5a3';
      ctx.fillText(board.hours, WIDTH / 2, y);
      y += 28;
    }
    y += 10;
  }

  const sections = board.sections;
  const twoCol = sections.length === 2;
  if (twoCol) {
    const colWidth = (WIDTH - PAD * 2 - 40) / 2;
    sections.forEach((section, index) => {
      const x = PAD + index * (colWidth + 40);
      let rowY = y;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c4a574';
      ctx.font = `600 ${SECTION_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.fillText(`~ ${String(section.title || '').toUpperCase()} ~`, x + colWidth / 2, rowY);
      rowY += 40;
      for (const item of section.items) {
        rowY = drawItem(ctx, x, rowY, colWidth, item.name, item.price);
      }
    });
  } else {
    for (const section of sections) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c4a574';
      ctx.font = `600 ${SECTION_SIZE}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.fillText(String(section.title || 'Happy Hour').toUpperCase(), WIDTH / 2, y);
      y += 36;
      for (const item of section.items) {
        y = drawItem(ctx, PAD, y, WIDTH - PAD * 2, item.name, item.price);
        if (y > height - PAD) break;
      }
      y += 10;
    }
  }

  const jpeg = canvas.toBuffer('image/jpeg', 86);
  return {
    bytes: Buffer.from(jpeg),
    mediaType: 'image/jpeg',
    kind: 'image',
    url: venue.website || null,
    sourceUrl: venue.website || null,
  };
}

function formatWindowHours(windows = []) {
  const lines = (windows || []).slice(0, 3).map((window) => {
    const days = (window.days || []).map((day) => String(day).slice(0, 3)).join(', ');
    if (window.allDay) return `${days} all day`;
    const start = String(window.startTime || '').slice(0, 5);
    const end = String(window.endTime || '').slice(0, 5);
    return days ? `${days} ${start}–${end}` : `${start}–${end}`;
  });
  return lines.filter(Boolean).join(' · ').slice(0, 140);
}

/** Build a gallery board from directory chips when the model omitted menuBoard. */
export function menuBoardFromDealLines(deals = [], windows = []) {
  const items = (deals || [])
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((name) => ({ name, price: '' }));
  if (items.length < 2) return null;
  return {
    hours: formatWindowHours(windows),
    note: '',
    sections: [{ title: 'Specials', items }],
  };
}
