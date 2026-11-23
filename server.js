const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '7275857070')
  .split(',')
  .map((id) => Number(id.trim()))
  .filter(Boolean);
const PREMIUM_PRICE_STARS = 50;

const premiumUsers = new Map();
const userWallets = new Map();

let marketListings = [
  {
    id: 'lot_1',
    username: 'slipoy',
    priceTon: 5,
    sellerId: 999001,
    sellerName: 'TonTrader',
    createdAt: Date.now() - 3600 * 1000
  }
];

const CONSONANTS = [
  'b', 'c', 'd', 'f', 'g', 'h', 'k', 'l', 'm',
  'n', 'p', 'r', 's', 't', 'v', 'w', 'x', 'z'
];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'y'];

const RARE_ROOTS = [
  'vortex', 'zenith', 'kobra', 'shadow', 'pulse', 'cyber', 'ghost', 'drift',
  'venom', 'frost', 'storm', 'titan', 'blade', 'spark', 'noble', 'prime',
  'apex', 'nova', 'aura', 'echo', 'flux', 'core', 'zero', 'onyx', 'volt',
  'zeal', 'lynx', 'hawk', 'wolf', 'crow', 'viper', 'raven', 'falcon',
  'blaze', 'ember', 'inferno', 'glitch', 'matrix', 'nexus', 'cipher', 'phantom',
  'rogue', 'sniper', 'striker', 'hunter', 'reaper', 'knight', 'baron', 'duke',
  'prince', 'king', 'legend', 'myth', 'oracle', 'prism', 'quartz', 'cobalt',
  'chrome', 'steel', 'iron', 'silver', 'gold', 'amber', 'jade', 'ruby'
];

const RARE_SET = new Set(RARE_ROOTS);

function randomInt(max) {
  return crypto.randomInt(0, max);
}

