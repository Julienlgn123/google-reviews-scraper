import express from 'express';
import puppeteer from 'puppeteer';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/ui', express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

const REVIEW_NODE_SELECTOR = '[data-review-id], .jftiEf, div[jslog*="reviewId"]';

// ─── Browser pool ──────────────────────────────────────────────────────────────
// Plusieurs instances Chromium peuvent tourner en parallèle. Chaque scrape
// réserve un "slot" : on remplit d'abord les browsers déjà ouverts (jusqu'à
// MAX_TABS_PER_BROWSER onglets chacun) et on n'en lance un nouveau que si
// tous les browsers existants sont pleins — dans la limite de MAX_BROWSERS.
// Les browsers ne sont donc ouverts qu'"en cas de besoin".
//
// Chaque browser a aussi son propre pool d'onglets réutilisables : un onglet
// est configuré une seule fois (UA, viewport, blocage images/médias/polices,
// anti-détection) puis réutilisé d'une requête à l'autre — on ne paie plus le
// coût de création/destruction d'un renderer process à chaque scrape.

const MAX_TABS_PER_BROWSER = parseInt(process.env.MAX_TABS_PER_BROWSER) || 10;
const MAX_BROWSERS = parseInt(process.env.MAX_BROWSERS) || 5;

// browserPool[i] = { browser, activeTabs, ready, availablePages, pagesCreated }
const browserPool = [];

// Requêtes en attente d'un slot — remplace un polling actif par un réveil
// événementiel dès qu'un slot se libère ou qu'un nouveau browser est prêt.
const slotWaiters = [];

function wakeOneWaiter() {
  if (slotWaiters.length > 0) slotWaiters.shift()();
}

// ─── Chromium ultra-léger ──────────────────────────────────────────────────────
// Isolation de site désactivée + tous les services d'arrière-plan coupés :
// c'est ce qui réduit le plus la RAM/CPU par onglet quand on en fait tourner
// beaucoup en parallèle (moins de renderer processes, moins de threads actifs
// pour rien).
function buildLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-web-security',
    '--window-size=1024,768',
    '--lang=fr-FR,fr',
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--disable-ipc-flooding-protection',
    '--disable-features=Translate,BackForwardCache,IsolateOrigins,site-per-process,MediaRouter,AudioServiceOutOfProcess',
    '--metrics-recording-only',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
  ];
}

async function launchBrowser(entry) {
  console.log(`[browser] Launching Chromium instance (${browserPool.length}/${MAX_BROWSERS})...`);
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: buildLaunchArgs(),
    });

    entry.browser = browser;
    browser.on('disconnected', () => {
      console.log('[browser] Instance disconnected — removing from pool');
      const idx = browserPool.indexOf(entry);
      if (idx !== -1) browserPool.splice(idx, 1);
    });

    return browser;
  } catch (err) {
    console.error('[browser] Failed to launch instance:', err.message);
    const idx = browserPool.indexOf(entry);
    if (idx !== -1) browserPool.splice(idx, 1);
    throw err;
  }
}

async function prewarmBrowser() {
  const entry = { browser: null, activeTabs: 0, ready: null, availablePages: [], pagesCreated: 0 };
  browserPool.push(entry);
  entry.ready = launchBrowser(entry);
  try {
    await entry.ready;
    console.log(`[browser] Chromium prêt ✅ (pool: 1/${MAX_BROWSERS})`);
  } catch (err) {
    console.error('[browser] Échec du démarrage de Chromium :', err.message);
  }
}

function poolStatus() {
  return {
    browsersOpen: browserPool.length,
    maxBrowsers: MAX_BROWSERS,
    maxTabsPerBrowser: MAX_TABS_PER_BROWSER,
    maxConcurrentTabs: MAX_BROWSERS * MAX_TABS_PER_BROWSER,
    activeTabs: browserPool.reduce((sum, e) => sum + e.activeTabs, 0),
  };
}

