const Fastify = require('fastify');
const cors = require('@fastify/cors');
const puppeteer = require('puppeteer-core');

const app = Fastify({ logger: false });
app.register(cors, { origin: '*' });

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

app.get('/health', async () => ({ status: 'ok', version: '1.0.0' }));

app.post('/capture', async (request, reply) => {
  const { url, options = {} } = request.body || {};
  if (!url) return reply.status(400).send({ success: false, error: 'url is required' });

  const viewport = { width: options?.viewport?.width || 1440, height: options?.viewport?.height || 900 };
  const theme = options?.theme || 'light';
  const start = Date.now();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: viewport.width, height: viewport.height });
    if (theme === 'dark') await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 500));
    const title = await page.title();

    const root = await page.evaluate(() => {
      function id() { return Math.random().toString(36).substr(2, 9); }
      function ignore(tag) { return ['script','style','noscript','head','meta','link','br','hr','svg','template'].includes(tag); }
      function serialize(el, depth) {
        if (depth <= 0) return null;
        const tag = el.tagName.toLowerCase();
        if (ignore(tag)) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0 && tag !== 'body') return null;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        const style = {};
        for (const p of ['background-color','color','font-family','font-size','font-weight','border-radius','border','box-shadow','opacity','display','padding-top','padding-right','padding-bottom','padding-left','flex-direction','gap','text-align','line-height']) {
          const v = cs.getPropertyValue(p);
          if (v && v !== 'none' && v !== 'normal' && v !== 'auto') style[p] = v;
        }
        const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ');
        const node = { id: id(), tagName: tag, bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }, style, text: directText || null, src: tag === 'img' ? el.src : null, children: [] };
        for (const child of el.children) { const s = serialize(child, depth - 1); if (s) node.children.push(s); }
        return node;
      }
      return serialize(document.body, 20);
    });

    await browser.close();

    function parseCSSColor(css) {
      const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) return { r: 0, g: 0, b: 0, a: 1 };
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
    }

    function convert(node) {
      if (!node) return null;
      const textTags = ['h1','h2','h3','h4','h5','h6','p','span','label','em','strong','b','i','small','code','a','button','li'];
      const isText = textTags.includes(node.tagName) && node.text && node.children.length === 0;
      if (node.tagName === 'img') return { id: node.id, type: 'image', name: 'Image', tagName: node.tagName, bounds: node.bounds, style: node.style, visible: true, opacity: 1, imageRef: '', originalSrc: node.src };
      if (isText) return { id: node.id, type: 'text', name: node.text.substring(0, 40), tagName: node.tagName, bounds: node.bounds, style: node.style, visible: true, opacity: 1, text: node.text, fontSize: parseFloat(node.style['font-size']) || 16, fontWeight: parseFloat(node.style['font-weight']) || 400, fontFamily: (node.style['font-family'] || 'Inter').split(',')[0].replace(/['\")]/ ,'').trim(), textAlign: node.style['text-align'] || 'left' };
      const bg = node.style['background-color'];
      const fills = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? [{ type: 'solid', color: parseCSSColor(bg) }] : [];
      const isFlex = node.style['display'] === 'flex' || node.style['display'] === 'inline-flex';
      return { id: node.id, type: 'frame', name: node.tagName, tagName: node.tagName, bounds: node.bounds, style: node.style, visible: true, opacity: 1, fills, cornerRadius: parseFloat(node.style['border-radius']) || undefined, isAutoLayout: isFlex, layoutDirection: isFlex ? (node.style['flex-direction'] === 'row' ? 'horizontal' : 'vertical') : undefined, layoutGap: parseFloat(node.style['gap']) || undefined, children: node.children.map(convert).filter(Boolean) };
    }

    const doc = { meta: { version: '1.0.0', sourceUrl: url, title, capturedAt: new Date().toISOString(), viewport, theme, locale: 'en-US', generator: 'html2design@1.0.0' }, assets: {}, root: { ...convert(root), name: title || 'Page', bounds: { x: 0, y: 0, width: viewport.width, height: viewport.height } } };
    return reply.send({ success: true, document: doc, duration: Date.now() - start });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return reply.status(500).send({ success: false, error: err.message, duration: Date.now() - start });
  }
});

app.post('/capture/download', async (request, reply) => {
  const res = await app.inject({ method: 'POST', url: '/capture', payload: request.body });
  const data = JSON.parse(res.payload);
  if (!data.success) return reply.status(500).send(data);
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Disposition', 'attachment; filename="capture.h2d"');
  return reply.send(JSON.stringify(data.document, null, 2));
});

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log('Backend html2design - puerto ' + PORT);
});
