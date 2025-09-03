// src/scraper.js
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const {
  ACCESSTRADE_EMAIL,
  ACCESSTRADE_PASSWORD,
  LOGIN_URL = 'https://accesstrade.co.id/publisher/login',
  TTS_URL = 'https://db.accesstrade.co.id/tiktok-shop',
} = process.env;

const STORAGE_DIR = path.resolve('storage');
const STORAGE_FILE = path.join(STORAGE_DIR, 'accesstrade.json');
const OUTPUT_DIR = path.resolve('data/outputs');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'latest.json');

// ------------ Utilities (fs) ------------
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function ensureDirs() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}
async function safeClosePage(page) { try { if (page) await page.close(); } catch { } }
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ------------ Browser/Context Singleton ------------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }
  return browserPromise;
}
let contextPromise = null;
async function getContext() {
  await ensureDirs();
  const browser = await getBrowser();
  if (contextPromise) return contextPromise;

  const storagePresent = await fileExists(STORAGE_FILE);
  contextPromise = browser.newContext({
    viewport: { width: 1366, height: 900 },
    ...(storagePresent ? { storageState: STORAGE_FILE } : {}),
  });

  return contextPromise;
}

async function resetContextWithLoginState(newContext) {
  try {
    if (contextPromise) {
      const old = await contextPromise;
      await old.close();
    }
  } catch { }
  contextPromise = Promise.resolve(newContext);
}

// ------------ Network optimizations ------------
async function applyNetworkBlocking(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    return route.continue();
  });
}

// ------------ Login helpers ------------
async function isStillLoggedIn(ctx) {
  const page = await ctx.newPage();
  try {
    await applyNetworkBlocking(page);
    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return !page.url().includes('/publisher/login');
  } catch {
    return false;
  } finally {
    await safeClosePage(page);
  }
}

async function performLoginAndSave(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  try {
    await applyNetworkBlocking(page);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    await page.waitForSelector('input#username', { timeout: 15000 });
    await page.fill('input#username', ACCESSTRADE_EMAIL || '');
    await page.fill('input#password', ACCESSTRADE_PASSWORD || '');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { }),
      page.click('button.btn.btn-at.rounded-lg.shadow-lg.py-2.px-5').catch(() => { }),
    ]);

    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (page.url().includes('/publisher/login')) {
      throw new Error('Login gagal.');
    }

    await ensureDirs();
    await ctx.storageState({ path: STORAGE_FILE });
    return ctx;
  } finally {
    await safeClosePage(page);
  }
}

export async function ensureLogin() {
  if (!ACCESSTRADE_EMAIL || !ACCESSTRADE_PASSWORD) {
    throw new Error('ENV ACCESSTRADE_EMAIL / ACCESSTRADE_PASSWORD belum diisi.');
  }

  const browser = await getBrowser();
  let ctx = await getContext();

  if (await isStillLoggedIn(ctx)) {
    return { browser, context: ctx, fromCache: true };
  }

  try { await ctx.close(); } catch { }
  const newCtx = await performLoginAndSave(browser);
  await resetContextWithLoginState(newCtx);
  return { browser, context: newCtx, fromCache: false };
}

