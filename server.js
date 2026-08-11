import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeMarket, analyzeSpotRegime, normalizeTimeframe, parseTimeframeMs, maxHoldMsForTimeframe, regimeTimeframeForTrade, recommendedTargetForTimeframe, STRATEGY_PROFILES } from './strategy-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));
app.get('/backtest.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'backtest.html')));
app.get('/backtest', (_, res) => res.sendFile(path.join(__dirname, 'public', 'backtest.html')));

const LIVE_EXCHANGE_TIMEOUT_MS = Number(process.env.LIVE_EXCHANGE_TIMEOUT_MS || 20_000);
const exchanges = {
  binance: new ccxt.pro.binance({ enableRateLimit: true, timeout: LIVE_EXCHANGE_TIMEOUT_MS }),
  gateio: new ccxt.pro.gate({ enableRateLimit: true, timeout: LIVE_EXCHANGE_TIMEOUT_MS }),
  bybit: new ccxt.pro.bybit({ enableRateLimit: true, timeout: LIVE_EXCHANGE_TIMEOUT_MS }),
  okx: new ccxt.pro.okx({ enableRateLimit: true, timeout: LIVE_EXCHANGE_TIMEOUT_MS })
};
const exchangeNames = Object.keys(exchanges);

// Dedicated REST client for historical research. Keeping it separate from the live
// scanner prevents long backtests from starving live ticker/arbitrage requests.
const historicalBinance = new ccxt.binance({
  enableRateLimit: true,
  timeout: Number(process.env.BINANCE_HISTORICAL_TIMEOUT_MS || 30_000)
});

// Global historical-request scheduler. Every screener/backtest uses this same queue,
// so clicking multiple research actions cannot create hundreds of simultaneous klines calls.
const HISTORICAL_MAX_CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.HISTORICAL_CONCURRENCY || 3)));
const HISTORICAL_MIN_GAP_MS = Math.max(50, Number(process.env.HISTORICAL_MIN_GAP_MS || 90));
let historicalActiveRequests = 0;
let historicalNextStartAt = 0;
const historicalRequestQueue = [];

function pumpHistoricalRequestQueue() {
  while (historicalActiveRequests < HISTORICAL_MAX_CONCURRENCY && historicalRequestQueue.length) {
    const task = historicalRequestQueue.shift();
    const now = Date.now();
    const startAt = Math.max(now, historicalNextStartAt);
    historicalNextStartAt = startAt + HISTORICAL_MIN_GAP_MS;
    historicalActiveRequests++;
    setTimeout(async () => {
      try { task.resolve(await task.fn()); }
      catch (error) { task.reject(error); }
      finally {
        historicalActiveRequests--;
        pumpHistoricalRequestQueue();
      }
    }, Math.max(0, startAt - now));
  }
}

function scheduleHistoricalRequest(fn) {
  return new Promise((resolve, reject) => {
    historicalRequestQueue.push({ fn, resolve, reject });
    pumpHistoricalRequestQueue();
  });
}

// User-defined exclusions: these bases are never admitted to the trading universe.
// This list includes the user's provided "غير مباح" assets plus the previous explicit exclusions.
const USER_EXCLUDED_BASES = new Set([
  'BNB','DAI','SHIB','UNI','CRO','OKB','PAXG','AAVE','PEPE','BGB','KCS','ENA','JST','GT','CAKE','NEXO',
  'INJ','ETHFI','CRV','SUN','LUNC','LDO','PENDLE','BONK','FLOKI','DEXE','RAY','COMP','CVX','MX','RUNE','NEO',
  '1INCH','GOMINING','DYDX','CFG','YFI','SNX','ZRX','GMX','FTT','NMR','VBUSD','TURBO','SUSHI','PEOPLE','XVS',
  'KAVA','T','AMPL','CTC',
  // previous explicit exclusions
  'XMR','FUN','KAS','OMG','WAVES','BTS','SNT','ACX','HFT','PIVX','PYR','VANRY','VIC','COS','D','HIGH','MBOX',
  'SLERF','ALPHA','BADGER','OAS','MLN','AIDOGE','DASH','ZEC','ZEN','WBTC','WEETH'
]);

// Technical safety exclusions only. These are NOT additional religious rulings.
// They remove cash-like bases and obvious leveraged/synthetic wrappers that can distort a spot strategy.
const TECHNICAL_EXCLUDED_BASES = new Set([
  'USDC','FDUSD','TUSD','BUSD','USDE','PYUSD','USDD','USDP','GUSD','USDS','RLUSD','USD1','USDG',
  'EUR','GBP','TRY','BRL','AUD','JPY','CHF'
]);

const LEVERAGED_TOKEN_RE = /(?:BULL|BEAR|[235]L|[235]S)$/i;
const KNOWN_LEVERAGED_BASES = new Set(['BTCUP','BTCDOWN','ETHUP','ETHDOWN','BNBUP','BNBDOWN','XRPUP','XRPDOWN','ADAUP','ADADOWN','LINKUP','LINKDOWN','DOTUP','DOTDOWN','TRXUP','TRXDOWN']);
const TOKENIZED_EQUITY_RE = /(?:AAPL|AMZN|GOOGL|META|MSFT|NVDA|TSLA|COIN|HOOD|MSTR)X$/i;

function isEligibleSpotUsdtMarket(symbol, market) {
  if (!market || market.spot !== true || market.active === false) return false;
  if (market.contract || market.future || market.swap || market.option) return false;
  if (market.quote !== 'USDT' || !symbol.endsWith('/USDT')) return false;
  if (symbol.includes(':')) return false;

  const base = String(market.base || symbol.split('/')[0] || '').toUpperCase();
  if (!base) return false;
  if (USER_EXCLUDED_BASES.has(base) || TECHNICAL_EXCLUDED_BASES.has(base)) return false;
  if (KNOWN_LEVERAGED_BASES.has(base) || LEVERAGED_TOKEN_RE.test(base) || TOKENIZED_EQUITY_RE.test(base)) return false;
  return true;
}

// Arbitrage identity verification -------------------------------------------------
// A ticker symbol by itself is NOT considered proof that two exchanges list the
// same underlying asset. Some exchanges reuse the same symbol for unrelated coins.
// We therefore compare CCXT currency metadata before a cross-exchange route is allowed.
function normalizeIdentityText(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeNetworkCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getCurrencyForMarket(exchange, market) {
  if (!exchange || !market) return null;
  return exchange.currencies?.[market.base] || exchange.currencies?.[String(market.base || '').toUpperCase()] || null;
}

function currencyIdentityMeta(exchangeName, symbol) {
  const exchange = exchanges[exchangeName];
  const market = exchange?.markets?.[symbol];
  const currency = getCurrencyForMarket(exchange, market);
  if (!market || !currency) return null;

  const names = new Set([
    normalizeIdentityText(currency.name),
    normalizeIdentityText(currency.info?.name),
    normalizeIdentityText(currency.info?.fullName),
    normalizeIdentityText(currency.info?.coinName)
  ].filter(Boolean));

  const contracts = new Set();
  const networks = new Set();
  const networkDetails = currency.networks && typeof currency.networks === 'object' ? currency.networks : {};

  const addContract = (contract, network) => {
    const c = String(contract || '').trim().toLowerCase();
    if (!c || c === 'null' || c === 'undefined') return;
    const n = normalizeNetworkCode(network);
    contracts.add(c);
    if (n) contracts.add(`${n}:${c}`);
  };

  addContract(currency.contract, currency.network);
  addContract(currency.info?.contractAddress, currency.info?.network);

  for (const [key, net] of Object.entries(networkDetails)) {
    const code = normalizeNetworkCode(net?.network || net?.code || net?.id || key);
    if (code) networks.add(code);
    addContract(net?.contract, code || key);
    addContract(net?.info?.contractAddress, code || key);
  }

  return {
    exchange: exchangeName,
    symbol,
    base: String(market.base || '').toUpperCase(),
    baseId: String(market.baseId || ''),
    currencyId: String(currency.id || ''),
    names: [...names],
    contracts: [...contracts],
    networks: [...networks]
  };
}

function verifyAssetIdentity(symbol, exchangeA, exchangeB) {
  const a = currencyIdentityMeta(exchangeA, symbol);
  const b = currencyIdentityMeta(exchangeB, symbol);
  if (!a || !b || !a.base || a.base !== b.base) {
    return { verified: false, reason: 'missing-or-mismatched-currency-metadata' };
  }

  const aContracts = new Set(a.contracts);
  const sharedContracts = b.contracts.filter(c => aContracts.has(c));
  if (sharedContracts.length) {
    return {
      verified: true,
      level: 'strong',
      method: 'shared-contract',
      reason: 'Matching contract address in exchange currency metadata',
      sharedContracts: sharedContracts.slice(0, 3)
    };
  }

  const aNames = new Set(a.names);
  const sharedNames = b.names.filter(n => n && aNames.has(n));
  const aNetworks = new Set(a.networks);
  const sharedNetworks = b.networks.filter(n => aNetworks.has(n));

  // Exact normalized project-name agreement is our conservative fallback for
  // native coins and assets whose exchanges do not expose contract addresses.
  if (sharedNames.length) {
    return {
      verified: true,
      level: sharedNetworks.length ? 'strong' : 'standard',
      method: sharedNetworks.length ? 'matching-name-and-network' : 'matching-project-name',
      reason: sharedNetworks.length
        ? 'Matching project name and at least one network'
        : 'Matching exact project name; no shared contract metadata exposed',
      sharedNames: sharedNames.slice(0, 2),
      sharedNetworks: sharedNetworks.slice(0, 5)
    };
  }

  return {
    verified: false,
    reason: 'symbol-collision-or-unverifiable-identity',
    a: { exchange: exchangeA, names: a.names, networks: a.networks },
    b: { exchange: exchangeB, names: b.names, networks: b.networks }
  };
}


function conservativeIdentityFallback(symbol, exchangeA, exchangeB, identity, buyQuote, sellQuote) {
  // This fallback exists because some venues (notably Binance public spot metadata)
  // do not expose contract/name metadata without authenticated funding endpoints.
  // It NEVER overrides an explicit metadata conflict and it applies a tight live
  // price-sanity check before a route may be displayed.
  const exA = exchanges[exchangeA];
  const exB = exchanges[exchangeB];
  const marketA = exA?.markets?.[symbol];
  const marketB = exB?.markets?.[symbol];
  if (!marketA || !marketB) return { allowed: false, reason: 'missing-market-metadata' };
  if (!isEligibleSpotUsdtMarket(symbol, marketA) || !isEligibleSpotUsdtMarket(symbol, marketB)) {
    return { allowed: false, reason: 'not-matching-eligible-spot-markets' };
  }

  const baseA = String(marketA.base || '').toUpperCase();
  const baseB = String(marketB.base || '').toUpperCase();
  if (!baseA || baseA !== baseB) return { allowed: false, reason: 'base-code-mismatch' };

  const metaA = currencyIdentityMeta(exchangeA, symbol);
  const metaB = currencyIdentityMeta(exchangeB, symbol);

  // If both venues expose project names and they disagree, do NOT guess.
  if (metaA?.names?.length && metaB?.names?.length) {
    const setA = new Set(metaA.names);
    const shared = metaB.names.filter(n => setA.has(n));
    if (!shared.length) return { allowed: false, reason: 'conflicting-project-names' };
  }

  const ask = Number(buyQuote?.ask);
  const bid = Number(sellQuote?.bid);
  if (!(ask > 0) || !(bid > 0)) return { allowed: false, reason: 'missing-live-prices' };
  const gapPct = Math.abs((bid - ask) / ask) * 100;
  if (gapPct > ARB_FALLBACK_MAX_PRICE_GAP_PCT) {
    return { allowed: false, reason: `price-sanity-gap-${gapPct.toFixed(2)}pct` };
  }

  return {
    allowed: true,
    level: 'fallback',
    method: 'same-spot-symbol-plus-price-sanity',
    reason: `Same eligible ${baseA}/USDT spot market and live prices within ${ARB_FALLBACK_MAX_PRICE_GAP_PCT.toFixed(1)}%; contract/name proof unavailable`,
    gapPct
  };
}

// Full dynamic universe assembled from all configured exchanges at startup.
let allEligiblePairs = [];       // union across Binance / Bybit / OKX / Gate
let binanceSignalPairs = [];     // eligible pairs Binance can provide candles for
let arbitragePairs = [];         // common eligible pairs listed on at least two exchanges (quote candidates)
let strictlyVerifiedArbitragePairs = []; // pairs with at least one strong metadata-verified route
let pairVenues = {};             // pair -> exchanges where it exists
let pairIdentityMatrix = {};     // pair -> verified exchange-pair identity checks
let identityRejectedPairs = {};  // diagnostics for symbol collisions / unverifiable pairs
let binanceVolumeRankedPairs = []; // eligible Binance pairs ranked by recent USDT quote volume
let binanceVolumeRankedAt = 0;

const globalTickersCache = Object.fromEntries(exchangeNames.map(n => [n, {}]));
const signalCache = new Map();
const signalInflight = new Map();
const signalScanCursor = new Map();
let quoteScanCursor = 0;
const STATE_FILE = path.join(__dirname, 'wallet_state.json');
const SIGNAL_CACHE_TTL_MS = 12_000;
const liveBenchmarkCache = new Map();
const LIVE_BENCHMARK_TTL_MS = 60_000;
const LIVE_SIGNAL_BATCH_SIZE = 70;
const ARB_QUOTE_BATCH_SIZE = 80;
const ARB_FETCH_CHUNK_SIZE = 20;
const TAKER_FEE_RATE = 0.001;
const QUOTE_STALE_MS = 45_000;
const ARB_IDENTITY_MODE = String(process.env.ARB_IDENTITY_MODE || 'safe').toLowerCase(); // 'safe' or 'strict'
const ARB_FALLBACK_MAX_PRICE_GAP_PCT = 2.0; // sanity guard for routes without contract/name proof

let arbitrageQuoteStats = {
  lastRefreshAt: 0,
  lastRefreshMs: 0,
  scannedSymbols: 0,
  venues: Object.fromEntries(exchangeNames.map(name => [name, { requested: 0, received: 0, errors: 0, lastError: null }]))
};

let persistentWalletState = {
  manualWallet: { cashBalance: 1000, startingCapital: 1000, tradeCount: 0, openPositions: [], closedHistory: [] },
  autoWallet: { cashBalance: 1000, startingCapital: 1000, tradeCount: 0, openPositions: [], closedHistory: [] }
};

if (fs.existsSync(STATE_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (parsed?.manualWallet && parsed?.autoWallet) persistentWalletState = parsed;
  } catch (e) {
    console.warn('Wallet state could not be loaded:', e.message);
  }
}

function saveWalletState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(persistentWalletState, null, 2)); }
  catch (e) { console.warn('Wallet state could not be saved:', e.message); }
}