function normalizeUsername(raw = '') {
  return String(raw)
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

function isValidUsername(username) {
  return /^[a-z][a-z0-9_]{4,31}$/.test(username);
}

function buildSyllableCandidate(targetLen) {
  let result = '';
  let useConsonant = randomInt(2) === 0;

  while (result.length < targetLen) {
    const pool = useConsonant ? CONSONANTS : VOWELS;
    result += pool[randomInt(pool.length)];
    useConsonant = !useConsonant;
  }

  return result.slice(0, targetLen);
}

function generateCandidate(isRareMode = false) {
  const targetLen = 6 + randomInt(3);

  if (isRareMode) {
    const matchingRoots = RARE_ROOTS.filter((r) => r.length >= 4 && r.length <= targetLen);
    if (matchingRoots.length > 0) {
      const root = matchingRoots[randomInt(matchingRoots.length)];
      const remaining = targetLen - root.length;
      if (remaining === 0) {
        return { username: root, hasRareRoot: true };
      }
      const suffix = buildSyllableCandidate(remaining);
      return { username: `${root}${suffix}`, hasRareRoot: true };
    }
  }

  const candidate = buildSyllableCandidate(targetLen);
  const hasRareRoot = RARE_ROOTS.some((root) => candidate.includes(root)) || RARE_SET.has(candidate);
  return { username: candidate, hasRareRoot };
}

function classifyBadge(username, status) {
  if (status === 'fragment_auction' || status === 'fragment_taken') {
    return { code: 'fragment', label: 'Fragment', isPremiumLabel: false };
  }
  if (status !== 'available') {
    return { code: 'taken', label: 'Занят', isPremiumLabel: false };
  }
  const isRare = RARE_ROOTS.some((root) => username.includes(root)) || username.length <= 6;
  if (isRare) {
    return { code: 'rare_premium', label: '1 редкий (премиум)', isPremiumLabel: true };
  }
  return { code: 'available', label: 'Свободен', isPremiumLabel: false };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkBotApi(username) {
  if (!BOT_TOKEN) {
    return { checked: false, taken: false, reason: 'no_bot_token' };
  }
  try {
    const res = await fetchWithTimeout(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=@${encodeURIComponent(username)}`
    );
    const data = await res.json();
    if (data && data.ok) {
      return { checked: true, taken: true, source: 'bot_api' };
    }
    const desc = String(data?.description || '').toLowerCase();
    if (desc.includes('chat not found') || desc.includes('username not occupied')) {
      return { checked: true, taken: false, source: 'bot_api' };
    }
    return { checked: true, taken: false, source: 'bot_api_inconclusive', detail: desc };
  } catch (err) {
    return { checked: false, taken: false, source: 'bot_api_error', error: err.message };
  }
}

async function checkPublicTMe(username) {
  try {
    const res = await fetchWithTimeout(`https://t.me/${encodeURIComponent(username)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UsernameChecker/1.0)' }
    });
    const html = await res.text();
    const hasProfileTitle =
      html.includes('tgme_page_title') &&
      !html.includes('If you have <strong>Telegram</strong>, you can contact');
    const hasChannelOrBotPreview =
      html.includes('tgme_page_extra') ||
      html.includes('tgme_action_button_new') ||
      html.includes('tgme_page_description');

    if (hasProfileTitle || hasChannelOrBotPreview) {
      return { checked: true, taken: true, source: 't_me' };
    }
    return { checked: true, taken: false, source: 't_me' };
  } catch (err) {
    return { checked: false, taken: false, source: 't_me_error', error: err.message };
  }
}

async function checkFragment(username) {
  try {
    const res = await fetchWithTimeout(`https://fragment.com/username/${encodeURIComponent(username)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const lower = html.toLowerCase();

    const isTakenOrAuction =
      lower.includes('on auction') ||
      lower.includes('sold') ||
      lower.includes('unavailable') ||
      lower.includes('taken') ||
      lower.includes('place a bid');

    const isAvailableOnFragment =
      lower.includes('available') ||
      lower.includes('not for sale') ||
      lower.includes('username is available');

    return {
      checked: true,
      taken: isTakenOrAuction && !isAvailableOnFragment,
      isAuction: lower.includes('on auction') || lower.includes('place a bid'),
      source: 'fragment'
    };
  } catch (err) {
    return { checked: false, taken: false, source: 'fragment_error', error: err.message };
  }
}

async function tripleCheckUsername(rawUsername) {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) {
    return {
      ok: false,
      username,
      status: 'invalid',
      message: 'Некорректный формат юзернейма (нужно 5-32 символа: латиница, цифры, _)'
    };
  }

  const [botRes, tmeRes, fragRes] = await Promise.all([
    checkBotApi(username),
    checkPublicTMe(username),
    checkFragment(username)
  ]);

  let status = 'available';
  if (fragRes.isAuction) status = 'fragment_auction';
  else if (botRes.taken || tmeRes.taken) status = 'taken';
  else if (fragRes.taken) status = 'fragment_taken';

  const badge = classifyBadge(username, status);

  return {
    ok: true,
    username,
    length: username.length,
    available: status === 'available',
    status,
    badge,
    checks: { botApi: botRes, tMe: tmeRes, fragment: fragRes }
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/check', async (req, res) => {
  const result = await tripleCheckUsername(req.query.username || '');
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/generate', async (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 6, 1), 20);
  const onlyAvailable = req.query.onlyAvailable !== 'false';
  const rareMode = req.query.rare === 'true';

  const found = [];
  const seen = new Set();
  const maxAttempts = count * 8;

  for (let i = 0; i < maxAttempts && found.length < count; i++) {
    const { username } = generateCandidate(rareMode);
    if (seen.has(username)) continue;
    seen.add(username);

    const checked = await tripleCheckUsername(username);
    if (!checked.ok) continue;
    if (onlyAvailable && !checked.available) continue;
    found.push(checked);
  }

  res.json({ ok: true, count: found.length, items: found });
});

app.get('/api/market', (req, res) => {
  res.json({ ok: true, listings: marketListings });
});

app.post('/api/market', (req, res) => {
  const username = normalizeUsername(req.body?.username || '');
  const priceTon = Number(req.body?.priceTon);
  const sellerId = Number(req.body?.sellerId) || 100001;
  const sellerName = String(req.body?.sellerName || 'Seller').slice(0, 40);

  if (!isValidUsername(username) || !Number.isFinite(priceTon) || priceTon <= 0) {
    return res.status(400).json({ ok: false, error: 'Неверные данные лота' });
  }

  const listing = {
    id: `lot_${Date.now()}`,
    username,
    priceTon,
    sellerId,
    sellerName,
    createdAt: Date.now()
  };

  marketListings.unshift(listing);
  res.json({ ok: true, listing });
});

app.post('/api/wallet', (req, res) => {
  const userId = String(req.body?.userId || 'guest');
  const address = String(req.body?.address || '').trim();
  if (!address) {
    return res.status(400).json({ ok: false, error: 'Укажите адрес кошелька' });
  }
  userWallets.set(userId, address);
  res.json({ ok: true, userId, address });
});

app.post('/api/premium/activate', (req, res) => {
  const userId = Number(req.body?.userId);
  const invoicePayload = String(req.body?.payload || '');
  if (!userId) {
    return res.status(400).json({ ok: false, error: 'Не указан userId' });
  }

  premiumUsers.set(userId, {
    active: true,
    stars: PREMIUM_PRICE_STARS,
    payload: invoicePayload,
    activatedAt: Date.now()
  });

  res.json({
    ok: true,
    userId,
    isAdmin: ADMIN_IDS.includes(userId),
    premium: premiumUsers.get(userId)
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
  