function findOrCreateEntry() {
  let entry = browserPool
    .filter((e) => e.activeTabs < MAX_TABS_PER_BROWSER)
    .sort((a, b) => b.activeTabs - a.activeTabs)[0];

  if (!entry && browserPool.length < MAX_BROWSERS) {
    entry = { browser: null, activeTabs: 0, ready: null, availablePages: [], pagesCreated: 0 };
    browserPool.push(entry);
    entry.ready = launchBrowser(entry);
  }

  return entry;
}

// ─── Slot allocator — remplit les browsers existants avant d'en ouvrir un nouveau
async function acquireSlot() {
  let entry = findOrCreateEntry();
  while (!entry) {
    await new Promise((resolve) => slotWaiters.push(resolve));
    entry = findOrCreateEntry();
  }

  entry.activeTabs++;
  try {
    await entry.ready;
  } catch (err) {
    entry.activeTabs = Math.max(0, entry.activeTabs - 1);
    wakeOneWaiter();
    throw err;
  }
  return entry;
}

function releaseSlot(entry) {
  entry.activeTabs = Math.max(0, entry.activeTabs - 1);
  wakeOneWaiter();
}

// ─── Allège chaque onglet — on ne lit que du texte/attributs, jamais de rendu
// visuel : bloquer images/médias/polices réduit nettement le CPU/réseau par
// onglet sans toucher au CSS (dont Google Maps a besoin pour le lazy-load de
// la liste d'avis) ni au JS/XHR (qui chargent les données des avis).
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);
async function blockHeavyResources(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort();
    else req.continue();
  });
}

async function configurePage(page) {
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1024, height: 768 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await blockHeavyResources(page);
  return page;
}

// Onglet réutilisable : recyclé depuis le pool du browser si disponible,
// sinon créé (jusqu'à MAX_TABS_PER_BROWSER par browser — la même limite que
// le slot déjà réservé via acquireSlot garantit qu'on ne dépasse jamais ça).
async function acquirePage(entry) {
  if (entry.availablePages.length > 0) return entry.availablePages.pop();
  entry.pagesCreated++;
  const page = await entry.browser.newPage();
  await configurePage(page);
  return page;
}

function releasePage(entry, page) {
  entry.availablePages.push(page);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  const token = req.headers['x-api-key'] || req.query.api_key;
  if (token !== secret) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }
  next();
});

// ─── Routes info ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'Google Reviews Scraper API',
    status: 'running',
    ...poolStatus(),
    endpoints: {
      'POST /scrape':       'Scrape a single Google Maps URL',
      'POST /scrape-batch': 'Scrape up to 10 URLs in parallel',
      'GET  /health':       'Health check',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ...poolStatus(),
    timestamp: new Date().toISOString(),
  });
});

// ─── URL resolution ───────────────────────────────────────────────────────────
async function resolveUrl(b, url) {
  if (!url.includes('goo.gl') && !url.includes('maps.app')) return url;

  const page = await b.newPage();
  await blockHeavyResources(page);
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const resolved = page.url();
    await page.close();
    return resolved;
  } catch {
    const resolved = page.url();
    await page.close();
    return resolved && resolved !== 'about:blank' ? resolved : url;
  }
}

// Google affiche un nag "Connectez-vous pour profiter pleinement de Google
// Maps" sur certaines actions (trier, enregistrer, rédiger un avis) quand la
// session est anonyme — il intercepte le clic au lieu d'ouvrir le menu visé,
// et il peut réapparaître à *chaque* clic, pas juste une fois.
async function dismissSigninNag(page) {
  try {
    return await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('body *'));
      const el = els.find((e) => e.children.length === 0 && e.textContent?.trim() === 'Ignorer');
      if (el) { el.click(); return true; }
      return false;
    });
  } catch {
    return false;
  }
}