async function refreshBinanceVolumeRanking(force = false) {
  const now = Date.now();
  if (!force && binanceVolumeRankedPairs.length && now - binanceVolumeRankedAt < 5 * 60_000) {
    return binanceVolumeRankedPairs;
  }
  try {
    const tickers = await exchanges.binance.fetchTickers(binanceSignalPairs);
    binanceVolumeRankedPairs = [...binanceSignalPairs].sort((a, b) => {
      const av = Number(tickers?.[a]?.quoteVolume || 0);
      const bv = Number(tickers?.[b]?.quoteVolume || 0);
      return bv - av || a.localeCompare(b);
    });
    binanceVolumeRankedAt = now;
  } catch (e) {
    if (!binanceVolumeRankedPairs.length) binanceVolumeRankedPairs = [...binanceSignalPairs];
    console.warn(`Binance volume ranking: ${e.message}`);
  }
  return binanceVolumeRankedPairs;
}

function withTimeout(promise, ms, label = 'request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sanitizeWalletState(input) {
  const normalizeWallet = (w = {}) => ({
    cashBalance: Number.isFinite(Number(w.cashBalance)) ? Number(w.cashBalance) : 1000,
    startingCapital: Number.isFinite(Number(w.startingCapital)) ? Number(w.startingCapital) : 1000,
    tradeCount: Math.max(0, Number.parseInt(w.tradeCount || 0, 10)),
    openPositions: Array.isArray(w.openPositions) ? w.openPositions.slice(0, 500) : [],
    closedHistory: Array.isArray(w.closedHistory) ? w.closedHistory.slice(0, 10_000) : []
  });
  return {
    manualWallet: normalizeWallet(input?.manualWallet),
    autoWallet: normalizeWallet(input?.autoWallet)
  };
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('en-GB', { hour12: false });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function targetsAtEntry(entryPrice, analysis, targetLevel = 'TP2') {
  const atr = analysis?.atr || entryPrice * 0.01;
  const feeBufferPct = 0.0025;
  const tp1 = entryPrice + Math.max(1.0 * atr, entryPrice * feeBufferPct);
  const tp2 = entryPrice + Math.max(2.0 * atr, entryPrice * (feeBufferPct + 0.002));
  const tp3 = entryPrice + Math.max(3.5 * atr, entryPrice * (feeBufferPct + 0.005));
  const stop = entryPrice - 1.5 * atr;
  return { stop, tp1, tp2, tp3, chosen: targetLevel === 'TP1' ? tp1 : targetLevel === 'TP3' ? tp3 : tp2 };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isRetryableMarketDataError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out') || msg.includes('network') ||
    msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit') ||
    msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('econnreset');
}

async function fetchOhlcvPageWithRetry(exchange, symbol, tf, since, limit, attempts = 4) {
  let lastError;
  const isBinance = String(exchange?.id || '').toLowerCase() === 'binance';
  const client = isBinance ? historicalBinance : exchange;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const request = () => client.fetchOHLCV(symbol, tf, since, limit);
      return isBinance ? await scheduleHistoricalRequest(request) : await request();
    } catch (e) {
      lastError = e;
      if (!isRetryableMarketDataError(e) || attempt === attempts) break;
      // Backoff is intentionally longer for full-universe research so retries do not
      // synchronize into another burst after Binance/network congestion.
      const delay = 1_000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 750);
      console.warn(`[OHLCV retry ${attempt}/${attempts}] ${symbol} ${tf} @ ${since}: ${e.message}`);
      await sleep(delay);
    }
  }
  throw new Error(`${symbol} historical data failed after ${attempts} attempts: ${lastError?.message || lastError}`);
}

async function fetchHistoricalRange(exchange, symbol, tf, startMs, endMs = Date.now(), warmupCandles = Number(process.env.RESEARCH_WARMUP_CANDLES || 120), maxCandles = null) {
  const tfMs = parseTimeframeMs(tf);
  const requiredCandles = Math.ceil((endMs - startMs) / tfMs) + warmupCandles + 20;
  const hardLimit = Math.max(requiredCandles, Number(maxCandles) || 0);
  let cursor = Math.max(0, startMs - warmupCandles * tfMs);
  const out = [];

  // Smaller pages are slower than one huge request, but materially reduce Binance timeout failures
  // during long multi-coin research runs. Retries make transient failures non-destructive.
  const pageSize = Math.max(200, Math.min(1000, Number(process.env.HISTORICAL_PAGE_SIZE || 1000)));
  while (cursor <= endMs && out.length < hardLimit) {
    const limit = Math.min(pageSize, hardLimit - out.length);
    const page = await fetchOhlcvPageWithRetry(exchange, symbol, tf, cursor, limit, 4);
    if (!page?.length) break;
    for (const c of page) {
      if ((!out.length || c[0] > out[out.length - 1][0]) && c[0] <= endMs + tfMs) out.push(c);
    }
    const lastTs = page[page.length - 1][0];
    if (lastTs >= endMs || page.length < limit) break;
    const next = lastTs + tfMs;
    if (next <= cursor) break;
    cursor = next;
    // A tiny pause prevents long research jobs from becoming bursty at Binance.
    // Global scheduler already spaces Binance requests; no extra per-page sleep is needed here.
  }
  return out.filter(c => c[0] <= endMs + tfMs);
}

function findTradeStartIndex(ohlcv, startMs) {
  const idx = ohlcv.findIndex(c => c[0] >= startMs);
  return idx < 60 ? 60 : idx;
}


function resolveTargetLevel(requested, tf) {
  return requested === 'AUTO' ? recommendedTargetForTimeframe(tf) : (requested || recommendedTargetForTimeframe(tf));
}

function regimeAtTimestamp(regimeCandles, timestampMs, cache = new Map(), regimeTf = '4h') {
  if (!Array.isArray(regimeCandles) || !regimeCandles.length) return analyzeSpotRegime([]);
  const regimeTfMs = parseTimeframeMs(regimeTf);
  let lo = 0, hi = regimeCandles.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (regimeCandles[mid][0] + regimeTfMs <= timestampMs) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0) return analyzeSpotRegime([]);
  const bucket = regimeCandles[idx][0];
  if (cache.has(bucket)) return cache.get(bucket);
  const regime = analyzeSpotRegime(regimeCandles.slice(Math.max(0, idx - 260), idx + 1));
  cache.set(bucket, regime);
  return regime;
}

