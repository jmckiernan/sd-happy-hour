/** Rasterize happy-hour PDF pages to JPEGs for the venue photo gallery. */

const MAX_EDGE = 1600;

export async function rasterizePdfPages(bytes, { maxPages = 2, scale = 2 } = {}) {
  if (!bytes?.length) return [];
  const data = Uint8Array.from(bytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

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