// ─── Une tentative de scrape — onglet réutilisé, jamais fermé ici ─────────────
async function attemptScrape(page, url, maxReviews, sortBy) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page
    .waitForFunction(() => document.querySelector('h1') || document.querySelectorAll('form').length >= 2, {
      timeout: 5000,
      polling: 'mutation',
    })
    .catch(() => {});

  // Cookie consent — n'attend que si un bandeau a réellement été fermé
  try {
    const consentClicked = await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      if (forms.length >= 2) {
        const btn = forms[1].querySelector('button');
        if (btn) { btn.click(); return true; }
      }
      return false;
    });
    if (consentClicked) {
      await page
        .waitForFunction(() => document.querySelectorAll('form').length < 2, { timeout: 5000, polling: 'mutation' })
        .catch(() => {});
    }
  } catch (_) {}

  await dismissSigninNag(page);

  // Business info
  const businessInfo = await page.evaluate(() => {
    const name =
      document.querySelector('h1.DUwDvf')?.textContent?.trim() ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('[aria-label][role="main"] h1')?.textContent?.trim() ||
      'N/A';
    const ratingEl =
      document.querySelector('div.F7nice span[aria-hidden="true"]') ||
      document.querySelector('span.ceNzKf') ||
      document.querySelector('[class*="stars"] span');
    const rating = ratingEl?.textContent?.trim() || 'N/A';
    const reviewCountEl =
      document.querySelector('button.HHrUdb') ||
      document.querySelector('span[aria-label*="avis"]') ||
      document.querySelector('span[aria-label*="reviews"]') ||
      document.querySelector('div.F7nice span span:last-child');
    const reviewCount = reviewCountEl?.textContent?.trim() || 'N/A';
    return { name, rating, reviewCount };
  });

  // Click "Avis" tab
  try {
    const clicked = await page.evaluate(() => {
      const allTabs = Array.from(
        document.querySelectorAll('button[role="tab"], div[role="tab"], button.hh2c6')
      );
      const reviewTab = allTabs.find((el) => {
        const t = el.textContent?.toLowerCase() || '';
        const a = el.getAttribute('aria-label')?.toLowerCase() || '';
        return t.includes('avis') || t.includes('review') || a.includes('avis') || a.includes('review');
      });
      if (reviewTab) { reviewTab.click(); return true; }
      return false;
    });
    if (clicked) {
      await page
        .waitForFunction((sel) => !!document.querySelector(sel), { timeout: 4000, polling: 'mutation' }, REVIEW_NODE_SELECTOR)
        .catch(() => {});
    }
  } catch (_) {}

  await dismissSigninNag(page);

  // Wait for reviews (safety net in case they were already present)
  await page
    .waitForSelector(
      '[data-review-id], .jftiEf, div[jslog*="reviewId"], div[class*="review"] div[class*="rating"]',
      { timeout: 10000 }
    )
    .catch(() => {});

  // ─── Sort ────────────────────────────────────────────────────────────────
  // Toute la séquence (ouvrir le menu -> choisir l'option -> vérifier
  // qu'elle a bien pris effet) est retentée jusqu'à 3 fois : le nag de
  // connexion peut manger le clic sur "Trier", et la vérification peut
  // occasionnellement rater la course contre le re-rendu de Google.
  let sortConfirmed = false;
  try {
    for (let outerAttempt = 0; outerAttempt < 3 && !sortConfirmed; outerAttempt++) {
      let menuOpen = false;

      for (let attempt = 0; attempt < 4; attempt++) {
        const sortClicked = await page.evaluate(() => {
          const btn =
            document.querySelector('button[aria-label="Trier les avis"]') ||
            document.querySelector('button[data-value="Trier"]');
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!sortClicked) break;

        menuOpen = await page
          .waitForFunction(() => !!document.querySelector('div[role="menuitemradio"]'), {
            timeout: 2000,
            polling: 'mutation',
          })
          .then(() => true)
          .catch(() => false);
        if (menuOpen) break;

        const dismissed = await dismissSigninNag(page);
        if (!dismissed) break;

        // Ne pas deviner un délai fixe — attendre que le nag ait vraiment
        // disparu du DOM puis recliquer "Trier" immédiatement. Le nag peut
        // réapparaître à chaque clic : minimiser l'écart ici, c'est ce qui
        // permet de gagner la course au lieu de le re-déclencher sans fin.
        await page
          .waitForFunction(() => {
            const els = Array.from(document.querySelectorAll('body *'));
            return !els.some((e) => e.children.length === 0 && e.textContent?.trim() === 'Ignorer');
          }, { timeout: 1000, polling: 'mutation' })
          .catch(() => {});
      }

      if (!menuOpen) continue;

      const beforeSignature = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute('data-review-id') || el.textContent.slice(0, 50) : null;
      }, REVIEW_NODE_SELECTOR);

      const optionClicked = await page.evaluate((sortMode) => {
        const items = Array.from(document.querySelectorAll('div[role="menuitemradio"]'));
        const target = items.find((el) => {
          const t = el.querySelector('.mLuXec')?.textContent?.toLowerCase() || el.textContent.toLowerCase();
          return sortMode === 'recent'
            ? t.includes('récent') || t.includes('recent')
            : t.includes('pertinent') || t.includes('relevant');
        });
        if (target) { target.click(); return true; }
        if (sortMode === 'recent') {
          const byIndex = document.querySelector('div[role="menuitemradio"][data-index="1"]');
          if (byIndex) { byIndex.click(); return true; }
        }
        return false;
      }, sortBy);

      if (!optionClicked) continue;

      sortConfirmed = await page
        .waitForFunction(
          (sel, prevSig) => {
            const el = document.querySelector(sel);
            const sig = el ? el.getAttribute('data-review-id') || el.textContent.slice(0, 50) : null;
            return sig !== prevSig;
          },
          { timeout: 3000, polling: 'mutation' },
          REVIEW_NODE_SELECTOR,
          beforeSignature
        )
        .then(() => true)
        .catch(() => false);
    }

    if (!sortConfirmed) {
      console.warn(`[sort] could not confirm sort_by="${sortBy}" applied for ${url} — falling back to whatever Google's default order was`);
    }
  } catch (_) {}

  // Scroll & collect
  let reviews = [];
  let stuckCount = 0;
  let lastCount = 0;

  while (reviews.length < maxReviews && stuckCount < 6) {
    await page.evaluate(() => {
      document
        .querySelectorAll(
          'button.w8nwRe, button[jsaction*="review.expand"], ' +
            'button[aria-label*="Voir plus"], button[aria-label*="See more"]'
        )
        .forEach((b) => b.click());
    });
    await SLEEP(300);

    const extracted = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('[data-review-id]'),
        ...document.querySelectorAll('.jftiEf'),
        ...document.querySelectorAll('div[jslog*="reviewId"]'),
      ];
      const seen = new Set();
      const unique = candidates.filter((el) => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      });
      return unique.map((el) => {
        const author =
          el.querySelector('.d4r55')?.textContent?.trim() ||
          el.querySelector('div[class*="author"]')?.textContent?.trim() ||
          el.querySelector('a[href*="contrib"]')?.textContent?.trim() ||
          el.querySelector('button[aria-label]')?.getAttribute('aria-label') ||
          'Anonyme';
        let stars = 0;
        const starsEl = el.querySelector(
          'span[aria-label*="étoile"], span[aria-label*="étoiles"], span[aria-label*="star"]'
        );
        if (starsEl) {
          const m = (starsEl.getAttribute('aria-label') || '').match(/(\d)/);
          if (m) stars = parseInt(m[1]);
        }
        if (!stars) stars = el.querySelectorAll('img[src*="star_full"], span.hCCjke').length;
        const dateEl =
          el.querySelector('.rsqaWe') ||
          el.querySelector('span.xRkPPb') ||
          el.querySelector('.DU9Pgb span') ||
          el.querySelector('span[class*="date"]');
        const date = dateEl?.textContent?.trim() || '';
        const textEl =
          el.querySelector('.wiI7pd') ||
          el.querySelector('span[jsaction*="review.expandText"]') ||
          el.querySelector('.MyEned span') ||
          el.querySelector('div[class*="review"] span[class*="text"]');
        const text = textEl?.textContent?.trim() || '';
        const id =
          el.getAttribute('data-review-id') ||
          el.getAttribute('data-js-log-id') ||
          `${author}__${date}__${text.substring(0, 20)}`;
        return { id, author, stars, date, text };
      });
    });

    const seenIds = new Set(reviews.map((r) => r.id));
    for (const r of extracted) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        reviews.push(r);
      }
    }

    if (reviews.length === lastCount) stuckCount++;
    else { stuckCount = 0; lastCount = reviews.length; }

    if (reviews.length < maxReviews) {
      const countBeforeScroll = reviews.length;

      await page.evaluate(() => {
        const scrollable =
          document.querySelector('div[role="main"] div[tabindex="-1"]') ||
          document.querySelector('.m6QErb[aria-label]') ||
          document.querySelector('div[jsaction*="mouseover:pane"]') ||
          document.querySelector('div[class*="section-scrollbox"]');
        if (scrollable) scrollable.scrollTop += 2000;
        else window.scrollBy(0, 2000);
      });

      // Attend que de nouveaux avis apparaissent suite au scroll (réagit dès
      // la mutation DOM au lieu d'un polling à intervalle fixe) — si rien de
      // nouveau ne charge (fin de liste), on plafonne à 1.8s puis stuckCount
      // prend le relais comme avant.
      await page
        .waitForFunction(
          (sel, prevCount) => document.querySelectorAll(sel).length > prevCount,
          { timeout: 1800, polling: 'mutation' },
          REVIEW_NODE_SELECTOR,
          countBeforeScroll
        )
        .catch(() => {});
    }
  }

  const finalReviews = reviews.slice(0, maxReviews);
  const rated = finalReviews.filter((r) => r.stars > 0);
  const avgRating =
    rated.length > 0
      ? parseFloat((rated.reduce((s, r) => s + r.stars, 0) / rated.length).toFixed(2))
      : null;

  return {
    business: businessInfo,
    sortedBy: sortBy,
    sortConfirmed,
    stats: {
      totalRetrieved: finalReviews.length,
      averageRatingInSample: avgRating,
      withTextComment: finalReviews.filter((r) => r.text).length,
      distribution: [5, 4, 3, 2, 1].reduce((acc, n) => {
        acc[n] = rated.filter((r) => r.stars === n).length;
        return acc;
      }, {}),
    },
    reviews: finalReviews,
  };
}