async function fetchBenchmarkRange(tf, startMs, endMs) {
  const regimeTf = regimeTimeframeForTrade(tf);
  const candles = await fetchHistoricalRange(exchanges.binance, 'BTC/USDT', regimeTf, startMs, endMs, 280, 5000);
  return { timeframe: regimeTf, candles };
}

async function runBacktest({ symbolPair, tf, startMs, endMs = Date.now(), initialCapital, targetLevel = 'AUTO', forceManualEntry = false, strategyProfile = STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT, benchmarkCandles = [], benchmarkTimeframe = null }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Historical end time must be after the start time.');
  }
  const ohlcv = await fetchHistoricalRange(exchanges.binance, symbolPair, tf, startMs, endMs);
  if (!ohlcv || ohlcv.length < 61) throw new Error('Not enough historical candle data for this start point.');

  const startIndex = findTradeStartIndex(ohlcv, startMs);
  if (startIndex >= ohlcv.length) throw new Error('No candles available after the requested start time.');

  const maxHoldMs = maxHoldMsForTimeframe(tf);
  const closedDeals = [];
  const regimeCache = new Map();
  let currentCash = initialCapital;
  let active = null;
  let cooldownUntilIndex = -1;
  let firstEntryDone = false;

  for (let i = startIndex; i < ohlcv.length; i++) {
    const candle = ohlcv[i];
    const [candleTimeMs, openPrice, highPrice, lowPrice, closePrice] = candle;
    if (candleTimeMs > endMs) break;

    if (active) {
      const durationMs = candleTimeMs - active.entryTimestamp;
      const regimeNow = [STRATEGY_PROFILES.V4_REGIME_SPOT, STRATEGY_PROFILES.RESEARCH_SPOT, STRATEGY_PROFILES.PULLBACK_SPOT, STRATEGY_PROFILES.TREND_PULLBACK_SPOT, STRATEGY_PROFILES.EXHAUSTION_SCALP_SPOT, STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT, STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT].includes(strategyProfile)
        ? regimeAtTimestamp(benchmarkCandles, candleTimeMs, regimeCache, benchmarkTimeframe || regimeTimeframeForTrade(tf))
        : { label: 'BASELINE', allowLong: true };
      const regimeExit = strategyProfile === STRATEGY_PROFILES.V4_REGIME_SPOT && ['WEAK_BEAR', 'BEAR'].includes(regimeNow.label);
      const hitStop = lowPrice <= active.targetLow;
      const hitTp = highPrice >= active.targetHigh;
      let exitReason = null, exitPrice = null;

      // Regime is known from fully closed benchmark candles before this candle, so a spot exit can occur at the new candle open.
      if (regimeExit) { exitReason = `💵 BTC REGIME CASH EXIT (${regimeNow.label})`; exitPrice = Number(openPrice) || Number(closePrice); }
      else {
        active.minPriceExcursion = Math.min(active.minPriceExcursion, lowPrice);
        // Conservative OHLC rule: if both could have happened in the same candle, assume the stop was hit first.
        if (hitStop) { exitReason = hitTp ? '🛑 STOP LOSS (TP/SL SAME CANDLE — CONSERVATIVE)' : '🛑 STOP LOSS HIT'; exitPrice = active.targetLow; }
        else if (hitTp) { exitReason = `🎯 TAKE PROFIT HIT (${active.targetLevel})`; exitPrice = active.targetHigh; }
        else if (durationMs >= maxHoldMs) { exitReason = '⏰ ADAPTIVE MAX HOLD EXIT'; exitPrice = closePrice; }
      }

      if (exitReason) {
        const grossExitUSD = active.tokens * exitPrice;
        const sellFeeUSD = grossExitUSD * TAKER_FEE_RATE;
        const netExitUSD = grossExitUSD - sellFeeUSD;
        const totalFeesUSD = active.buyFeeUSD + sellFeeUSD;
        const netProfitUSD = netExitUSD - active.costBasis;
        const maxDrawdownPct = ((active.entryPrice - active.minPriceExcursion) / active.entryPrice) * 100;
        closedDeals.push({
          id: `#${closedDeals.length + 1}`,
          timeframe: tf,
          pair: symbolPair,
          entryTime: formatTime(active.entryTimestamp),
          closedTime: formatTime(candleTimeMs),
          exitTime: formatTime(candleTimeMs),
          entryPrice: active.entryPrice,
          buyAsk: active.entryPrice,
          lowestPriceDip: active.minPriceExcursion,
          maxDrawdownPct: maxDrawdownPct.toFixed(2),
          exitPrice,
          targetTpPrice: active.targetHigh,
          stopLossPrice: active.targetLow,
          outSignal: exitReason,
          exitReason,
          inSignal: active.inSignal,
          strategyProfile: active.strategyProfile,
          targetLevel: active.targetLevel,
          benchmarkTimeframe: active.benchmarkTimeframe,
          snapshot: active.snapshot,
          tradeAmount: active.costBasis,
          totalFeesUSD,
          fees: totalFeesUSD,
          netProfitUSD,
          holdHours: (durationMs / 3_600_000).toFixed(2)
        });
        currentCash = netExitUSD;
        active = null;
        cooldownUntilIndex = i + 3;
      }
    }

    if (active || i <= cooldownUntilIndex || i < 60) continue;

    // Signal uses only candles that were fully closed before this candle. Entry occurs at this candle's open.
    const regime = [STRATEGY_PROFILES.V4_REGIME_SPOT, STRATEGY_PROFILES.RESEARCH_SPOT, STRATEGY_PROFILES.PULLBACK_SPOT, STRATEGY_PROFILES.TREND_PULLBACK_SPOT, STRATEGY_PROFILES.EXHAUSTION_SCALP_SPOT, STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT, STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT].includes(strategyProfile)
      ? regimeAtTimestamp(benchmarkCandles, candleTimeMs, regimeCache, benchmarkTimeframe || regimeTimeframeForTrade(tf))
      : { label: 'BASELINE', score: 0, allowLong: true, strongLong: true };
    const analysis = analyzeMarket(ohlcv.slice(0, i), { minCandles: 60, timeframe: tf, profile: strategyProfile, regime });
    if (!analysis) continue;

    let entryReason = null;
    if (forceManualEntry && !firstEntryDone && candleTimeMs >= startMs) entryReason = 'Manual Historical Spot Entry';
    else if (analysis.isBuySignal) {
      const prefix = strategyProfile === STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT ? (analysis.edgeSetupType || 'TIMEFRAME EDGE') : [STRATEGY_PROFILES.PULLBACK_SPOT, STRATEGY_PROFILES.TREND_PULLBACK_SPOT].includes(strategyProfile) ? 'TREND PULLBACK' : strategyProfile === STRATEGY_PROFILES.EXHAUSTION_SCALP_SPOT ? 'EXHAUSTION' : strategyProfile === STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT ? 'MOMENTUM BREAKOUT' : strategyProfile.replace('_SPOT','');
      entryReason = analysis.isStrongBuy ? `${prefix} STRONG BUY Spot Entry` : `${prefix} BUY Spot Entry`;
    }
    if (!entryReason) continue;

    firstEntryDone = true;
    const entryPrice = Number(openPrice) || Number(closePrice);
    const actualTargetLevel = resolveTargetLevel(targetLevel, tf);
    const t = targetsAtEntry(entryPrice, analysis, actualTargetLevel);
    const buyFeeUSD = currentCash * TAKER_FEE_RATE;
    const effectiveCapital = currentCash - buyFeeUSD;
    const tokens = effectiveCapital / entryPrice;
    active = {
      entryTimestamp: candleTimeMs,
      entryPrice,
      minPriceExcursion: entryPrice,
      tokens,
      buyFeeUSD,
      costBasis: currentCash,
      targetHigh: t.chosen,
      targetLow: t.stop,
      targetLevel: actualTargetLevel,
      inSignal: entryReason,
      strategyProfile,
      benchmarkTimeframe,
      snapshot: analysis.snapshot
    };
  }

  // Close any position that is still open at the end of the requested test interval.
  // This keeps the result self-contained instead of leaking P/L beyond endMs.
  if (active) {
    const lastCandle = [...ohlcv].reverse().find(c => c[0] <= endMs) || ohlcv.at(-1);
    const exitTs = Math.min(lastCandle[0], endMs);
    const exitPrice = Number(lastCandle[4]);
    const grossExitUSD = active.tokens * exitPrice;
    const sellFeeUSD = grossExitUSD * TAKER_FEE_RATE;
    const netExitUSD = grossExitUSD - sellFeeUSD;
    const totalFeesUSD = active.buyFeeUSD + sellFeeUSD;
    const netProfitUSD = netExitUSD - active.costBasis;
    const maxDrawdownPct = ((active.entryPrice - active.minPriceExcursion) / active.entryPrice) * 100;
    const durationMs = Math.max(0, exitTs - active.entryTimestamp);
    closedDeals.push({
      id: `#${closedDeals.length + 1}`,
      timeframe: tf,
      pair: symbolPair,
      entryTime: formatTime(active.entryTimestamp),
      closedTime: formatTime(exitTs),
      exitTime: formatTime(exitTs),
      entryPrice: active.entryPrice,
      buyAsk: active.entryPrice,
      lowestPriceDip: active.minPriceExcursion,
      maxDrawdownPct: maxDrawdownPct.toFixed(2),
      exitPrice,
      targetTpPrice: active.targetHigh,
      stopLossPrice: active.targetLow,
      outSignal: '🏁 END OF TEST INTERVAL',
      exitReason: '🏁 END OF TEST INTERVAL',
      inSignal: active.inSignal,
      strategyProfile: active.strategyProfile,
      targetLevel: active.targetLevel,
      benchmarkTimeframe: active.benchmarkTimeframe,
      snapshot: active.snapshot,
      tradeAmount: active.costBasis,
      totalFeesUSD,
      fees: totalFeesUSD,
      netProfitUSD,
      holdHours: (durationMs / 3_600_000).toFixed(2)
    });
    currentCash = netExitUSD;
    active = null;
  }

  return {
    pair: symbolPair,
    timeframe: tf,
    strategyProfile,
    requestedTargetLevel: targetLevel,
    effectiveTargetLevel: resolveTargetLevel(targetLevel, tf),
    benchmarkTimeframe,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    totalCandlesScanned: Math.max(0, ohlcv.filter(c => c[0] >= startMs && c[0] <= endMs).length),
    finalBalance: currentCash,
    totalPnl: currentCash - initialCapital,
    closedDeals,
    hasOpenPosition: false
  };
}