// ------------ Parser utils ------------
function parseCurrencyToInt(str) {
  if (!str) return 0;
  const digits = (str.match(/\d+/g) || []).join('');
  return digits ? parseInt(digits, 10) : 0;
}
function parseSold(str) {
  if (!str) return 0;
  const m = str.match(/([\d. ,]+)\s*terjual/i);
  if (m) return parseCurrencyToInt(m[1]);
  const allNums = (str.match(/\d+/g) || []).map(n => parseInt(n, 10));
  return allNums.length ? Math.max(...allNums) : 0;
}
function normFlat(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// ------------ Matching & Scoring ------------
function extractModelToken(q) {
  const tokens = (q.match(/[a-z0-9\-]+/gi) || [])
    .filter(t => /[a-z]/i.test(t) && /\d/.test(t))
    .sort((a, b) => b.length - a.length);
  return tokens[0] || '';
}
function scoreTitleModelMode(query, title) {
  const q = (query || '').toLowerCase();
  const t = (title || '').toLowerCase();
  const model = extractModelToken(query);
  const modelFlat = normFlat(model);
  const titleFlat = normFlat(title);
  let score = 0;
  if (model && t.includes(model)) score += 3;
  if (modelFlat && titleFlat.includes(modelFlat)) score += 3;
  if (modelFlat.length >= 5) {
    const pref5 = modelFlat.slice(0, 5);
    if (titleFlat.includes(pref5)) score += 2;
  }
  const qTokens = new Set(q.split(/\s+/).filter(Boolean));
  const tTokens = new Set(t.split(/\s+/).filter(Boolean));
  let overlap = 0;
  qTokens.forEach(tok => { if (tTokens.has(tok)) overlap++; });
  if (overlap >= 2) score += 1;
  return score;
}
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const STOP = new Set(['dan', 'dengan', 'yang', 'untuk', 'di', 'ke', 'dari', 'itu', 'ini', 'the', 'of', 'a', 'an', 'to', 'on', 'in', 'by', 'or', 'as']);
const SYN = {
  sabuk: ['ikat', 'pinggang', 'gesper', 'belt'],
  gesper: ['sabuk', 'ikat', 'pinggang', 'belt'],
  cowo: ['cowok', 'pria', 'laki', 'laki-laki', 'lk', 'men', 'male'],
  pria: ['cowo', 'cowok', 'laki', 'laki-laki', 'men', 'male'],
  'tanpa lubang': ['no hole', 'no-hole', 'ratchet', 'otomatis', 'automatic'],
};
function expandTerms(terms) {
  const out = new Set();
  const joined = terms.join(' ');
  if (joined.includes('tanpa lubang')) SYN['tanpa lubang'].forEach(s => out.add(s));
  for (const t of terms) { out.add(t); if (SYN[t]) SYN[t].forEach(s => out.add(s)); }
  return Array.from(out);
}
function textSimGeneric(query, title) {
  const qt0 = tokenize(query).filter(w => !STOP.has(w));
  const qt = expandTerms(qt0);
  const ttSet = new Set(tokenize(title));
  let match = 0; qt.forEach(w => { if (ttSet.has(w)) match++; });
  const ratio = qt.length ? match / qt.length : 0;
  return { match, ratio, terms: qt.length };
}
function hasCategoryTerm(query, title) {
  const cat = new Set(['sabuk', 'gesper', 'belt', 'ikat', 'pinggang']);
  const q = tokenize(query); const t = new Set(tokenize(title));
  const qHasCat = q.some(w => cat.has(w));
  const tHasCat = Array.from(cat).some(w => t.has(w));
  return qHasCat ? tHasCat : false;
}

// ------------ Wait helpers ------------
async function waitGridChanged(page, gridSelector, beforeHtml, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const count = await page.locator(`${gridSelector} .col`).count();
      if (count >= 4) return true;
      const html = await page.locator(gridSelector).innerHTML().catch(() => '');
      if (beforeHtml && html && html !== beforeHtml) return true;
    } catch { }
    await page.waitForTimeout(250);
  }
  return false;
}
async function waitCardsAppear(p, selector, min = 4, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const count = await p.locator(`${selector} .col`).count();
      if (count >= min) return true;
    } catch { }
    await p.waitForTimeout(300);
  }
  return false;
}