// ─── Core scraper (gère le slot + l'onglet + les tentatives) ──────────────────
// Deux raisons de retenter toute la page (nouvelle navigation sur le même
// onglet) avant de conclure :
//  - business.name reste "N/A" (page pas chargée correctement, sélecteurs qui
//    ne matchent rien) ;
//  - le tri demandé n'a pas pu être confirmé (le nag "Connectez-vous" a
//    gagné la course à chaque tentative interne) — une navigation fraîche
//    lui donne une nouvelle chance de passer.
// Si le nom reste introuvable après toutes les tentatives, le lien est
// considéré mort/invalide. Si seul le tri reste non confirmé, on renvoie
// quand même les données (avec sortConfirmed:false) plutôt que de jeter un
// résultat par ailleurs valide.
const MAX_SCRAPE_ATTEMPTS = 3;

async function scrapeOnePage(inputUrl, maxReviews, sortBy) {
  const entry = await acquireSlot();
  const page = await acquirePage(entry);

  try {
    const url = await resolveUrl(entry.browser, inputUrl);

    let result;
    for (let attempt = 1; attempt <= MAX_SCRAPE_ATTEMPTS; attempt++) {
      result = await attemptScrape(page, url, maxReviews, sortBy);
      if (result.business.name !== 'N/A' && result.sortConfirmed) break;
      if (attempt < MAX_SCRAPE_ATTEMPTS) {
        const reason = result.business.name === 'N/A' ? 'nom introuvable' : 'tri non confirmé';
        console.log(`[scrape] ${reason} (tentative ${attempt}/${MAX_SCRAPE_ATTEMPTS}) — nouvel essai : ${url}`);
      }
    }

    if (result.business.name === 'N/A') {
      throw new Error(
        `Établissement introuvable après ${MAX_SCRAPE_ATTEMPTS} tentatives — le lien est probablement invalide ou la fiche a été supprimée/déplacée.`
      );
    }

    if (!result.sortConfirmed) {
      console.warn(`[scrape] tri "${sortBy}" non confirmé après ${MAX_SCRAPE_ATTEMPTS} tentatives pour ${url} — données renvoyées dans l'ordre par défaut de Google`);
    }

    return {
      ...result,
      sourceUrl: inputUrl,
      resolvedUrl: url,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    releasePage(entry, page);
    releaseSlot(entry);
  }
}

// ─── Validation URL ───────────────────────────────────────────────────────────
function isValidGoogleMapsUrl(url) {
  return (
    typeof url === 'string' &&
    (url.includes('google.com/maps') ||
      url.includes('maps.app.goo.gl') ||
      url.includes('goo.gl'))
  );
}

// ─── POST /scrape — URL unique ────────────────────────────────────────────────
app.post('/scrape', async (req, res) => {
  const { url, max_reviews = 20, sort_by = 'recent' } = req.body;

  if (!url) return res.status(400).json({ error: 'Missing required field: url' });
  if (!isValidGoogleMapsUrl(url)) {
    return res.status(400).json({ error: 'URL must be a Google Maps link' });
  }
  if (!['recent', 'relevant'].includes(sort_by)) {
    return res.status(400).json({ error: 'sort_by must be "recent" or "relevant"' });
  }

  const count = Math.min(Math.max(1, parseInt(max_reviews) || 20), 200);
  console.log(`[${new Date().toISOString()}] /scrape  url=${url} count=${count}`);

  try {
    const data = await scrapeOnePage(url, count, sort_by);
    console.log(`[${new Date().toISOString()}] Done: ${data.stats.totalRetrieved} avis — "${data.business.name}"`);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error /scrape:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Jobs asynchrones ──────────────────────────────────────────────────────────
// POST /scrape-async répond immédiatement avec un jobId (le scrape tourne en
// arrière-plan) ; GET /job/:id renvoie son état. Ça permet à un appelant avec
// un budget de temps court (ex: une fonction serverless Vercel plafonnée à
// 60s) de ne jamais attendre — il poll juste jusqu'à ce que ce soit prêt.
// L'état vit en mémoire ici (ce process tourne en continu, contrairement à
// une fonction serverless), et est nettoyé après JOB_TTL_MS.
const jobs = new Map(); // jobId -> { status, data, error, createdAt }
const JOB_TTL_MS = 10 * 60 * 1000;

function createJob() {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'pending', data: null, error: null, createdAt: Date.now() });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS).unref();
  return jobId;
}

app.post('/scrape-async', (req, res) => {
  const { url, max_reviews = 20, sort_by = 'recent' } = req.body;

  if (!url) return res.status(400).json({ error: 'Missing required field: url' });
  if (!isValidGoogleMapsUrl(url)) {
    return res.status(400).json({ error: 'URL must be a Google Maps link' });
  }
  if (!['recent', 'relevant'].includes(sort_by)) {
    return res.status(400).json({ error: 'sort_by must be "recent" or "relevant"' });
  }

  const count = Math.min(Math.max(1, parseInt(max_reviews) || 20), 200);
  const jobId = createJob();
  console.log(`[${new Date().toISOString()}] /scrape-async  job=${jobId} url=${url} count=${count}`);

  scrapeOnePage(url, count, sort_by)
    .then((data) => {
      jobs.set(jobId, { status: 'done', data, error: null, createdAt: jobs.get(jobId).createdAt });
      console.log(`[${new Date().toISOString()}] job=${jobId} done: ${data.stats.totalRetrieved} avis — "${data.business.name}"`);
    })
    .catch((err) => {
      jobs.set(jobId, { status: 'error', data: null, error: err.message, createdAt: jobs.get(jobId).createdAt });
      console.error(`[${new Date().toISOString()}] job=${jobId} error:`, err.message);
    });

  res.status(202).json({ jobId, status: 'pending' });
});

app.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job introuvable ou expiré' });

  if (job.status === 'pending') return res.json({ status: 'pending' });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });
  res.json({ status: 'done', success: true, data: job.data });
});

