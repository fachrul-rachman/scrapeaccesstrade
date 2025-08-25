// src/index.js
import Fastify from 'fastify';
import dotenv from 'dotenv';
import { scrapeOnePageTop5 } from './scraper.js';

dotenv.config();
const app = Fastify({ logger: true });
const PORT = parseInt(process.env.PORT || '3020', 10);

// Parser universal: terima apa pun, jangan pernah bikin 400
app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    if (!body || !body.length) return done(null, {});
    const txt = body.toString('utf8').trim();
    if (!txt) return done(null, {});
    try { return done(null, JSON.parse(txt)); } catch {}
    if (txt.includes('=')) {
      const obj = {};
      for (const kv of txt.split('&')) {
        const [k, v=''] = kv.split('=');
        if (!k) continue;
        obj[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
      }
      return done(null, obj);
    }
    return done(null, { _raw: txt });
  } catch {
    return done(null, {}); // tetap lolos
  }
});

app.get('/', async () => ({ ok: true, service: 'accesstrade-scraper', version: 2 }));
app.get('/version', async () => ({ version: 2, ts: Date.now() }));
app.post('/echo', async (req) => ({ headers: req.headers, body: req.body }));

// GET /scrape?product_name=...&min_price=...&max_price=...
app.get('/scrape', async (req, reply) => {
  const q = req.query || {};
  const rawName = q.product_name ?? q.query ?? q.q ?? '';
  const product_name = String(rawName || '').trim();
  let min_price = Number(q.min_price ?? 0);
  let max_price = Number(q.max_price ?? 0);
  if (Number.isNaN(min_price)) min_price = 0;
  if (Number.isNaN(max_price)) max_price = 0;

  if (!product_name) return reply.code(200).send({ error: 'product_name wajib (alias: query/q).', results: [] });
  if (min_price > 0 && max_price > 0 && min_price > max_price)
    return reply.code(200).send({ error: 'min_price > max_price.', results: [] });

  try {
    const results = await scrapeOnePageTop5({ product_name, min_price, max_price });
    return reply.code(200).send(results);
  } catch (err) {
    req.log.error(err);
    return reply.code(200).send({ error: err?.message || 'Internal error', results: [] });
  }
});

// POST /scrape — sama seperti GET, tapi ambil dari body
app.post('/scrape', async (req, reply) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const rawName = b.product_name ?? b.query ?? b.q ?? b._raw ?? '';
  const product_name = String(rawName || '').trim();
  let min_price = Number(b.min_price ?? 0);
  let max_price = Number(b.max_price ?? 0);
  if (Number.isNaN(min_price)) min_price = 0;
  if (Number.isNaN(max_price)) max_price = 0;

  if (!product_name) return reply.code(200).send({ error: 'product_name wajib (alias: query/q).', results: [] });
  if (min_price > 0 && max_price > 0 && min_price > max_price)
    return reply.code(200).send({ error: 'min_price > max_price.', results: [] });

  try {
    const results = await scrapeOnePageTop5({ product_name, min_price, max_price });
    return reply.code(200).send(results);
  } catch (err) {
    req.log.error(err);
    return reply.code(200).send({ error: err?.message || 'Internal error', results: [] });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`API listening on http://0.0.0.0:${PORT}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
