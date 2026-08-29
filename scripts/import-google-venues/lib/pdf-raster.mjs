/** Rasterize happy-hour PDF pages to JPEGs for the venue photo gallery. */

const MAX_EDGE = 1600;

const HAPPY_HOUR_RE = /happy[\s_-]*hour|golden[\s_-]*hour|social[\s_-]*hour|\bhh\b|specials?/i;
const PRICE_RE = /\$\s?\d/;

async function loadPdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
}

async function pageText(doc, pageNumber) {
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items.map((item) => item.str || '').join(' ');
  } catch {
    return '';
  }
}

/**
 * Is this PDF happy-hour evidence at all?
 *
 * Venues that publish a happy-hour PDF publish a *separate* one, so a PDF that
 * never says "happy hour" is their regular menu. Sending one anyway invites the
 * model to read a $17 cocktail off a drinks list and report it as a deal. The
 * text layer answers this for free, before we spend a vision token.
 *
 * Returns true when the PDF has no text layer (scanned artwork we can only
 * judge by looking) or when the URL itself claims to be a happy-hour menu.
 */
export async function pdfLooksLikeHappyHourMenu(bytes, url = '') {
  if (HAPPY_HOUR_RE.test(String(url))) return true;
  if (!bytes?.length) return false;

  let doc;
  try {
    doc = await loadPdf(bytes);
  } catch {
    return true;
  }

  const total = Math.min(doc.numPages || 0, 40);
  let sawText = false;
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const text = await pageText(doc, pageNumber);
    if (text.trim().length > 40) sawText = true;
    if (HAPPY_HOUR_RE.test(text) && PRICE_RE.test(text)) return true;
  }
  return !sawText;
}

export async function rasterizePdfPages(bytes, { maxPages = 2, scale = 2 } = {}) {
  if (!bytes?.length) return [];
  const doc = await loadPdf(bytes);

  const images = [];
  const pageCount = Math.min(doc.numPages || 0, maxPages);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(scale, MAX_EDGE / Math.max(base.width, base.height, 1));
    const viewport = page.getViewport({ scale: Math.max(0.5, fit) });
    const canvasFactory = doc.canvasFactory;
    const canvasAndContext = canvasFactory.create(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvasAndContext.canvas,
      canvasContext: canvasAndContext.context,
      viewport,
    }).promise;
    const jpeg = canvasAndContext.canvas.toBuffer('image/jpeg', 85);
    if (jpeg?.length) {
      images.push({
        bytes: Buffer.from(jpeg),
        mediaType: 'image/jpeg',
        page: pageNumber,
      });
    }
    canvasFactory.destroy?.(canvasAndContext);
  }
  return images;
}