// ─── POST /scrape-batch — jusqu'à 10 URLs en parallèle ───────────────────────
//
// Body :
// {
//   "urls": [
//     { "url": "https://maps.google.com/...", "max_reviews": 20, "sort_by": "recent" },
//     { "url": "https://maps.app.goo.gl/...", "max_reviews": 10 },
//     ...
//   ],
//   "max_reviews": 20,   ← défaut global (surchargeable par item)
//   "sort_by": "recent"  ← défaut global
// }
//
// Réponse :
// {
//   "success": true,
//   "total": 3,
//   "succeeded": 2,
//   "failed": 1,
//   "results": [
//     { "index": 0, "url": "...", "success": true,  "data": { ... } },
//     { "index": 1, "url": "...", "success": false, "error": "..." },
//     ...
//   ]
// }

app.post('/scrape-batch', async (req, res) => {
  const {
    urls,
    max_reviews: globalMax = 20,
    sort_by: globalSort = 'recent',
  } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }
  if (urls.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 URLs per batch request' });
  }

  // Normalise chaque item du tableau
  const jobs = urls.map((item, index) => {
    const url      = typeof item === 'string' ? item : item.url;
    const maxRev   = Math.min(Math.max(1, parseInt(item.max_reviews ?? globalMax) || 20), 200);
    const sortBy   = item.sort_by ?? globalSort;
    return { index, url, maxRev, sortBy };
  });

  // Valide les URLs
  const invalid = jobs.filter((j) => !isValidGoogleMapsUrl(j.url));
  if (invalid.length > 0) {
    return res.status(400).json({
      error: 'Some URLs are not valid Google Maps links',
      invalidIndexes: invalid.map((j) => j.index),
    });
  }

  console.log(`[${new Date().toISOString()}] /scrape-batch  ${jobs.length} URLs en parallèle`);
  const startedAt = Date.now();

  // Lance toutes les pages en parallèle — le pool de browsers gère la concurrence
  const settled = await Promise.allSettled(
    jobs.map((job) => scrapeOnePage(job.url, job.maxRev, job.sortBy))
  );

  const results = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      console.log(
        `[${new Date().toISOString()}] batch[${i}] ✅ "${result.value.business.name}" — ${result.value.stats.totalRetrieved} avis`
      );
      return { index: i, url: jobs[i].url, success: true, data: result.value };
    } else {
      console.error(`[${new Date().toISOString()}] batch[${i}] ❌`, result.reason?.message);
      return { index: i, url: jobs[i].url, success: false, error: result.reason?.message || 'Unknown error' };
    }
  });

  const succeeded = results.filter((r) => r.success).length;
  const elapsed   = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(
    `[${new Date().toISOString()}] /scrape-batch done — ${succeeded}/${jobs.length} réussis en ${elapsed}s`
  );

  res.json({
    success: true,
    total: jobs.length,
    succeeded,
    failed: jobs.length - succeeded,
    elapsedSeconds: parseFloat(elapsed),
    results,
  });
});

// ─── GET /scrape (test rapide navigateur) ────────────────────────────────────
app.get('/scrape', async (req, res) => {
  const { url, max_reviews = 10, sort_by = 'recent' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing query param: url' });

  const count = Math.min(Math.max(1, parseInt(max_reviews) || 10), 200);
  console.log(`[${new Date().toISOString()}] GET /scrape url=${url}`);

  try {
    const data = await scrapeOnePage(url, count, sort_by);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error GET /scrape:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Pré-chauffe un premier browser au démarrage ─────────────────────────────
prewarmBrowser();

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Google Reviews Scraper API — port ${PORT}`);
  console.log(`   POST /scrape        { url, max_reviews, sort_by }`);
  console.log(`   POST /scrape-batch  { urls: [...], max_reviews, sort_by }`);
  console.log(`   GET  /health`);
  console.log(`   Pool : max ${MAX_BROWSERS} Chrome × ${MAX_TABS_PER_BROWSER} onglets (= ${MAX_BROWSERS * MAX_TABS_PER_BROWSER} en parallèle)`);
});
