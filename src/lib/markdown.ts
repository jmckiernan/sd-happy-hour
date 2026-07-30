// Minimal Markdown -> HTML renderer, used only to preview an AI-generated
// blog draft in the admin UI before publishing. Deliberately not a full
// CommonMark implementation and doesn't need to be — the actual published
// post is still rendered by Astro's real markdown pipeline once the file
// exists in the content collection at build time. This just needs to be
// readable enough for a human editor to review before hitting Publish.

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  let paragraphBuf: string[] = [];
  let listBuf: { type: 'ul' | 'ol'; items: string[] } | null = null;

  function flushParagraph() {
    if (paragraphBuf.length) {
      html.push(`<p>${renderInline(paragraphBuf.join(' '))}</p>`);
      paragraphBuf = [];
    }
  }
  function flushList() {
    if (listBuf) {
      const tag = listBuf.type;
      html.push(`<${tag}>${listBuf.items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</${tag}>`);
      listBuf = null;
    }
  }

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr />');
      i++;
      continue;
    }

    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      flushParagraph();
      if (!listBuf || listBuf.type !== 'ul') {
        flushList();
        listBuf = { type: 'ul', items: [] };
      }
      listBuf.items.push(ul[1]);
      i++;
      continue;
    }

    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      flushParagraph();
      if (!listBuf || listBuf.type !== 'ol') {
        flushList();
        listBuf = { type: 'ol', items: [] };
      }
      listBuf.items.push(ol[1]);
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      html.push(`<blockquote><p>${renderInline(trimmed.replace(/^>\s?/, ''))}</p></blockquote>`);
      i++;
      continue;
    }

    flushList();
    paragraphBuf.push(trimmed);
    i++;
  }

  flushParagraph();
  flushList();
  return html.join('\n');
}