async function getSignalData(timeframe, force = false, strategyProfile = STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT) {
  const tf = normalizeTimeframe(timeframe);
  const profile = Object.values(STRATEGY_PROFILES).includes(strategyProfile) ? strategyProfile : STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
  const cacheKey = `${tf}|${profile}`;
  const cached = signalCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < SIGNAL_CACHE_TTL_MS) return cached.data;
  if (signalInflight.has(cacheKey)) return signalInflight.get(cacheKey);

  const promise = (async () => {
    const previous = signalCache.get(cacheKey)?.data || {};
    const result = { ...previous };
    const universe = binanceSignalPairs;
    if (!universe.length) return result;

    const regimeTf = regimeTimeframeForTrade(tf);
    let liveRegime = { label: 'UNKNOWN', score: 0, allowLong: false, strongLong: false, reason: 'Benchmark unavailable' };
    const cachedBenchmark = liveBenchmarkCache.get(regimeTf);
    if (cachedBenchmark && Date.now() - cachedBenchmark.ts < LIVE_BENCHMARK_TTL_MS) {
      liveRegime = cachedBenchmark.regime;
    } else {
      try {
        const btcCandles = await exchanges.binance.fetchOHLCV('BTC/USDT', regimeTf, undefined, 260);
        const regimeTfMs = parseTimeframeMs(regimeTf);
        liveRegime = analyzeSpotRegime(btcCandles.filter(c => c[0] + regimeTfMs <= Date.now()));
        liveBenchmarkCache.set(regimeTf, { ts: Date.now(), regime: liveRegime });
      } catch (e) {
        console.warn(`BTC regime ${regimeTf}: ${e.message}`);
      }
    }

    const cursor = signalScanCursor.get(tf) || 0;
    const batch = [];
    for (let i = 0; i < Math.min(LIVE_SIGNAL_BATCH_SIZE, universe.length); i++) {
      batch.push(universe[(cursor + i) % universe.length]);
    }
    signalScanCursor.set(tf, (cursor + batch.length) % universe.length);

    // Small worker pool: keeps the complete universe without creating hundreds of simultaneous requests.
    const queue = [...batch];
    const worker = async () => {
      while (queue.length) {
        const symbol = queue.shift();
        try {
          const ohlcv = await exchanges.binance.fetchOHLCV(symbol, tf, undefined, 140);
          const analysis = analyzeMarket(ohlcv, { minCandles: 60, timeframe: tf, profile, regime: liveRegime });
          if (analysis) result[symbol] = analysis;
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, batch.length) }, worker));

    signalCache.set(cacheKey, { ts: Date.now(), data: result });
    return result;
  })().finally(() => signalInflight.delete(cacheKey));
  signalInflight.set(cacheKey, promise);
  return promise;
}

async function refreshRealQuotes() {
  if (!arbitragePairs.length) return;
  const startedAt = Date.now();
  const symbols = [];
  for (let i = 0; i < Math.min(ARB_QUOTE_BATCH_SIZE, arbitragePairs.length); i++) {
    symbols.push(arbitragePairs[(quoteScanCursor + i) % arbitragePairs.length]);
  }
  quoteScanCursor = (quoteScanCursor + symbols.length) % arbitragePairs.length;

  const venueStats = Object.fromEntries(exchangeNames.map(name => [name, { requested: 0, received: 0, errors: 0, lastError: null }]));

  await Promise.all(exchangeNames.map(async name => {
    const ex = exchanges[name];
    const supported = symbols.filter(s => ex.markets?.[s] && isEligibleSpotUsdtMarket(s, ex.markets[s]));
    venueStats[name].requested = supported.length;
    if (!supported.length) return;

    for (let offset = 0; offset < supported.length; offset += ARB_FETCH_CHUNK_SIZE) {
      const chunk = supported.slice(offset, offset + ARB_FETCH_CHUNK_SIZE);
      let tickers = {};
      try {
        if (ex.has?.fetchTickers) {
          tickers = await ex.fetchTickers(chunk);
        } else {
          const rows = await Promise.all(chunk.map(async symbol => {
            try { return [symbol, await ex.fetchTicker(symbol)]; }
            catch (e) { venueStats[name].errors++; venueStats[name].lastError = e.message; return [symbol, null]; }
          }));
          tickers = Object.fromEntries(rows);
        }
      } catch (bulkError) {
        // Some venues reject bulk-symbol ticker requests. Fall back to individual
        // ticker calls instead of losing the entire exchange for this refresh.
        venueStats[name].errors++;
        venueStats[name].lastError = bulkError.message;
        const rows = await Promise.all(chunk.map(async symbol => {
          try { return [symbol, await ex.fetchTicker(symbol)]; }
          catch (e) { venueStats[name].errors++; venueStats[name].lastError = e.message; return [symbol, null]; }
        }));
        tickers = Object.fromEntries(rows);
      }

      for (const symbol of chunk) {
        const t = tickers?.[symbol];
        const ask = Number(t?.ask);
        const bid = Number(t?.bid);
        if (ask > 0 && bid > 0 && ask >= bid) {
          globalTickersCache[name][symbol] = {
            ask,
            bid,
            timestamp: Number(t?.timestamp) || Date.now()
          };
          venueStats[name].received++;
        }
      }
    }
  }));

  arbitrageQuoteStats = {
    lastRefreshAt: Date.now(),
    lastRefreshMs: Date.now() - startedAt,
    scannedSymbols: symbols.length,
    venues: venueStats
  };
}

function getFreshQuoteCounts() {
  const now = Date.now();
  return Object.fromEntries(exchangeNames.map(name => [
    name,
    Object.values(globalTickersCache[name] || {}).filter(q => now - (q.timestamp || 0) < QUOTE_STALE_MS).length
  ]));
}