// ------------ Submit form ------------
async function submitSearchForm(page, gridSelector) {
  const form = page.locator('form').filter({ has: page.locator('#src') });
  if (!(await form.count())) throw new Error('Form pencarian tidak ditemukan.');

  const beforeHtml = await page.locator(gridSelector).innerHTML().catch(() => '');

  await form.evaluate(f => f.requestSubmit()).catch(() => { });
  await Promise.race([
    waitGridChanged(page, gridSelector, beforeHtml, 12000),
    page.waitForTimeout(800),
  ]);

  const after1 = await page.locator(gridSelector).innerHTML().catch(() => '');
  if (beforeHtml && after1 && after1 !== beforeHtml) return;

  if (await page.locator('#max_price').count()) {
    await page.focus('#max_price').catch(() => { });
    await page.keyboard.press('Enter').catch(() => { });
  } else {
    await page.focus('#src').catch(() => { });
    await page.keyboard.press('Enter').catch(() => { });
  }
  await Promise.race([
    waitGridChanged(page, gridSelector, beforeHtml, 12000),
    page.waitForTimeout(900),
  ]);

  const after2 = await page.locator(gridSelector).innerHTML().catch(() => '');
  if (beforeHtml && after2 && after2 !== beforeHtml) return;

  const visibleBtn = form.locator('button[type="submit"]:visible');
  if (await visibleBtn.count()) {
    await visibleBtn.first().scrollIntoViewIfNeeded().catch(() => { });
    await visibleBtn.first().click({ timeout: 5000 }).catch(() => { });
    await Promise.race([
      waitGridChanged(page, gridSelector, beforeHtml, 12000),
      page.waitForTimeout(900),
    ]);
  }
}

// ------------ Identity helpers ------------
async function extractCardIdentity(cardHandle) {
  // Ambil identitas stabil dari satu kartu
  const bannerId = await cardHandle.$eval('.card', n => n.getAttribute('data-banner-id') || '').catch(() => '');
  const title = await cardHandle.$eval('.card-title', n => n.textContent?.trim() || '').catch(() => '');
  const shop = await cardHandle.$eval('.shopName', n => n.textContent?.replace(/\s+/g,' ').trim() || '').catch(() => '');
  const priceStr = await cardHandle.$eval('.newPrice', n => n.textContent || '').catch(() => '');
  const soldStr = await cardHandle.$eval('.sold', n => n.textContent || '').catch(() => '');
  const commStr = await cardHandle.$eval('.commission', n => n.textContent || '').catch(() => '');
  const imgUrl = await cardHandle.$eval('img.card-img', n => n.getAttribute('src') || n.getAttribute('data-src') || '').catch(() => '');
  return { bannerId, title, shop, priceStr, soldStr, commStr, imgUrl };
}

function normalizeShopText(txt) {
  // Hilangkan ikon/label: "glad2glow.indo" dari contoh HTML sudah bersih,
  // tapi tetap distandarkan
  return (txt || '').toLowerCase().replace(/\s+/g,' ').trim();
}

async function findCardByIdentity(page, gridSelector, identity) {
  // 1) Cari by banner-id (paling kuat)
  if (identity.bannerId) {
    const byId = page.locator(`${gridSelector} .card[data-banner-id="${identity.bannerId}"]`);
    if (await byId.count()) {
      return byId.first();
    }
  }
  // 2) Fallback: cari by (judul + shopName)
  const candidates = page.locator(`${gridSelector} .col`);
  const total = await candidates.count();
  const targetTitle = (identity.title || '').trim().toLowerCase();
  const targetShop = normalizeShopText(identity.shop);

  for (let i = 0; i < total; i++) {
    const el = candidates.nth(i);
    const t = (await el.locator('.card-title').textContent().catch(() => '') || '').trim().toLowerCase();
    const s = normalizeShopText(await el.locator('.shopName').textContent().catch(() => ''));
    if (t === targetTitle && s === targetShop) {
      // kembalikan node .card di dalam col
      const card = el.locator('.card');
      if (await card.count()) return card.first();
      return el;
    }
  }
  return null;
}

// Tunggu modal siap dan link sudah terisi (bukan sisa state lama)
async function waitAffiliateReady(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const genHidden = await page.locator('#generate_link_at.d-none').count().catch(() => 0);
      const showVisible = await page.locator('#show_link_at:not(.d-none)').count().catch(() => 0);
      if (showVisible && genHidden) return true;
    } catch { }
    await page.waitForTimeout(300);
  }
  return false;
}

