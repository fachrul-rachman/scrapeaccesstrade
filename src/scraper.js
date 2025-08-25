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

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function ensureDirs() { await fs.mkdir(STORAGE_DIR, { recursive: true }); }

// -------------------- LOGIN --------------------
async function isStillLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return !page.url().includes('/publisher/login');
  } finally { await page.close(); }
}

async function performLoginAndSave(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('input#username', { timeout: 20000 });
  await page.fill('input#username', ACCESSTRADE_EMAIL || '');
  await page.fill('input#password', ACCESSTRADE_PASSWORD || '');
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
    page.click('button.btn.btn-at.rounded-lg.shadow-lg.py-2.px-5')
  ]);

  await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (page.url().includes('/publisher/login')) throw new Error('Login gagal.');

  await ensureDirs();
  await context.storageState({ path: STORAGE_FILE });
  await page.close();
  return context;
}

export async function ensureLogin() {
  if (!ACCESSTRADE_EMAIL || !ACCESSTRADE_PASSWORD) {
    throw new Error('ENV ACCESSTRADE_EMAIL / ACCESSTRADE_PASSWORD belum diisi.');
  }
  await ensureDirs();
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  if (await fileExists(STORAGE_FILE)) {
    let context = await browser.newContext({
      storageState: STORAGE_FILE,
      viewport: { width: 1366, height: 900 },
    });
    if (await isStillLoggedIn(context)) return { browser, context, fromCache: true };
    await context.close();
  }
  const context = await performLoginAndSave(browser);
  return { browser, context, fromCache: false };
}

export async function closeAll(browser, context) {
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
}

// -------------------- UTIL PARSER --------------------
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

// -------------------- FILTER NAMA --------------------
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
  return score; // threshold 3
}
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
const STOP = new Set(['dan','dengan','yang','untuk','di','ke','dari','itu','ini','the','of','a','an','to','on','in','by','or','as']);
const SYN = {
  sabuk: ['ikat','pinggang','gesper','belt'],
  gesper: ['sabuk','ikat','pinggang','belt'],
  cowo: ['cowok','pria','laki','laki-laki','lk','men','male'],
  pria: ['cowo','cowok','laki','laki-laki','men','male'],
  'tanpa lubang': ['no hole','no-hole','ratchet','otomatis','automatic'],
};
function expandTerms(terms) {
  const out = new Set();
  const joined = terms.join(' ');
  if (joined.includes('tanpa lubang')) SYN['tanpa lubang'].forEach(s=>out.add(s));
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
  const cat = new Set(['sabuk','gesper','belt','ikat','pinggang']);
  const q = tokenize(query); const t = new Set(tokenize(title));
  const qHasCat = q.some(w => cat.has(w));
  const tHasCat = Array.from(cat).some(w => t.has(w));
  return qHasCat ? tHasCat : false;
}

// -------------------- SUBMIT FORM --------------------
async function submitSearchForm(page, gridSelector) {
  const form = page.locator('form').filter({ has: page.locator('#src') });
  if (!(await form.count())) throw new Error('Form pencarian tidak ditemukan.');
  const before = await page.locator(gridSelector).innerHTML().catch(() => '');
  await form.evaluate(f => f.requestSubmit()).catch(() => {});
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 60000 }),
    page.waitForTimeout(1200),
  ]);
  let after = await page.locator(gridSelector).innerHTML().catch(() => '');
  if (after && before && after !== before) return;

  if (await page.locator('#max_price').count()) {
    await page.focus('#max_price').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  } else {
    await page.focus('#src').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: 60000 }),
    page.waitForTimeout(1500),
  ]);
  after = await page.locator(gridSelector).innerHTML().catch(() => '');
  if (after && before && after !== before) return;

  const visibleBtn = form.locator('button[type="submit"]:visible');
  if (await visibleBtn.count()) {
    await visibleBtn.first().scrollIntoViewIfNeeded().catch(() => {});
    await visibleBtn.first().click({ timeout: 8000 }).catch(() => {});
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 60000 }),
      page.waitForTimeout(1500),
    ]);
  }
}