function buildArbitrageOpportunities() {
  const opportunities = [];
  const now = Date.now();

  for (const symbol of arbitragePairs) {
    const quotes = exchangeNames
      .map(name => ({ name, ...(globalTickersCache[name]?.[symbol] || {}) }))
      .filter(q => q.ask > 0 && q.bid > 0 && now - (q.timestamp || 0) < QUOTE_STALE_MS);
    if (quotes.length < 2) continue;

    // Evaluate every buy/sell venue combination and only admit routes whose
    // underlying asset identity has been verified. Symbol equality is not enough.
    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.name === sell.name) continue;
        const key = [buy.name, sell.name].sort().join('|');
        const identity = pairIdentityMatrix[symbol]?.[key];
        let identityResult = identity?.verified
          ? { allowed: true, verified: true, level: identity.level, method: identity.method, reason: identity.reason, sharedNetworks: identity.sharedNetworks || [] }
          : { allowed: false };

        if (!identityResult.allowed && ARB_IDENTITY_MODE !== 'strict') {
          const fallback = conservativeIdentityFallback(symbol, buy.name, sell.name, identity, buy, sell);
          if (fallback.allowed) identityResult = { ...fallback, verified: false, sharedNetworks: [] };
        }
        if (!identityResult.allowed) continue;

        const grossSpread = ((sell.bid - buy.ask) / buy.ask) * 100;
        const netSpread = grossSpread - (TAKER_FEE_RATE * 2 * 100);
        opportunities.push({
          pair: symbol,
          buyEx: buy.name,
          sellEx: sell.name,
          route: `${buy.name.toUpperCase()} ➔ ${sell.name.toUpperCase()}`,
          buyAsk: buy.ask,
          sellBid: sell.bid,
          grossSpread,
          netSpread,
          suggestedTP: Math.max(grossSpread, 0).toFixed(3),
          suggestedSL: '1.50',
          executableAfterFees: netSpread > 0,
          identityVerified: identityResult.verified === true,
          identityLevel: identityResult.level,
          identityMethod: identityResult.method,
          identityReason: identityResult.reason,
          sharedNetworks: identityResult.sharedNetworks || []
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.netSpread - a.netSpread);
}

app.get('/api/all-pairs', (_, res) => res.json({ pairs: allEligiblePairs, venues: pairVenues, count: allEligiblePairs.length }));
app.get('/api/health', (_, res) => res.json({ success: true, mode: 'V4 Regime Spot', quoteSources: exchangeNames, pairs: allEligiblePairs.length, binanceSignalPairs: binanceSignalPairs.length, arbitrageCandidates: arbitragePairs.length, strictlyVerifiedArbitragePairs: strictlyVerifiedArbitragePairs.length, identityMode: ARB_IDENTITY_MODE, identityRejectedPairs: Object.keys(identityRejectedPairs).length }));
app.get('/api/arbitrage-identity', (_, res) => res.json({ success: true, identityMode: ARB_IDENTITY_MODE, candidatePairs: arbitragePairs.length, strictlyVerifiedPairs: strictlyVerifiedArbitragePairs.length, rejectedPairs: identityRejectedPairs }));
app.get('/api/arbitrage-status', (_, res) => {
  const opportunities = buildArbitrageOpportunities();
  const freshQuoteCounts = getFreshQuoteCounts();
  res.json({
    success: true,
    arbitragePairs: arbitragePairs.length,
    strictlyVerifiedPairs: strictlyVerifiedArbitragePairs.length,
    identityMode: ARB_IDENTITY_MODE,
    opportunities: opportunities.length,
    netPositive: opportunities.filter(o => o.executableAfterFees).length,
    freshQuoteCounts,
    quoteStats: arbitrageQuoteStats
  });
});

app.post('/api/import-wallet', (req, res) => {
  try {
    const incoming = req.body?.manualWallet ? req.body : { manualWallet: req.body, autoWallet: persistentWalletState.autoWallet };
    persistentWalletState = sanitizeWalletState(incoming);
    saveWalletState();
    io.emit('load-wallet-state', persistentWalletState);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/reset-wallet', (_, res) => {
  persistentWalletState = sanitizeWalletState({ manualWallet: {}, autoWallet: {} });
  saveWalletState();
  io.emit('load-wallet-state', persistentWalletState);
  res.json({ success: true });
});

app.post('/api/historical-screener', async (req, res) => {
  try {
    const tf = normalizeTimeframe(req.body?.timeframe || '30m');
    const startMs = req.body?.startTimestamp ? new Date(req.body.startTimestamp).getTime() : Date.now() - 3 * 86_400_000;
    if (!Number.isFinite(startMs)) return res.status(400).json({ success: false, message: 'Invalid historical start date/time.' });

    const tfMs = parseTimeframeMs(tf);
    const strategyProfile = req.body?.strategyProfile || STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
    const benchmark = await fetchBenchmarkRange(tf, startMs, startMs);
    const startRegime = strategyProfile === STRATEGY_PROFILES.V4_REGIME_SPOT
      ? regimeAtTimestamp(benchmark.candles, startMs, new Map(), benchmark.timeframe)
      : { label: 'BASELINE', score: 0, allowLong: true, strongLong: true };
    const requestedLimit = req.body?.scanLimit === 'all' ? 'all' : Math.max(10, Math.min(500, Number(req.body?.scanLimit) || 100));
    const ranked = await refreshBinanceVolumeRanking();
    const symbols = requestedLimit === 'all' ? [...ranked] : ranked.slice(0, requestedLimit);
    const signals = [];
    const failures = [];
    let noAnalysis = 0;
    const startedAt = Date.now();

    await mapWithConcurrency(symbols, 3, async symbol => {
      try {
        const since = Math.max(0, startMs - 180 * tfMs);
        const candles = await fetchOhlcvPageWithRetry(exchanges.binance, symbol, tf, since, 220, 3);
        const closedAtPoint = candles.filter(c => c[0] + tfMs <= startMs);
        const analysis = analyzeMarket(closedAtPoint, { minCandles: 60, timeframe: tf, profile: strategyProfile, regime: startRegime });
        if (analysis) signals.push({ pair: symbol, ...analysis });
        else noAnalysis++;
      } catch (e) {
        failures.push({ pair: symbol, error: e.message });
      }
    });

    signals.sort((a, b) => b.consensusScore - a.consensusScore);
    const buySignals = signals.filter(s => String(s.finalSignal).includes('BUY')).length;
    res.json({
      success: true,
      signals,
      exactAsOf: new Date(startMs).toISOString(),
      strategyProfile,
      benchmark: { pair: 'BTC/USDT', timeframe: benchmark.timeframe, regime: startRegime },
      diagnostics: {
        requested: symbols.length,
        analyzed: signals.length,
        buySignals,
        noAnalysis,
        failed: failures.length,
        elapsedMs: Date.now() - startedAt,
        scanLimit: requestedLimit,
        failures: failures.slice(0, 12)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});


// -----------------------------------------------------------------------------
// Sequential per-coin research jobs (V5.4)
// -----------------------------------------------------------------------------
const RESEARCH_EXPORT_ROOT = path.join(__dirname, 'research_exports');
fs.mkdirSync(RESEARCH_EXPORT_ROOT, { recursive: true });
const researchJobs = new Map();

function csvEscapeServer(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function safePathPart(value) {
  return String(value || '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'item';
}

function researchTradeRows(result, config, status = 'TRADED', error = '') {
  const deals = result?.closedDeals || [];
  const common = {
    status,
    error,
    pair: result?.pair || config.symbol || '',
    timeframe: config.timeframe,
    strategy_profile: config.strategyProfile,
    interval_start: new Date(config.startMs).toISOString(),
    interval_end: new Date(config.endMs).toISOString(),
    requested_tp_level: config.tpLevel,
    effective_tp_level: result?.effectiveTargetLevel || resolveTargetLevel(config.tpLevel, config.timeframe),
    starting_budget_usd: config.budget
  };
  if (!deals.length) return [{ ...common }];
  return deals.map((d, idx) => {
    const snap = d.snapshot || {};
    const fam = snap.families || {};
    const amount = Number(d.tradeAmount || 0);
    const pnl = Number(d.netProfitUSD || 0);
    return {
      ...common,
      trade_no: idx + 1,
      entry_time: d.entryTime,
      exit_time: d.exitTime || d.closedTime,
      entry_signal: d.inSignal,
      exit_reason: d.exitReason || d.outSignal,
      buy_price: d.entryPrice ?? d.buyAsk,
      sell_price: d.exitPrice,
      take_profit_price: d.targetTpPrice,
      stop_loss_price: d.stopLossPrice,
      trade_amount_usd: amount,
      fees_usd: Number(d.totalFeesUSD || 0),
      net_pnl_usd: pnl,
      return_pct: amount ? (pnl / amount) * 100 : 0,
      lowest_price_dip: d.lowestPriceDip,
      max_drawdown_pct: d.maxDrawdownPct,
      hold_hours: d.holdHours,
      rsi: snap.rsi,
      macd: snap.macd,
      stochastic: snap.stoch,
      cci: snap.cci,
      mfi: snap.mfi,
      williams_r14_entry: snap.williamsR14,
      roc9_pct: snap.roc9Pct,
      sma20: snap.sma20,
      sma50: snap.sma50,
      adx: snap.adx,
      adx_value: snap.adxValue,
      relative_volume: snap.relativeVolume,
      atr_pct: snap.atrPct,
      vwap: snap.vwap,
      smc: snap.smc,
      ichimoku: snap.ichimoku,
      consensus: snap.consensus,
      consensus_score: snap.score,
      v3_score: snap.v3Score,
      v4_score: snap.v4Score,
      pullback_score: snap.pullbackScore,
      breakout_score: snap.breakoutScore,
      setup_type: snap.setupType,
      edge_quality_score: snap.edgeQualityScore,
      edge_setup_type: snap.edgeSetupType,
      edge_qualified: snap.edgeQualified,
      edge_strong: snap.edgeStrong,
      reversal_confirmation_count: snap.reversalConfirmationCount,
      selloff_decelerating: snap.selloffDecelerating,
      exhaustion_score: snap.exhaustionScore,
      exhaustion_raw_score: snap.exhaustionRawScore,
      breakdown_penalty: snap.breakdownPenalty,
      williams_r14: snap.williamsR14,
      williams_r14_prev: snap.williamsR14Prev,
      stoch_k: snap.stochK,
      stoch_prev_k: snap.stochPrevK,
      stoch_rising: snap.stochRising,
      williams_rising: snap.williamsRising,
      bb_position: snap.bbPosition,
      below_lower_band_atr: snap.belowLowerBandAtr,
      last_body_atr: snap.lastBodyAtr,
      last_bearish_body: snap.lastBearishBody,
      recent_3_return_pct: snap.recent3ReturnPct,
      ema21_distance_pct: snap.ema21DistancePct,
      ema50_distance_pct: snap.ema50DistancePct,
      vwap_distance_pct: snap.vwapDistancePct,
      recent_high_distance_pct: snap.recentHighDistancePct,
      recent_low_distance_pct: snap.recentLowDistancePct,
      pullback_depth_pct: snap.pullbackDepthPct,
      bars_since_local_high: snap.barsSinceLocalHigh,
      ema21_slope_pct_3: snap.ema21SlopePct3,
      rsi_prev_1: snap.rsiPrev1,
      rsi_prev_2: snap.rsiPrev2,
      rsi_delta_1: snap.rsiDelta1,
      rsi_delta_2: snap.rsiDelta2,
      macd_histogram: snap.macdHistogram,
      macd_histogram_prev: snap.macdHistogramPrev,
      macd_histogram_delta: snap.macdHistogramDelta,
      bullish_candle: snap.bullishCandle,
      prev_return_1_pct: snap.prevReturn1Pct,
      prev_return_2_pct: snap.prevReturn2Pct,
      prev_return_3_pct: snap.prevReturn3Pct,
      touched_ema21_recently: snap.touchedEma21Recently,
      touched_vwap_recently: snap.touchedVwapRecently,
      price_near_ema21: snap.priceNearEma21,
      price_near_vwap: snap.priceNearVwap,
      ema21_distance_atr: snap.ema21DistanceAtr,
      vwap_distance_atr: snap.vwapDistanceAtr,
      recent_high_distance_atr: snap.recentHighDistanceAtr,
      trend_gate: snap.trendGate,
      structure_gate: snap.structureGate,
      location_gate: snap.locationGate,
      fresh_pullback_gate: snap.freshPullbackGate,
      extension_gate: snap.extensionGate,
      oscillator_gate: snap.oscillatorGate,
      pullback_trend_score: snap.pullbackTrendScore,
      pullback_quality_score: snap.pullbackQualityScore,
      reversal_confirmation_score: snap.reversalConfirmationScore,
      pullback_participation_score: snap.pullbackParticipationScore,
      extension_penalty: snap.extensionPenalty,
      btc_regime: snap.regime,
      btc_regime_score: snap.regimeScore,
      btc_adx: snap.regimeAdx,
      btc_rsi: snap.regimeRsi,
      btc_atr_pct: snap.regimeAtrPct,
      btc_structure: snap.regimeStructure,
      trend_score: fam.trend,
      momentum_score: fam.momentum,
      structure_score: fam.structure,
      participation_score: fam.participation,
      volatility_score: fam.volatility,
      rejection_reasons: snap.rejectionReasons
    };
  });
}

const RESEARCH_CSV_HEADERS = [
  'status','error','pair','timeframe','strategy_profile','interval_start','interval_end',
  'requested_tp_level','effective_tp_level','starting_budget_usd','trade_no','entry_time','exit_time',
  'entry_signal','exit_reason','buy_price','sell_price','take_profit_price','stop_loss_price',
  'trade_amount_usd','fees_usd','net_pnl_usd','return_pct','lowest_price_dip','max_drawdown_pct',
  'hold_hours','rsi','macd','stochastic','cci','mfi','williams_r14_entry','roc9_pct','sma20','sma50','adx','adx_value','relative_volume','atr_pct','vwap','smc',
  'ichimoku','consensus','consensus_score','v3_score','v4_score','pullback_score','breakout_score','setup_type','edge_quality_score','edge_setup_type','edge_qualified','edge_strong','reversal_confirmation_count','selloff_decelerating','exhaustion_score','exhaustion_raw_score','breakdown_penalty','williams_r14','williams_r14_prev','stoch_k','stoch_prev_k','stoch_rising','williams_rising','bb_position','below_lower_band_atr','last_body_atr','last_bearish_body','recent_3_return_pct',
  'ema21_distance_pct','ema50_distance_pct','vwap_distance_pct','recent_high_distance_pct','recent_low_distance_pct',
  'pullback_depth_pct','bars_since_local_high','ema21_slope_pct_3','rsi_prev_1','rsi_prev_2','rsi_delta_1','rsi_delta_2',
  'macd_histogram','macd_histogram_prev','macd_histogram_delta','bullish_candle','prev_return_1_pct','prev_return_2_pct','prev_return_3_pct',
  'touched_ema21_recently','touched_vwap_recently','price_near_ema21','price_near_vwap','ema21_distance_atr','vwap_distance_atr','recent_high_distance_atr','trend_gate','structure_gate','location_gate','fresh_pullback_gate','extension_gate','oscillator_gate','pullback_trend_score','pullback_quality_score',
  'reversal_confirmation_score','pullback_participation_score','extension_penalty','btc_regime','btc_regime_score',
  'btc_adx','btc_rsi','btc_atr_pct','btc_structure','trend_score','momentum_score','structure_score',
  'participation_score','volatility_score','rejection_reasons'
];

function objectsToCsv(rows, headers = RESEARCH_CSV_HEADERS) {
  return [
    headers.map(csvEscapeServer).join(','),
    ...rows.map(row => headers.map(h => csvEscapeServer(row?.[h])).join(','))
  ].join('\n') + '\n';
}

const COIN_SUMMARY_HEADERS = [
  'coin_index','pair','status','error','candles_scanned','starting_capital_usd','final_balance_usd',
  'net_pnl_usd','return_pct','trades','wins','losses','win_rate_pct','profit_factor','total_fees_usd',
  'avg_drawdown_pct','avg_hold_hours','csv_file'
];

function writeCoinSummaryFile(job) {
  const rows = job.coinSummaries.map((x, i) => ({ coin_index: i + 1, ...x }));
  fs.writeFileSync(path.join(job.outputDir, 'coin_summary.csv'), objectsToCsv(rows, COIN_SUMMARY_HEADERS), 'utf8');
}


const SIGNAL_STUDY_HEADERS = [
  'dimension','bucket','trades','wins','losses','win_rate_pct','net_pnl_usd','gross_profit_usd','gross_loss_usd','profit_factor','fees_usd'
];

function numericBand(value, bands, fallback = 'UNKNOWN') {
  const x = Number(value);
  if (!Number.isFinite(x)) return fallback;
  for (const [max, label] of bands) if (x < max) return label;
  return bands.length ? bands[bands.length - 1][1].replace(/^</, '>=') : fallback;
}

function studyBucketsForDeal(d) {
  const s = d?.snapshot || {};
  const recent3 = Number(s.recent3ReturnPct);
  const exhaustion = Number(s.exhaustionRawScore);
  const stoch = Number(s.stochK);
  return {
    setup_type: s.edgeSetupType || s.setupType || 'UNKNOWN',
    entry_signal: String(d?.inSignal || '').includes('STRONG BUY') ? 'STRONG BUY' : 'BUY',
    structure: s.smc || 'UNKNOWN',
    vwap_state: s.vwap || 'UNKNOWN',
    btc_regime: s.regime || 'UNKNOWN',
    adx_band: numericBand(s.adxValue, [[22,'<22'],[28,'22-28'],[36,'28-36'],[9999,'36+']]),
    rvol_band: numericBand(s.relativeVolume, [[0.6,'<0.6'],[1.0,'0.6-1.0'],[1.5,'1.0-1.5'],[3.5,'1.5-3.5'],[9999,'3.5+']]),
    atr_pct_band: numericBand(s.atrPct, [[0.4,'<0.4'],[0.55,'0.4-0.55'],[1.1,'0.55-1.10'],[1.3,'1.10-1.30'],[9999,'1.30+']]),
    exhaustion_band: Number.isFinite(exhaustion) ? (exhaustion < 4.2 ? '<4.2' : exhaustion < 5 ? '4.2-5.0' : exhaustion <= 6.8 ? '5.0-6.8' : exhaustion <= 7 ? '6.8-7.0' : '>7.0') : 'UNKNOWN',
    stoch_band: Number.isFinite(stoch) ? (stoch < 20 ? '<20' : stoch < 40 ? '20-40' : stoch < 70 ? '40-70' : stoch < 83 ? '70-83' : '83+') : 'UNKNOWN',
    recent_3_return_band: Number.isFinite(recent3) ? (recent3 < -2.5 ? '<-2.5%' : recent3 <= -0.3 ? '-2.5% to -0.3%' : recent3 <= 0.5 ? '-0.3% to +0.5%' : recent3 <= 1.5 ? '+0.5% to +1.5%' : '>+1.5%') : 'UNKNOWN',
    bullish_candle: String(s.bullishCandle),
    stoch_rising: String(s.stochRising),
    williams_rising: String(s.williamsRising),
    selloff_decelerating: String(s.selloffDecelerating),
    edge_quality_band: numericBand(s.edgeQualityScore, [[4.5,'<4.5'],[5.5,'4.5-5.5'],[6.5,'5.5-6.5'],[7.5,'6.5-7.5'],[9999,'7.5+']])
  };
}

function accumulateSignalStudy(job, deals = []) {
  if (!job.signalStudy) job.signalStudy = new Map();
  for (const d of deals) {
    const pnl = Number(d?.netProfitUSD || 0);
    const fee = Number(d?.totalFeesUSD || 0);
    const win = pnl > 0;
    for (const [dimension, bucket] of Object.entries(studyBucketsForDeal(d))) {
      const key = `${dimension}\u0000${bucket}`;
      const row = job.signalStudy.get(key) || { dimension, bucket, trades:0, wins:0, losses:0, net_pnl_usd:0, gross_profit_usd:0, gross_loss_usd:0, fees_usd:0 };
      row.trades++;
      if (win) { row.wins++; row.gross_profit_usd += pnl; }
      else { row.losses++; row.gross_loss_usd += Math.abs(pnl); }
      row.net_pnl_usd += pnl;
      row.fees_usd += fee;
      job.signalStudy.set(key, row);
    }
  }
}

function writeSignalStudyFile(job) {
  const rows = [...(job.signalStudy?.values?.() || [])].map(r => ({
    ...r,
    win_rate_pct: r.trades ? Number((r.wins / r.trades * 100).toFixed(3)) : 0,
    net_pnl_usd: Number(r.net_pnl_usd.toFixed(8)),
    gross_profit_usd: Number(r.gross_profit_usd.toFixed(8)),
    gross_loss_usd: Number(r.gross_loss_usd.toFixed(8)),
    profit_factor: r.gross_loss_usd > 0 ? Number((r.gross_profit_usd / r.gross_loss_usd).toFixed(4)) : (r.gross_profit_usd > 0 ? 'INF' : 0),
    fees_usd: Number(r.fees_usd.toFixed(8))
  })).sort((a,b) => a.dimension.localeCompare(b.dimension) || b.trades - a.trades);
  fs.writeFileSync(path.join(job.outputDir, 'signal_study_summary.csv'), objectsToCsv(rows, SIGNAL_STUDY_HEADERS), 'utf8');
}

// Tiny ZIP writer using the STORE method, so the project needs no extra npm package.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC32_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'));
    const data = file.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(localBuf.length, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

function createResearchZip(job) {
  const names = fs.readdirSync(job.outputDir).filter(n => n.endsWith('.csv') || n.endsWith('.json')).sort();
  const files = names.map(name => ({ name, data: fs.readFileSync(path.join(job.outputDir, name)) }));
  const zip = makeStoredZip(files);
  const zipPath = path.join(job.outputDir, 'all_coin_results.zip');
  fs.writeFileSync(zipPath, zip);
  job.zipPath = zipPath;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    totalCoins: job.totalCoins,
    completedCoins: job.completedCoins,
    currentCoin: job.currentCoin,
    tradedCoins: job.tradedCoins,
    noSignalCoins: job.noSignalCoins,
    dataErrorCoins: job.dataErrorCoins,
    totalTrades: job.totalTrades,
    totalWins: job.totalWins,
    totalLosses: job.totalLosses,
    winRatePct: job.totalTrades ? Number(((job.totalWins / job.totalTrades) * 100).toFixed(2)) : 0,
    grossProfitUSD: Number(job.grossProfitUSD.toFixed(2)),
    grossLossUSD: Number(job.grossLossUSD.toFixed(2)),
    profitFactor: job.grossLossUSD > 0 ? Number((job.grossProfitUSD / job.grossLossUSD).toFixed(3)) : (job.grossProfitUSD > 0 ? 'INF' : 0),
    totalFeesUSD: Number(job.totalFeesUSD.toFixed(2)),
    totalNetPnlUSD: Number(job.totalNetPnlUSD.toFixed(2)),
    currentMessage: job.currentMessage,
    lastCompleted: job.lastCompleted,
    outputFolder: path.relative(__dirname, job.outputDir).replace(/\\/g, '/'),
    downloadReady: Boolean(job.zipPath && fs.existsSync(job.zipPath)),
    config: job.config
  };
}

async function runSequentialResearchJob(job) {
  job.status = 'RUNNING';
  job.startedAt = new Date().toISOString();
  try {
    job.currentMessage = 'Loading BTC benchmark history once for this interval...';
    const benchmark = await fetchBenchmarkRange(job.config.timeframe, job.config.startMs, job.config.endMs);
    job.config.benchmarkTimeframe = benchmark.timeframe;

    for (let idx = 0; idx < job.assetList.length; idx++) {
      const symbol = job.assetList[idx];
      job.currentCoin = symbol;
      job.currentMessage = `Coin ${idx + 1}/${job.assetList.length}: downloading + testing ${symbol}`;
      const prefix = String(idx + 1).padStart(String(job.assetList.length).length, '0');
      const fileName = `${prefix}_${safePathPart(symbol.replace('/', '_'))}.csv`;
      const filePath = path.join(job.outputDir, fileName);
      let summary;
      try {
        const r = await runBacktest({
          symbolPair: symbol,
          tf: job.config.timeframe,
          startMs: job.config.startMs,
          endMs: job.config.endMs,
          initialCapital: job.config.budget,
          targetLevel: job.config.tpLevel,
          forceManualEntry: false,
          strategyProfile: job.config.strategyProfile,
          benchmarkCandles: benchmark.candles,
          benchmarkTimeframe: benchmark.timeframe
        });
        const deals = r.closedDeals || [];
        accumulateSignalStudy(job, deals);
        const rows = researchTradeRows(r, { ...job.config, symbol }, deals.length ? 'TRADED' : 'NO_SIGNALS', '');
        fs.writeFileSync(filePath, objectsToCsv(rows), 'utf8');
        const wins = deals.filter(d => Number(d.netProfitUSD) > 0).length;
        const losses = deals.length - wins;
        const gp = deals.filter(d => Number(d.netProfitUSD) > 0).reduce((a,d)=>a+Number(d.netProfitUSD||0),0);
        const gl = Math.abs(deals.filter(d => Number(d.netProfitUSD) <= 0).reduce((a,d)=>a+Number(d.netProfitUSD||0),0));
        summary = {
          pair: symbol,
          status: deals.length ? 'TRADED' : 'NO_SIGNALS',
          error: '',
          candles_scanned: r.totalCandlesScanned,
          starting_capital_usd: job.config.budget,
          final_balance_usd: Number(r.finalBalance.toFixed(8)),
          net_pnl_usd: Number(r.totalPnl.toFixed(8)),
          return_pct: job.config.budget ? Number(((r.totalPnl / job.config.budget) * 100).toFixed(6)) : 0,
          trades: deals.length,
          wins,
          losses,
          win_rate_pct: deals.length ? Number(((wins / deals.length) * 100).toFixed(3)) : 0,
          profit_factor: gl ? Number((gp / gl).toFixed(4)) : gp > 0 ? 'INF' : 0,
          total_fees_usd: Number(deals.reduce((a,d)=>a+Number(d.totalFeesUSD||0),0).toFixed(8)),
          avg_drawdown_pct: deals.length ? Number((deals.reduce((a,d)=>a+Number(d.maxDrawdownPct||0),0)/deals.length).toFixed(5)) : 0,
          avg_hold_hours: deals.length ? Number((deals.reduce((a,d)=>a+Number(d.holdHours||0),0)/deals.length).toFixed(5)) : 0,
          csv_file: fileName
        };
        if (deals.length) job.tradedCoins++; else job.noSignalCoins++;
        job.totalTrades += deals.length;
        job.totalWins += wins;
        job.totalLosses += losses;
        job.grossProfitUSD += gp;
        job.grossLossUSD += gl;
        job.totalFeesUSD += deals.reduce((a,d)=>a+Number(d.totalFeesUSD||0),0);
        job.totalNetPnlUSD += Number(r.totalPnl || 0);
      } catch (e) {
        const rows = researchTradeRows({ pair: symbol, effectiveTargetLevel: resolveTargetLevel(job.config.tpLevel, job.config.timeframe) }, { ...job.config, symbol }, 'DATA_ERROR', e.message);
        fs.writeFileSync(filePath, objectsToCsv(rows), 'utf8');
        summary = {
          pair: symbol, status: 'DATA_ERROR', error: e.message, candles_scanned: 0,
          starting_capital_usd: job.config.budget, final_balance_usd: job.config.budget,
          net_pnl_usd: 0, return_pct: 0, trades: 0, wins: 0, losses: 0, win_rate_pct: 0,
          profit_factor: 0, total_fees_usd: 0, avg_drawdown_pct: 0, avg_hold_hours: 0, csv_file: fileName
        };
        job.dataErrorCoins++;
      }
      job.coinSummaries.push(summary);
      job.completedCoins = idx + 1;
      job.lastCompleted = summary;
      job.currentMessage = `Saved ${fileName}; moving to next coin...`;
      writeCoinSummaryFile(job); // Persist progress after EVERY coin.
      writeSignalStudyFile(job);
      fs.writeFileSync(path.join(job.outputDir, 'run_manifest.json'), JSON.stringify({ ...publicJob(job), coinSummaries: job.coinSummaries }, null, 2));
    }

    job.currentCoin = '';
    job.status = 'COMPLETED';
    job.finishedAt = new Date().toISOString();
    job.currentMessage = `Completed ${job.completedCoins}/${job.totalCoins} coins. Creating ZIP...`;
    writeCoinSummaryFile(job);
    writeSignalStudyFile(job);
    fs.writeFileSync(path.join(job.outputDir, 'run_manifest.json'), JSON.stringify({ ...publicJob(job), coinSummaries: job.coinSummaries }, null, 2));
    createResearchZip(job);
    job.currentMessage = 'Research complete. All per-coin CSV files are saved.';
  } catch (e) {
    job.status = 'FAILED';
    job.finishedAt = new Date().toISOString();
    job.currentMessage = e.message;
    try { fs.writeFileSync(path.join(job.outputDir, 'run_manifest.json'), JSON.stringify({ ...publicJob(job), fatalError: e.message, coinSummaries: job.coinSummaries }, null, 2)); } catch {}
  }
}

app.post('/api/research-jobs', async (req, res) => {
  try {
    const timeframe = normalizeTimeframe(req.body?.timeframe || '30m');
    const startMs = new Date(req.body?.startTimestamp).getTime();
    const endMs = new Date(req.body?.endTimestamp).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return res.status(400).json({ success:false, message:'End date/time must be after start date/time.' });
    const budget = Math.max(1, Number(req.body?.tradeAmountPerCoin) || 1000);
    const tpLevel = req.body?.tpLevel || 'AUTO';
    const strategyProfile = req.body?.strategyProfile || STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
    const scanLimit = req.body?.scanLimit === 'all' ? 'all' : Math.max(1, Math.min(500, Number(req.body?.scanLimit) || 100));
    const ranked = await refreshBinanceVolumeRanking();
    const source = scanLimit === 'all' ? [...binanceSignalPairs] : ranked.slice(0, scanLimit);
    const allowed = new Set(binanceSignalPairs);
    const spotOnlyResearch = Boolean(req.body?.spotOnlyResearch);
    const requestedSymbols = Array.isArray(req.body?.selectedSymbols) ? req.body.selectedSymbols : [];

    let assetList;
    if (spotOnlyResearch) {
      const sourceSet = new Set(source);
      assetList = [...new Set(requestedSymbols)]
        .filter(s => typeof s === 'string' && allowed.has(s) && sourceSet.has(s));
      if (!assetList.length) {
        return res.status(400).json({ success:false, message:'SPOT MODE is enabled, but no BUY / STRONG BUY symbols from the interval-start scan are eligible for this research run.' });
      }
    } else {
      assetList = [...new Set(source)].filter(s => allowed.has(s));
    }
    if (!assetList.length) return res.status(400).json({ success:false, message:'No eligible Binance spot pairs are available.' });

    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const id = `${stamp}_${safePathPart(timeframe)}_${safePathPart(strategyProfile)}`;
    const outputDir = path.join(RESEARCH_EXPORT_ROOT, id);
    fs.mkdirSync(outputDir, { recursive: true });
    const job = {
      id, status:'QUEUED', createdAt:new Date().toISOString(), startedAt:null, finishedAt:null,
      totalCoins:assetList.length, completedCoins:0, currentCoin:'', tradedCoins:0, noSignalCoins:0,
      dataErrorCoins:0, totalTrades:0, totalWins:0, totalLosses:0, grossProfitUSD:0, grossLossUSD:0, totalFeesUSD:0, totalNetPnlUSD:0, currentMessage:'Queued', lastCompleted:null,
      assetList, coinSummaries:[], signalStudy:new Map(), outputDir, zipPath:null,
      config:{ timeframe, startMs, endMs, budget, tpLevel, strategyProfile, scanLimit, spotOnlyResearch, intervalStartCandidateCount: spotOnlyResearch ? assetList.length : null }
    };
    researchJobs.set(id, job);
    setImmediate(() => runSequentialResearchJob(job));
    res.json({ success:true, job:publicJob(job) });
  } catch (e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get('/api/research-jobs/:id', (req, res) => {
  const job = researchJobs.get(req.params.id);
  if (!job) return res.status(404).json({ success:false, message:'Research job not found in this server session.' });
  res.json({ success:true, job:publicJob(job) });
});

app.get('/api/research-jobs/:id/download', (req, res) => {
  const job = researchJobs.get(req.params.id);
  if (!job) return res.status(404).send('Research job not found.');
  if (!job.zipPath || !fs.existsSync(job.zipPath)) return res.status(409).send('Research ZIP is not ready yet.');
  res.download(job.zipPath, `${safePathPart(job.id)}_all_coin_csvs.zip`);
});

app.post('/api/batch-backtest', async (req, res) => {
  try {
    const tf = normalizeTimeframe(req.body?.timeframe || '30m');
    const startMs = req.body?.startTimestamp ? new Date(req.body.startTimestamp).getTime() : Date.now() - 3 * 86_400_000;
    const endMs = req.body?.endTimestamp ? new Date(req.body.endTimestamp).getTime() : Date.now();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return res.status(400).json({ success: false, message: 'End date/time must be after start date/time.' });
    const tradeCapital = Number(req.body?.tradeAmountPerCoin) || 100;
    const targetLevel = req.body?.tpLevel || 'AUTO';
    const strategyProfile = req.body?.strategyProfile || STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
    const benchmark = await fetchBenchmarkRange(tf, startMs, endMs);

    // Research mode: every eligible Binance spot pair gets an isolated simulation.
    // Each coin starts with the same capital, repeatedly enters/exits/re-enters on its own signals,
    // and never competes with other coins for portfolio cash. This makes cross-coin comparison fair.
    const requestedLimit = req.body?.scanLimit === 'all'
      ? 'all'
      : Math.max(10, Math.min(500, Number(req.body?.scanLimit) || 100));
    const ranked = await refreshBinanceVolumeRanking();
    const requested = Array.isArray(req.body?.symbols) && req.body.symbols.length
      ? req.body.symbols
      : (requestedLimit === 'all' ? [...binanceSignalPairs] : ranked.slice(0, requestedLimit));
    const allowed = new Set(binanceSignalPairs);
    const assetList = [...new Set(requested)].filter(symbol => allowed.has(symbol));
    const results = [];
    const coinSummaries = [];
    const failures = [];
    const startedAt = Date.now();

    await mapWithConcurrency(assetList, 2, async symbol => {
      try {
        const r = await runBacktest({ symbolPair: symbol, tf, startMs, endMs, initialCapital: tradeCapital, targetLevel, forceManualEntry: false, strategyProfile, benchmarkCandles: benchmark.candles, benchmarkTimeframe: benchmark.timeframe });
        results.push(...r.closedDeals);
        const deals = r.closedDeals || [];
        const wins = deals.filter(d => d.netProfitUSD > 0).length;
        const losses = deals.length - wins;
        const gp = deals.filter(d => d.netProfitUSD > 0).reduce((sum, d) => sum + d.netProfitUSD, 0);
        const gl = Math.abs(deals.filter(d => d.netProfitUSD <= 0).reduce((sum, d) => sum + d.netProfitUSD, 0));
        coinSummaries.push({
          pair: symbol,
          status: deals.length ? 'TRADED' : 'NO_SIGNALS',
          candlesScanned: r.totalCandlesScanned,
          startingCapital: tradeCapital,
          finalBalance: r.finalBalance,
          netPnlUSD: r.totalPnl,
          returnPct: tradeCapital ? (r.totalPnl / tradeCapital) * 100 : 0,
          trades: deals.length,
          wins,
          losses,
          winRatePct: deals.length ? (wins / deals.length) * 100 : 0,
          profitFactor: gl ? gp / gl : gp > 0 ? Infinity : 0,
          totalFeesUSD: deals.reduce((sum, d) => sum + (Number(d.totalFeesUSD) || 0), 0),
          avgDrawdownPct: deals.length ? deals.reduce((sum, d) => sum + (Number(d.maxDrawdownPct) || 0), 0) / deals.length : 0,
          avgHoldHours: deals.length ? deals.reduce((sum, d) => sum + (Number(d.holdHours) || 0), 0) / deals.length : 0,
          error: ''
        });
      } catch (e) {
        const failure = { pair: symbol, error: e.message };
        failures.push(failure);
        coinSummaries.push({
          pair: symbol, status: 'DATA_ERROR', candlesScanned: 0,
          startingCapital: tradeCapital, finalBalance: tradeCapital, netPnlUSD: 0, returnPct: 0,
          trades: 0, wins: 0, losses: 0, winRatePct: 0, profitFactor: 0,
          totalFeesUSD: 0, avgDrawdownPct: 0, avgHoldHours: 0, error: e.message
        });
      }
    });

    results.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));
    coinSummaries.sort((a, b) => (b.netPnlUSD || 0) - (a.netPnlUSD || 0));
    const totalTrades = results.length;
    const wins = results.filter(r => r.netProfitUSD > 0).length;
    const losses = totalTrades - wins;
    const netPnl = results.reduce((s, r) => s + r.netProfitUSD, 0);
    const grossProfit = results.filter(r => r.netProfitUSD > 0).reduce((s, r) => s + r.netProfitUSD, 0);
    const grossLoss = Math.abs(results.filter(r => r.netProfitUSD <= 0).reduce((s, r) => s + r.netProfitUSD, 0));
    const totalFees = results.reduce((s, r) => s + (Number(r.totalFeesUSD) || 0), 0);
    const avgPnl = totalTrades ? netPnl / totalTrades : 0;
    const avgWin = wins ? grossProfit / wins : 0;
    const avgLoss = losses ? -grossLoss / losses : 0;
    const avgDrawdownPct = totalTrades ? results.reduce((s, r) => s + (Number(r.maxDrawdownPct) || 0), 0) / totalTrades : 0;
    const avgHoldHours = totalTrades ? results.reduce((s, r) => s + (Number(r.holdHours) || 0), 0) / totalTrades : 0;
    const exitReasons = results.reduce((acc, r) => {
      const key = String(r.exitReason || r.outSignal || 'UNKNOWN');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      timeframe: tf,
      strategyProfile,
      benchmarkTimeframe: benchmark.timeframe,
      tpLevel: targetLevel,
      effectiveTpLevel: resolveTargetLevel(targetLevel, tf),
      tradeAmountPerCoin: tradeCapital,
      symbolsTested: assetList.length,
      universeMode: 'ALL_COINS_INDEPENDENT_RESEARCH',
      scanLimit: requestedLimit,
      diagnostics: {
        completedSymbols: coinSummaries.length,
        tradedSymbols: coinSummaries.filter(x => x.status === 'TRADED').length,
        noSignalSymbols: coinSummaries.filter(x => x.status === 'NO_SIGNALS').length,
        failedSymbols: failures.length,
        elapsedMs: Date.now() - startedAt,
        failures: failures.slice(0, 25)
      },
      range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
      stats: {
        totalTrades, wins, losses,
        winRate: totalTrades ? ((wins / totalTrades) * 100).toFixed(1) : '0.0',
        netPnl: netPnl.toFixed(2),
        profitFactor: grossLoss ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? '∞' : '0.00',
        grossProfit: grossProfit.toFixed(2), grossLoss: grossLoss.toFixed(2),
        avgPnl: avgPnl.toFixed(4), avgWin: avgWin.toFixed(4), avgLoss: avgLoss.toFixed(4),
        totalFees: totalFees.toFixed(2), avgDrawdownPct: avgDrawdownPct.toFixed(3), avgHoldHours: avgHoldHours.toFixed(3), exitReasons
      },
      coinSummaries,
      results
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/backtest', async (req, res) => {
  try {
    const symbolPair = req.body?.symbol || 'BTC/USDT';
    const tf = normalizeTimeframe(req.body?.timeframe || '30m');
    const startMs = req.body?.startTimestamp ? new Date(req.body.startTimestamp).getTime() : Date.now() - 3 * 86_400_000;
    const endMs = req.body?.endTimestamp ? new Date(req.body.endTimestamp).getTime() : Date.now();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return res.status(400).json({ success: false, message: 'End date/time must be after start date/time.' });
    const initialCapital = Number(req.body?.tradeAmount) || 100;
    const targetLevel = req.body?.tpLevel || 'AUTO';
    const strategyProfile = req.body?.strategyProfile || STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
    const forceManualEntry = req.body?.forceManualEntry !== false;
    const benchmark = await fetchBenchmarkRange(tf, startMs, endMs);
    const r = await runBacktest({ symbolPair, tf, startMs, endMs, initialCapital, targetLevel, forceManualEntry, strategyProfile, benchmarkCandles: benchmark.candles, benchmarkTimeframe: benchmark.timeframe });
    res.json({
      success: true,
      pair: r.pair,
      timeframe: r.timeframe,
      strategyProfile: r.strategyProfile,
      effectiveTpLevel: r.effectiveTargetLevel,
      benchmarkTimeframe: r.benchmarkTimeframe,
      range: { start: r.startTime, end: r.endTime },
      totalCandlesScanned: r.totalCandlesScanned,
      finalBalance: r.finalBalance.toFixed(2),
      totalPnl: r.totalPnl.toFixed(2),
      closedDeals: r.closedDeals,
      hasOpenPosition: r.hasOpenPosition
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message, error: e.message }); }
});

async function initializeServer() {
  const marketsByExchange = {};
  pairVenues = {};

  for (const name of exchangeNames) {
    try {
      await exchanges[name].loadMarkets();
      const eligible = Object.keys(exchanges[name].markets).filter(symbol =>
        isEligibleSpotUsdtMarket(symbol, exchanges[name].markets[symbol])
      );
      marketsByExchange[name] = new Set(eligible);
      for (const symbol of eligible) {
        if (!pairVenues[symbol]) pairVenues[symbol] = [];
        pairVenues[symbol].push(name);
      }
    } catch (e) {
      console.warn(`Market load ${name}: ${e.message}`);
      marketsByExchange[name] = new Set();
    }
  }

  allEligiblePairs = Object.keys(pairVenues).sort((a, b) => a.localeCompare(b));
  binanceSignalPairs = Array.from(marketsByExchange.binance || []).sort((a, b) => a.localeCompare(b));

  // Build a venue-pair identity matrix. A symbol is admitted to arbitrage only
  // if at least one pair of exchanges can prove they refer to the same asset.
  pairIdentityMatrix = {};
  identityRejectedPairs = {};
  arbitragePairs = [];
  strictlyVerifiedArbitragePairs = [];

  for (const symbol of allEligiblePairs) {
    const venues = pairVenues[symbol] || [];
    if (venues.length < 2) continue;

    // IMPORTANT: every common eligible spot symbol becomes a QUOTE CANDIDATE.
    // We do not block quote collection just because one exchange lacks public
    // contract/name metadata. Route-level identity safety is applied later,
    // after fresh prices exist.
    arbitragePairs.push(symbol);
    pairIdentityMatrix[symbol] = {};
    let hasVerifiedRoute = false;
    const rejects = [];

    for (let i = 0; i < venues.length; i++) {
      for (let j = i + 1; j < venues.length; j++) {
        const a = venues[i], b = venues[j];
        const key = [a, b].sort().join('|');
        const result = verifyAssetIdentity(symbol, a, b);
        pairIdentityMatrix[symbol][key] = result;
        if (result.verified) hasVerifiedRoute = true;
        else rejects.push({ venues: [a, b], reason: result.reason, details: result });
      }
    }

    if (hasVerifiedRoute) strictlyVerifiedArbitragePairs.push(symbol);
    else identityRejectedPairs[symbol] = rejects;
  }

  try { await refreshBinanceVolumeRanking(true); } catch {}
  try { await refreshRealQuotes(); } catch {}
  try { await getSignalData('30m', true, STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT); } catch {}

  console.log(`🚀 Quant Hub V5.4 running on http://localhost:3000`);
  console.log(`   Eligible union: ${allEligiblePairs.length} | Binance signals: ${binanceSignalPairs.length} | Arbitrage quote candidates: ${arbitragePairs.length} | Strictly verified: ${strictlyVerifiedArbitragePairs.length}`);
  console.log(`   Identity mode: ${ARB_IDENTITY_MODE} | User-excluded bases: ${USER_EXCLUDED_BASES.size} | Strictly-unverified candidates: ${Object.keys(identityRejectedPairs).length}`);
}

io.on('connection', socket => {
  let currentTf = '30m';
  let currentStrategyProfile = STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
  socket.emit('load-wallet-state', persistentWalletState);

  getSignalData(currentTf, false, currentStrategyProfile).then(data => socket.emit('signals-update', data)).catch(() => {});
  socket.emit('global-scanner-update', { opportunities: buildArbitrageOpportunities(), rawTickers: globalTickersCache, source: 'REAL_QUOTES', status: { arbitragePairs: arbitragePairs.length, strictlyVerifiedPairs: strictlyVerifiedArbitragePairs.length, identityMode: ARB_IDENTITY_MODE, quoteStats: arbitrageQuoteStats, freshQuoteCounts: getFreshQuoteCounts() } });

  socket.on('sync-wallet-state', newState => {
    persistentWalletState = sanitizeWalletState(newState);
    saveWalletState();
  });

  socket.on('change-timeframe', async newTf => {
    currentTf = normalizeTimeframe(newTf);
    try { socket.emit('signals-update', await getSignalData(currentTf, true, currentStrategyProfile)); } catch {}
  });

  socket.on('change-strategy-profile', async newProfile => {
    if (Object.values(STRATEGY_PROFILES).includes(newProfile)) currentStrategyProfile = newProfile;
    try { socket.emit('signals-update', await getSignalData(currentTf, true, currentStrategyProfile)); } catch {}
  });

  const signalTimer = setInterval(async () => {
    try { socket.emit('signals-update', await getSignalData(currentTf, false, currentStrategyProfile)); } catch {}
  }, 15_000);

  const scannerTimer = setInterval(() => {
    socket.emit('global-scanner-update', { opportunities: buildArbitrageOpportunities(), rawTickers: globalTickersCache, source: 'REAL_QUOTES', status: { arbitragePairs: arbitragePairs.length, strictlyVerifiedPairs: strictlyVerifiedArbitragePairs.length, identityMode: ARB_IDENTITY_MODE, quoteStats: arbitrageQuoteStats, freshQuoteCounts: getFreshQuoteCounts() } });
  }, 3_000);

  socket.on('disconnect', () => { clearInterval(signalTimer); clearInterval(scannerTimer); });
});

setInterval(() => refreshRealQuotes().catch(() => {}), 8_000);

httpServer.listen(3000, async () => {
  await initializeServer();
});