// ------------ Modal affiliate link (identity-safe) ------------
async function getAffiliateLinkForCardByIdentity(page, gridSelector, identity) {
  // Pastikan target card tepat
  const targetCard = await findCardByIdentity(page, gridSelector, identity);
  if (!targetCard) {
    console.warn('[AFFILIATE] Card not found for identity:', identity);
    return null;
  }

  // Scroll & hover agar tombol GET LINK tampak
  await targetCard.scrollIntoViewIfNeeded().catch(() => { });
  await targetCard.hover().catch(() => { });

  // Klik tombol GET LINK di dalam card target
  const getLinkBtn = targetCard.locator('button:has-text("GET LINK")');
  if (!(await getLinkBtn.count())) {
    console.warn('[AFFILIATE] GET LINK button not found for identity:', identity);
    return null;
  }
  await getLinkBtn.first().click().catch(() => { });

  // Tunggu modal terbuka
  const genSel = '#generate_link_at';
  const showSel = '#show_link_at';
  await page.waitForSelector(`${genSel}, ${showSel}`, { timeout: 12000 }).catch(() => { });

  // Jika generator masih terlihat, pastikan opsi & klik generate
  const genVisible = await page.locator(`${genSel}:not(.d-none)`).count();
  if (genVisible) {
    const radio = page.locator('#withoutSubId');
    if (await radio.count()) {
      const checked = await radio.isChecked().catch(() => true);
      if (!checked) await radio.check().catch(() => { });
    }
    const genBtn = page.locator('#generate_link_now');
    if (await genBtn.count()) await genBtn.click().catch(() => { });
  }

  // Tunggu sampai panel show_link aktif & konten benar-benar pindah
  await waitAffiliateReady(page, 12000);
  await sleep(500); // jeda kecil untuk isi field

  // Baca link dari beberapa kandidat field
  const candidateSelectors = [
    '#getAffiliateSosmed',
    '#getAffiliateLink',
    'input[name="affiliate_link"]',
    'textarea[name="affiliate_link"]'
  ];

  let url = null;
  for (let attempt = 0; attempt < 3 && !url; attempt++) {
    for (const sel of candidateSelectors) {
      try {
        const has = await page.locator(sel).count();
        if (!has) continue;

        // Tunggu value terisi
        await page.waitForFunction(
          (selector) => {
            const el = document.querySelector(selector);
            const v = el && ('value' in el ? el.value : el.textContent);
            return !!(v && v.trim().length > 0);
          },
          sel,
          { timeout: 5000 }
        ).catch(() => { });

        const val = await page.locator(sel).inputValue().catch(async () => {
          const txt = await page.locator(sel).textContent().catch(() => '');
          return txt || '';
        });
        if (val && /^https?:\/\//i.test(val)) { url = val; break; }
      } catch { }
    }
    if (!url) await page.waitForTimeout(500);
  }

  // Tutup modal
  const closeBtn = page.locator('button.btn-close.backToModal');
  if (await closeBtn.count()) {
    await closeBtn.first().click().catch(() => { });
    // beri waktu modal menutup
    await page.waitForTimeout(300);
  } else {
    await page.keyboard.press('Escape').catch(() => { });
  }

  if (!url) {
    console.warn('[AFFILIATE] No link generated for identity:', {
      bannerId: identity.bannerId,
      title: identity.title?.slice(0, 80),
      shop: identity.shop,
    });
  }
  return url || null;
}

// ------------ Core scrape (with identity-safe affiliate) ------------
export async function scrapeOnePageTop5({ product_name, min_price = 0, max_price = 0, affiliateConcurrency = 3 }) {
  if (!product_name || typeof product_name !== 'string') {
    throw new Error('product_name wajib diisi (string).');
  }
  if (min_price && max_price && Number(min_price) > Number(max_price)) {
    throw new Error('min_price tidak boleh lebih besar dari max_price.');
  }

  const { browser, context } = await ensureLogin();
  const page = await context.newPage();
  await applyNetworkBlocking(page);

  try {
    console.time(`[SCRAPE] ${product_name}`);
    const gridSelector = '.gridCampaigns.campaign-list.tiktok-product';

    // 1) Buka TTS & isi form
    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#src', { timeout: 15000 });
    await page.fill('#src', product_name);
    if (min_price && Number(min_price) > 0) await page.fill('#min_price', String(min_price)); else await page.fill('#min_price', '');
    if (max_price && Number(max_price) > 0) await page.fill('#max_price', String(max_price)); else await page.fill('#max_price', '');
    await page.selectOption('#t_store_rating', { value: '2' }).catch(() => { });
    await page.dispatchEvent('#t_store_rating', 'change').catch(() => { });

    await page.waitForSelector(gridSelector, { timeout: 20000 }).catch(() => { });
    await submitSearchForm(page, gridSelector);

    // Robust wait + retry
    let ok = await waitCardsAppear(page, gridSelector, 4, 25000);
    if (!ok) {
      await page.dispatchEvent('#src', 'input').catch(() => { });
      await submitSearchForm(page, gridSelector);
      ok = await waitCardsAppear(page, gridSelector, 4, 25000);
    }
    if (!ok) {
      try {
        await page.selectOption('#t_store_rating', { value: '0' });
        await page.dispatchEvent('#t_store_rating', 'change').catch(() => { });
      } catch { }
      await submitSearchForm(page, gridSelector);
      ok = await waitCardsAppear(page, gridSelector, 4, 25000);
    }
    if (!ok) throw new Error('Listing tidak muncul: kemungkinan halaman tidak merespons atau selector berubah.');

    // 2) Scan kartu + identitas stabil
    await page.waitForTimeout(300);
    const itemsLoc = page.locator(`${gridSelector} .col`);
    const itemHandles = await itemsLoc.elementHandles();
    console.log(`[SCRAPE] Items found on main page: ${itemHandles.length}`);

    const hasModel = !!extractModelToken(product_name);
    let strictRows = [], softRows = [], catRows = [];

    async function scanRange(maxTake) {
      strictRows = []; softRows = []; catRows = [];
      for (let i = 0; i < maxTake; i++) {
        const el = itemHandles[i];
        const {
          bannerId, title, shop, priceStr, soldStr, commStr, imgUrl
        } = await extractCardIdentity(el);

        if (!title) continue;

        const price = parseCurrencyToInt(priceStr);
        const sold = parseSold(soldStr);
        let commission = 0;
        const earnMatch = commStr.match(/Earn\s*:\s*Rp\.?\s*([\d. ,]+)/i);
        if (earnMatch) commission = parseCurrencyToInt(earnMatch[1]);
        else {
          const nums = (commStr.match(/[\d. ,]+/g) || []).map(parseCurrencyToInt).filter(n => n > 0);
          if (nums.length) commission = nums[nums.length - 1];
        }

        if (min_price && price < Number(min_price)) continue;
        if (max_price && price > Number(max_price)) continue;

        let putWhere = null;
        if (hasModel) {
          const s = scoreTitleModelMode(product_name, title);
          if (s >= 3) putWhere = 'strict';
        } else {
          const { match, ratio } = textSimGeneric(product_name, title);
          if ((match >= 2 && ratio >= 0.4) || (match >= 1 && ratio >= 0.6)) putWhere = 'strict';
          else if ((match >= 1 && ratio >= 0.3)) putWhere = 'soft';
          else if (hasCategoryTerm(product_name, title)) putWhere = 'cat';
        }
        if (!putWhere) continue;

        const row = {
          banner_id: bannerId || null,
          product_name: title,
          shop_name: shop,
          price,
          sold,
          _commission: commission,
          image_url: imgUrl || null,
          affiliate_url: null,
        };
        if (putWhere === 'strict') strictRows.push(row);
        else if (putWhere === 'soft') softRows.push(row);
        else catRows.push(row);
      }
    }

    // Ambil 12 dulu, kalau kurang perluas 20
    let takeLimit = Math.min(itemHandles.length, 12);
    await scanRange(takeLimit);
    const totalCandidates = strictRows.length + softRows.length + catRows.length;
    if (totalCandidates < 4 && itemHandles.length > takeLimit) {
      takeLimit = Math.min(itemHandles.length, 20);
      await scanRange(takeLimit);
    }

    // 3) Merge unik + ranking
    const seen = new Set(), merged = [];
    function keyOf(r) {
      const t = (r.product_name || '').toLowerCase();
      const s = (r.shop_name || '').toLowerCase();
      return `${t}|||${s}`;
    }
    function pushUnique(arr) {
      for (const r of arr) {
        const key = keyOf(r);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
        if (merged.length >= 20) break;
      }
    }
    pushUnique(strictRows);
    if (merged.length < 4) pushUnique(softRows);
    if (merged.length < 4) pushUnique(catRows);

    merged.sort((a, b) => {
      if (b.sold !== a.sold) return b.sold - a.sold;
      if (b._commission !== a._commission) return b._commission - a._commission;
      return a.price - b.price;
    });

    const top = merged.slice(0, 5);

    // 4) Ambil affiliate link paralel aman (berbasis IDENTITAS)
    async function createSearchPage() {
      const p = await context.newPage();
      await applyNetworkBlocking(p);
      await p.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForSelector('#src', { timeout: 15000 });
      await p.fill('#src', product_name);
      if (min_price && Number(min_price) > 0) await p.fill('#min_price', String(min_price)); else await p.fill('#min_price', '');
      if (max_price && Number(max_price) > 0) await p.fill('#max_price', String(max_price)); else await p.fill('#max_price', '');
      await p.selectOption('#t_store_rating', { value: '2' }).catch(() => { });
      await p.dispatchEvent('#t_store_rating', 'change').catch(() => { });

      const gridSelector2 = '.gridCampaigns.campaign-list.tiktok-product';
      await p.waitForSelector(gridSelector2, { timeout: 20000 }).catch(() => { });
      await submitSearchForm(p, gridSelector2);

      let okH = await waitCardsAppear(p, gridSelector2, 4, 25000);
      if (!okH) {
        await p.dispatchEvent('#src', 'input').catch(() => { });
        await submitSearchForm(p, gridSelector2);
        okH = await waitCardsAppear(p, gridSelector2, 4, 25000);
      }
      if (!okH) {
        try {
          await p.selectOption('#t_store_rating', { value: '0' });
          await p.dispatchEvent('#t_store_rating', 'change').catch(() => { });
        } catch { }
        await submitSearchForm(p, gridSelector2);
        okH = await waitCardsAppear(p, gridSelector2, 4, 25000);
      }
      if (!okH) throw new Error('Helper page gagal memuat listing untuk affiliate modal.');
      await p.waitForTimeout(200);
      return { page: p, gridSelector: gridSelector2 };
    }

    const concurrency = Math.max(1, Math.min(affiliateConcurrency || 3, top.length));
    const queue = top.map((item, i) => ({ ...item, qidx: i }));
    const linkResults = new Array(top.length).fill(null);

    async function worker() {
      const { page: wp, gridSelector: wgrid } = await createSearchPage();
      try {
        while (queue.length) {
          const item = queue.shift();
          if (!item) break;

          // Buat identity dari item TOP
          const identity = {
            bannerId: item.banner_id || '',
            title: item.product_name || '',
            shop: item.shop_name || '',
          };

          const url = await getAffiliateLinkForCardByIdentity(wp, wgrid, identity);
          linkResults[item.qidx] = url || null;

          // jeda pendek antar item untuk mengurangi throttle/overlap state
          await wp.waitForTimeout(250);
        }
      } finally {
        await safeClosePage(wp);
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    for (let i = 0; i < top.length; i++) {
      top[i].affiliate_url = linkResults[i] || null;
    }

    const out = top.map(({ product_name, shop_name, price, sold, affiliate_url, image_url }) => ({
      product_name,
      shop_name,
      price,
      sold,
      affiliate_url,
      image_url,
    }));

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2)).catch(() => { });
    console.timeEnd(`[SCRAPE] ${product_name}`);
    return out;
  } finally {
    await safeClosePage(page);
  }
}

// Opsional: panggil saat proses akan berhenti agar resource bersih.
export async function shutdownBrowser() {
  try {
    if (contextPromise) {
      const ctx = await contextPromise;
      await ctx.close();
    }
  } catch { }
  try {
    const br = await getBrowser();
    await br.close();
  } catch { }
}