// -------------------- MODAL: GET AFFILIATE LINK --------------------
async function getAffiliateLinkForCard(page, cardLocator) {
  const getLinkBtn = cardLocator.locator('button:has-text("GET LINK")');
  if (!(await getLinkBtn.count())) return null;

  await cardLocator.scrollIntoViewIfNeeded().catch(() => {});
  await getLinkBtn.first().click().catch(() => {});

  const genSel = '#generate_link_at';
  const showSel = '#show_link_at';
  await page.waitForSelector(`${genSel}, ${showSel}`, { timeout: 10000 }).catch(() => {});

  const genVisible = await page.locator(`${genSel}:not(.d-none)`).count();
  if (genVisible) {
    const radio = page.locator('#withoutSubId');
    if (await radio.count()) {
      const checked = await radio.isChecked().catch(() => true);
      if (!checked) await radio.check().catch(() => {});
    }
    const genBtn = page.locator('#generate_link_now');
    if (await genBtn.count()) await genBtn.click().catch(() => {});
  }

  await Promise.race([
  page.waitForSelector('#generate_link_at.d-none', { timeout: 5000 }),
  page.waitForTimeout(1200) // cover delay "Generate Link..."
]);
await page.waitForSelector('#show_link_at:not(.d-none)', { timeout: 8000 }).catch(() => {});

  const inputSel = '#getAffiliateSosmed';
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return !!(el && el.value && el.value.trim().length > 0);
      },
      inputSel,
      { timeout: 15000 }
    );
  } catch {
    await page.waitForSelector(`${showSel}:not(.d-none)`, { timeout: 5000 }).catch(() => {});
  }

  let url = null;
  try {
    url = await page.inputValue(inputSel);
    if (!url || !/^https?:\/\//i.test(url)) url = null;
  } catch {}

  const closeBtn = page.locator('button.btn-close.backToModal');
  if (await closeBtn.count()) {
    await closeBtn.first().click().catch(() => {});
    await page.waitForSelector(inputSel, { state: 'detached', timeout: 5000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }

  return url;
}

// -------------------- SCRAPE 1 PAGE + TOP-5 + AFFILIATE --------------------
export async function scrapeOnePageTop5({ product_name, min_price = 0, max_price = 0 }) {
  if (!product_name || typeof product_name !== 'string') {
    throw new Error('product_name wajib diisi (string).');
  }
  if (min_price && max_price && Number(min_price) > Number(max_price)) {
    throw new Error('min_price tidak boleh lebih besar dari max_price.');
  }

  const { browser, context } = await ensureLogin();
  const page = await context.newPage();

  try {
    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await page.waitForSelector('#src', { timeout: 20000 });
    await page.fill('#src', product_name);
    if (min_price && Number(min_price) > 0) await page.fill('#min_price', String(min_price)); else await page.fill('#min_price', '');
    if (max_price && Number(max_price) > 0) await page.fill('#max_price', String(max_price)); else await page.fill('#max_price', '');
    await page.selectOption('#t_store_rating', { value: '2' }).catch(() => {});
    await page.dispatchEvent('#t_store_rating', 'change').catch(() => {});

    const gridSelector = '.gridCampaigns.campaign-list.tiktok-product';
    await page.waitForSelector(gridSelector, { timeout: 30000 }).catch(() => {});
    await submitSearchForm(page, gridSelector);

    await page.waitForSelector(`${gridSelector} .col`, { timeout: 30000 });
    await page.waitForTimeout(500);

    const itemsLoc = page.locator(`${gridSelector} .col`);
    const itemHandles = await itemsLoc.elementHandles();
    const take = Math.min(itemHandles.length, 20);

    const hasModel = !!extractModelToken(product_name);
    const strictRows = [], softRows = [], catRows = [];

    for (let i = 0; i < take; i++) {
      const el = itemHandles[i];
      const title = await el.$eval('.card-title', n => n.textContent?.trim() || '').catch(() => '');
      const priceStr = await el.$eval('.newPrice', n => n.textContent || '').catch(() => '');
      const soldStr = await el.$eval('.sold', n => n.textContent || '').catch(() => '');
      const commStr = await el.$eval('.commission', n => n.textContent || '').catch(() => '');
      const imgUrl = await (async () => {
        const s = await el.$eval('img.card-img', n => n.getAttribute('src') || n.getAttribute('data-src') || '').catch(() => '');
        return s || null;
      })();
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
        idx: i,
        product_name: title,
        price,
        sold,
        _commission: commission,
        image_url: imgUrl,
        affiliate_url: null,
      };
      if (putWhere === 'strict') strictRows.push(row);
      else if (putWhere === 'soft') softRows.push(row);
      else catRows.push(row);
    }

    const seen = new Set(), merged = [];
    const pushUnique = (arr) => {
      for (const r of arr) {
        const key = (r.product_name || '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key); merged.push(r);
        if (merged.length >= 20) break;
      }
    };
    pushUnique(strictRows);
    if (merged.length < 4) pushUnique(softRows);
    if (merged.length < 4) pushUnique(catRows);

    merged.sort((a, b) => {
      if (b.sold !== a.sold) return b.sold - a.sold;
      if (b._commission !== a._commission) return b._commission - a._commission;
      return a.price - b.price;
    });
    const top = merged.slice(0, 5);

    // Ambil affiliate link per item top
    for (const item of top) {
      try {
        const card = itemsLoc.nth(item.idx);
        const url = await getAffiliateLinkForCard(page, card);
        item.affiliate_url = url || null;
      } catch {
        item.affiliate_url = null;
      }
    }

    const out = top.map(({ product_name, price, sold, affiliate_url, image_url }) => ({
      product_name, price, sold, affiliate_url, image_url,
    }));

    try {
      await fs.mkdir(path.resolve('data/outputs'), { recursive: true });
      await fs.writeFile(path.resolve('data/outputs/latest.json'), JSON.stringify(out, null, 2));
    } catch {}

    return out;
  } finally {
    await closeAll(browser, context);
  }
}
