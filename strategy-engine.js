import { ATR, RSI, MACD, EMA, SMA, BollingerBands, Stochastic, ADX, CCI, MFI } from 'technicalindicators';

export function parseTimeframeMs(tfStr = '5m') {
  const s = String(tfStr).toLowerCase().trim();
  const map = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
    '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000,
    '1w': 604_800_000
  };
  return map[s] ?? 300_000;
}

export function normalizeTimeframe(tfStr = '5m') {
  const s = String(tfStr).toLowerCase().trim();
  const aliases = {
    '1 minute': '1m', '3 minutes': '3m', '5 minutes': '5m', '15 minutes': '15m',
    '30 minutes': '30m', '1 hour': '1h', '2 hours': '2h', '4 hours': '4h',
    '6 hours': '6h', '8 hours': '8h', '12 hours': '12h', '1 day': '1d',
    '3 days': '3d', '1 week': '1w'
  };
  return aliases[s] ?? s;
}


export const STRATEGY_PROFILES = Object.freeze({
  V3_BASELINE: 'V3_BASELINE',
  V4_REGIME_SPOT: 'V4_REGIME_SPOT',
  RESEARCH_SPOT: 'RESEARCH_SPOT',
  PULLBACK_SPOT: 'PULLBACK_SPOT',
  TREND_PULLBACK_SPOT: 'TREND_PULLBACK_SPOT',
  EXHAUSTION_SCALP_SPOT: 'EXHAUSTION_SCALP_SPOT',
  MOMENTUM_BREAKOUT_SPOT: 'MOMENTUM_BREAKOUT_SPOT',
  TIMEFRAME_EDGE_SPOT: 'TIMEFRAME_EDGE_SPOT'
});


export function recommendedStrategyForTimeframe(tf = '30m') {
  const t = normalizeTimeframe(tf);
  const map = {
    '1m':  { name: 'EXECUTION_ONLY_1M', label: 'Execution only / spread & fill timing', standalone: false },
    '3m':  { name: 'EXECUTION_ONLY_3M', label: 'Execution only / micro confirmation', standalone: false },
    '5m':  { name: 'ENTRY_TRIGGER_5M', label: 'Entry trigger / micro trend continuation', standalone: true },
    '15m': { name: 'TREND_PULLBACK_15M', label: 'Trend pullback + reclaim', standalone: true },
    '30m': { name: 'RECOVERY_REVERSAL_30M', label: 'Recovery reversal after exhaustion', standalone: true },
    '1h':  { name: 'CONTROLLED_TREND_1H', label: 'Controlled trend / pullback continuation', standalone: true },
    '2h':  { name: 'SWING_PULLBACK_2H', label: 'Swing pullback continuation', standalone: true },
    '4h':  { name: 'TREND_CONTINUATION_4H', label: 'Trend continuation', standalone: true },
    '6h':  { name: 'TREND_CONTINUATION_6H', label: 'Trend continuation / swing hold', standalone: true },
    '8h':  { name: 'SWING_CONTINUATION_8H', label: 'Swing trend continuation', standalone: true },
    '12h': { name: 'MACRO_PULLBACK_12H', label: 'Macro pullback continuation', standalone: true },
    '1d':  { name: 'MACRO_TREND_1D', label: 'Macro trend continuation', standalone: true },
    '3d':  { name: 'POSITION_TREND_3D', label: 'Position trend / major pullback', standalone: true },
    '1w':  { name: 'MACRO_REGIME_1W', label: 'Macro regime / position bias', standalone: true }
  };
  return map[t] || { name: 'TIMEFRAME_EDGE', label: 'Timeframe edge', standalone: true };
}

export function regimeTimeframeForTrade(tf = '30m') {
  const t = normalizeTimeframe(tf);
  if (['1m','3m','5m','15m','30m','1h'].includes(t)) return '4h';
  if (['2h','4h','6h','8h','12h'].includes(t)) return '1d';
  return '1d';
}

export function recommendedTargetForTimeframe(tf = '30m') {
  const t = normalizeTimeframe(tf);
  if (['1m','3m','5m','15m','30m'].includes(t)) return 'TP2';
  return 'TP3';
}

export function maxHoldMsForTimeframe(tf) {
  const tfMs = parseTimeframeMs(tf);
  // Time stop scales with timeframe instead of forcing every strategy into four hours.
  // Minimum 12 candles, maximum 48 candles.
  const candles = tfMs <= 300_000 ? 48 : tfMs <= 900_000 ? 32 : tfMs <= 3_600_000 ? 24 : 12;
  return candles * tfMs;
}

function last(arr, fallback = 0) {
  return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : fallback;
}

function middleDonchian(highs, lows, length) {
  if (!highs.length || !lows.length) return 0;
  const h = highs.slice(-length);
  const l = lows.slice(-length);
  return (Math.max(...h) + Math.min(...l)) / 2;
}

function calculateIchimoku(highs, lows, closes) {
  const tenkan = middleDonchian(highs, lows, 9);
  const kijun = middleDonchian(highs, lows, 26);
  const senkouB = middleDonchian(highs, lows, 52);
  const senkouA = (tenkan + kijun) / 2;
  const currentPrice = last(closes);
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  if (currentPrice > cloudTop) return { tenkan, kijun, senkouA, senkouB, status: 'Above Cloud (Bullish 🟩)', bias: 1 };
  if (currentPrice < cloudBottom) return { tenkan, kijun, senkouA, senkouB, status: 'Below Cloud (Bearish 🟥)', bias: -1 };
  return { tenkan, kijun, senkouA, senkouB, status: 'Neutral (Inside Cloud)', bias: 0 };
}

function calculateLinearRegression(closes, period = 14) {
  if (closes.length < period) return last(closes);
  const slice = closes.slice(-period);
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < period; i++) {
    sumX += i; sumY += slice[i]; sumXY += i * slice[i]; sumXX += i * i;
  }
  const denominator = period * sumXX - sumX * sumX;
  if (!denominator) return last(closes);
  const slope = (period * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / period;
  return slope * (period - 1) + intercept;
}

function calculateUTBot(high, low, close, keyvalue = 2, atrPeriod = 1) {
  const atrValues = ATR.calculate({ high, low, close, period: atrPeriod });
  let stopLoss = close[0] ?? 0;
  let position = 'short';
  for (let i = Math.max(1, atrPeriod); i < close.length; i++) {
    const atr = atrValues[Math.max(0, i - atrPeriod)] || 0;
    const nLoss = keyvalue * atr;
    const src = close[i];
    const prevSrc = close[i - 1];
    if (src > stopLoss && prevSrc > stopLoss) stopLoss = Math.max(stopLoss, src - nLoss);
    else if (src < stopLoss && prevSrc < stopLoss) stopLoss = Math.min(stopLoss, src + nLoss);
    else stopLoss = src > stopLoss ? src - nLoss : src + nLoss;
    position = src >= stopLoss ? 'long' : 'short';
  }
  return { position, stopLoss };
}

function calculateVPVR(ohlcv, numBins = 24) {
  if (!ohlcv.length) return { pocPrice: 0, vah: 0, val: 0 };
  const minPrice = Math.min(...ohlcv.map(c => c[3]));
  const maxPrice = Math.max(...ohlcv.map(c => c[2]));
  const range = maxPrice - minPrice;
  if (range <= 0) return { pocPrice: last(ohlcv)[4], vah: maxPrice, val: minPrice };
  const binSize = range / numBins;
  const bins = Array.from({ length: numBins }, (_, i) => ({ price: minPrice + (i + 0.5) * binSize, volume: 0 }));
  for (const c of ohlcv) {
    const avgPrice = (c[2] + c[3] + c[4]) / 3;
    const idx = Math.max(0, Math.min(numBins - 1, Math.floor((avgPrice - minPrice) / binSize)));
    bins[idx].volume += Number(c[5]) || 0;
  }
  let poc = bins[0];
  for (const b of bins) if (b.volume > poc.volume) poc = b;
  return { pocPrice: poc.price, vah: maxPrice, val: minPrice };
}

function calculateSupertrend(high, low, close, atrPeriod = 10, multiplier = 3) {
  const atrValues = ATR.calculate({ high, low, close, period: atrPeriod });
  if (!atrValues.length) return true;
  let finalUpper = 0, finalLower = 0;
  let trend = 1;
  for (let i = atrPeriod; i < close.length; i++) {
    const atr = atrValues[i - atrPeriod] || atrValues[atrValues.length - 1] || 0;
    const hl2 = (high[i] + low[i]) / 2;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;
    if (i === atrPeriod) {
      finalUpper = basicUpper; finalLower = basicLower;
    } else {
      finalUpper = (basicUpper < finalUpper || close[i - 1] > finalUpper) ? basicUpper : finalUpper;
      finalLower = (basicLower > finalLower || close[i - 1] < finalLower) ? basicLower : finalLower;
    }
    if (trend === -1 && close[i] > finalUpper) trend = 1;
    else if (trend === 1 && close[i] < finalLower) trend = -1;
  }
  return trend === 1;
}

function calculateVWAP(high, low, close, volume) {
  let cumulativeTPV = 0, cumulativeVolume = 0;
  for (let i = 0; i < close.length; i++) {
    const typicalPrice = (high[i] + low[i] + close[i]) / 3;
    const vol = Number(volume[i]) || 0;
    cumulativeTPV += typicalPrice * vol;
    cumulativeVolume += vol;
  }
  return cumulativeVolume ? cumulativeTPV / cumulativeVolume : last(close);
}

function detectMarketStructure(high, low, close) {
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < close.length - 2; i++) {
    if (high[i] > high[i-1] && high[i] > high[i-2] && high[i] > high[i+1] && high[i] > high[i+2]) swingHighs.push({ price: high[i], i });
    if (low[i] < low[i-1] && low[i] < low[i-2] && low[i] < low[i+1] && low[i] < low[i+2]) swingLows.push({ price: low[i], i });
  }
  const price = last(close);
  const recentHigh = swingHighs.length ? swingHighs[swingHighs.length - 1].price : Infinity;
  const recentLow = swingLows.length ? swingLows[swingLows.length - 1].price : -Infinity;
  if (price > recentHigh) return 'BOS (Bullish)';
  if (price < recentLow) return 'CHOCH (Bearish)';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const hh = swingHighs.at(-1).price > swingHighs.at(-2).price;
    const hl = swingLows.at(-1).price > swingLows.at(-2).price;
    if (hh && hl) return 'Bullish Structure';
    const lh = swingHighs.at(-1).price < swingHighs.at(-2).price;
    const ll = swingLows.at(-1).price < swingLows.at(-2).price;
    if (lh && ll) return 'Bearish Structure';
  }
  return 'CHOP (Ranging)';
}

function calculatePercentR(high, low, close, period) {
  const out = [];
  for (let i = period - 1; i < close.length; i++) {
    const maxH = Math.max(...high.slice(i - period + 1, i + 1));
    const minL = Math.min(...low.slice(i - period + 1, i + 1));
    out.push(maxH === minL ? -50 : 100 * (close[i] - maxH) / (maxH - minL));
  }
  return out;
}

function calculatePercentRExhaustion(high, low, close) {
  if (close.length < 114) return { status: 'Neutral', score: 0 };
  const s = calculatePercentR(high, low, close, 21);
  const l = calculatePercentR(high, low, close, 112);
  const sCurr = s.at(-1), sPrev = s.at(-2), lCurr = l.at(-1), lPrev = l.at(-2);
  const ob = sCurr >= -20 && lCurr >= -20, prevOb = sPrev >= -20 && lPrev >= -20;
  const os = sCurr <= -80 && lCurr <= -80, prevOs = sPrev <= -80 && lPrev <= -80;
  if (!os && prevOs) return { status: 'OS Reversal (Bull) ▲', score: 1 };
  if (!ob && prevOb) return { status: 'OB Reversal (Bear) ▼', score: -1 };
  if (os) return { status: 'Oversold Warning ■', score: 0.5 };
  if (ob) return { status: 'Overbought Warning ■', score: -0.5 };
  return { status: 'Neutral', score: 0 };
}


export function analyzeSpotRegime(ohlcv, options = {}) {
  if (!Array.isArray(ohlcv) || ohlcv.length < 80) {
    return { label: 'UNKNOWN', score: 0, allowLong: false, strongLong: false, reason: 'Not enough benchmark history' };
  }
  const data = ohlcv.slice(-260);
  const open = data.map(c => Number(c[1]));
  const high = data.map(c => Number(c[2]));
  const low = data.map(c => Number(c[3]));
  const close = data.map(c => Number(c[4]));
  const currentPrice = last(close);
  const ema20 = last(EMA.calculate({ values: close, period: 20 }), currentPrice);
  const ema50 = last(EMA.calculate({ values: close, period: 50 }), currentPrice);
  const ema200Arr = EMA.calculate({ values: close, period: 200 });
  const ema200 = last(ema200Arr, ema50);
  const rsi = last(RSI.calculate({ values: close, period: 14 }), 50);
  const adx = last(ADX.calculate({ high, low, close, period: 14 }), { adx: 20, pdi: 0, mdi: 0 });
  const atr = last(ATR.calculate({ high, low, close, period: 14 }), currentPrice * 0.01);
  const structure = detectMarketStructure(high, low, close);
  const atrPct = currentPrice ? (atr / currentPrice) * 100 : 0;

  let score = 0;
  score += currentPrice > ema50 ? 1.5 : -1.5;
  score += ema20 > ema50 ? 1.5 : -1.5;
  if (ema200Arr.length) score += ema50 > ema200 ? 1.5 : -1.5;
  score += rsi >= 52 ? 0.75 : rsi < 45 ? -0.75 : 0;
  score += Number(adx.pdi || 0) > Number(adx.mdi || 0) ? 0.75 : -0.75;
  if (structure.includes('Bullish') || structure.includes('BOS')) score += 1.0;
  if (structure.includes('Bearish') || structure.includes('CHOCH')) score -= 1.0;

  let label = 'RANGE';
  if (score >= 4.5) label = 'BULL';
  else if (score >= 2.0) label = 'WEAK_BULL';
  else if (score <= -4.0) label = 'BEAR';
  else if (score <= -2.0) label = 'WEAK_BEAR';

  const allowLong = label === 'BULL' || label === 'WEAK_BULL';
  const strongLong = label === 'BULL' && Number(adx.adx || 0) >= 20;
  return {
    label,
    score: Number(score.toFixed(2)),
    allowLong,
    strongLong,
    reason: allowLong ? 'Benchmark regime permits spot longs' : 'Cash / no new spot longs',
    price: currentPrice,
    ema20, ema50, ema200,
    rsi: Number(rsi.toFixed(2)),
    adx: Number(Number(adx.adx || 0).toFixed(2)),
    pdi: Number(Number(adx.pdi || 0).toFixed(2)),
    mdi: Number(Number(adx.mdi || 0).toFixed(2)),
    atrPct: Number(atrPct.toFixed(3)),
    structure
  };
}

export function analyzeMarket(ohlcv, options = {}) {
  const minCandles = options.minCandles ?? 60;
  if (!Array.isArray(ohlcv) || ohlcv.length < minCandles) return null;
  const data = ohlcv.slice(-Math.max(120, minCandles));
  const open = data.map(c => Number(c[1]));
  const high = data.map(c => Number(c[2]));
  const low = data.map(c => Number(c[3]));
  const close = data.map(c => Number(c[4]));
  const volume = data.map(c => Number(c[5]) || 0);
  const currentPrice = last(close);

  const atr = last(ATR.calculate({ high, low, close, period: 14 }), currentPrice * 0.01);
  const rsiSeries = RSI.calculate({ values: close, period: 14 });
  const rsi = last(rsiSeries, 50);
  const rsiPrev1 = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : rsi;
  const rsiPrev2 = rsiSeries.length > 2 ? rsiSeries[rsiSeries.length - 3] : rsiPrev1;
  const macdSeries = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const macd = last(macdSeries, { histogram: 0 });
  const macdPrev = macdSeries.length > 1 ? macdSeries[macdSeries.length - 2] : macd;
  const ema9Series = EMA.calculate({ values: close, period: 9 });
  const ema21Series = EMA.calculate({ values: close, period: 21 });
  const ema50Series = EMA.calculate({ values: close, period: 50 });
  const ema9 = last(ema9Series, currentPrice);
  const ema21 = last(ema21Series, currentPrice);
  const ema50 = last(ema50Series, currentPrice);
  const ema21Prev1 = ema21Series.length > 1 ? ema21Series[ema21Series.length - 2] : ema21;
  const ema21Prev3 = ema21Series.length > 3 ? ema21Series[ema21Series.length - 4] : ema21;
  const sma20 = last(SMA.calculate({ values: close, period: 20 }), currentPrice);
  const sma50 = last(SMA.calculate({ values: close, period: 50 }), currentPrice);
  const bb = last(BollingerBands.calculate({ period: 20, stdDev: 2, values: close }), { upper: currentPrice, middle: currentPrice, lower: currentPrice });
  const stochSeries = Stochastic.calculate({ high, low, close, period: 14, signalPeriod: 3 });
  const stoch = last(stochSeries, { k: 50, d: 50 });
  const stochPrev = stochSeries.length > 1 ? stochSeries[stochSeries.length - 2] : stoch;
  const adx = last(ADX.calculate({ high, low, close, period: 14 }), { adx: 20, pdi: 0, mdi: 0 });
  const cci = last(CCI.calculate({ high, low, close, period: 20 }), 0);
  const mfi = last(MFI.calculate({ high, low, close, volume, period: 14 }), 50);
  const vwap = calculateVWAP(high, low, close, volume);
  const prevClose = close.length > 1 ? close.at(-2) : currentPrice;
  const prevVwap = close.length > 1 ? calculateVWAP(high.slice(0, -1), low.slice(0, -1), close.slice(0, -1), volume.slice(0, -1)) : vwap;
  const vpvr = calculateVPVR(data);
  const ichimoku = calculateIchimoku(high, low, close);
  const supertrendBullish = calculateSupertrend(high, low, close);
  const structure = detectMarketStructure(high, low, close);
  const prevStructure = close.length > 6 ? detectMarketStructure(high.slice(0, -1), low.slice(0, -1), close.slice(0, -1)) : structure;
  const linReg = calculateLinearRegression(close, 14);
  const utBot = calculateUTBot(high, low, close, 2, 1);
  const percentR = calculatePercentRExhaustion(high, low, close);
  const williams14Series = calculatePercentR(high, low, close, 14);
  const williams14 = last(williams14Series, -50);
  const williams14Prev = williams14Series.length > 1 ? williams14Series[williams14Series.length - 2] : williams14;

  const isMacdBullish = Number(macd.histogram || 0) > 0;
  const isEmaUptrend = ema9 > ema21;
  const isGoldenCross = sma20 > sma50;
  const isAboveVWAP = currentPrice > vwap;
  const isLinRegBullish = currentPrice > linReg;
  const isUTBotBuy = utBot.position === 'long';
  const isStructureBullish = structure.includes('Bullish') || structure.includes('BOS');
  const isStructureBearish = structure.includes('Bearish') || structure.includes('CHOCH');

  // V5 pullback/location features. These intentionally describe WHERE the entry is
  // inside the trend rather than simply counting how many indicators are green.
  const recentHigh20 = Math.max(...high.slice(-20));
  const priorHigh20 = high.length > 20 ? Math.max(...high.slice(-21, -1)) : Math.max(...high.slice(0, -1));
  const recentLow20 = Math.min(...low.slice(-20));
  const recentHighIndex = high.slice(-20).lastIndexOf(recentHigh20);
  const barsSinceLocalHigh = recentHighIndex >= 0 ? 19 - recentHighIndex : 0;
  const pullbackDepthPct = recentHigh20 ? ((recentHigh20 - currentPrice) / recentHigh20) * 100 : 0;
  const distanceEma21Pct = ema21 ? ((currentPrice - ema21) / ema21) * 100 : 0;
  const distanceEma50Pct = ema50 ? ((currentPrice - ema50) / ema50) * 100 : 0;
  const distanceVwapPct = vwap ? ((currentPrice - vwap) / vwap) * 100 : 0;
  const distanceRecentHighPct = recentHigh20 ? ((currentPrice - recentHigh20) / recentHigh20) * 100 : 0;
  const distanceRecentLowPct = recentLow20 ? ((currentPrice - recentLow20) / recentLow20) * 100 : 0;
  const ema21SlopePct3 = ema21Prev3 ? ((ema21 - ema21Prev3) / ema21Prev3) * 100 : 0;
  const rsiDelta1 = Number(rsi) - Number(rsiPrev1);
  const rsiDelta2 = Number(rsiPrev1) - Number(rsiPrev2);
  const macdHistogram = Number(macd.histogram || 0);
  const macdHistogramPrev = Number(macdPrev?.histogram || 0);
  const macdHistogramDelta = macdHistogram - macdHistogramPrev;
  const currentOpen = last(open, currentPrice);
  const bullishCandle = currentPrice > currentOpen;
  const prevReturn1Pct = close.length > 1 && close.at(-2) ? ((close.at(-1) - close.at(-2)) / close.at(-2)) * 100 : 0;
  const prevReturn2Pct = close.length > 2 && close.at(-3) ? ((close.at(-2) - close.at(-3)) / close.at(-3)) * 100 : 0;
  const prevReturn3Pct = close.length > 3 && close.at(-4) ? ((close.at(-3) - close.at(-4)) / close.at(-4)) * 100 : 0;
  const roc9Pct = close.length > 9 && close.at(-10) ? ((currentPrice - close.at(-10)) / close.at(-10)) * 100 : 0;
  const recentThreeLow = Math.min(...low.slice(-3));
  const touchedEma21Recently = recentThreeLow <= ema21 * 1.012;
  const touchedVwapRecently = recentThreeLow <= vwap * 1.012;
  const ema21DistanceAtr = atr > 0 ? Math.abs(currentPrice - ema21) / atr : Infinity;
  const vwapDistanceAtr = atr > 0 ? Math.abs(currentPrice - vwap) / atr : Infinity;
  const recentHighDistanceAtr = atr > 0 ? Math.abs(currentPrice - recentHigh20) / atr : Infinity;
  const breakoutAbovePriorHighAtr = atr > 0 && Number.isFinite(priorHigh20) ? (currentPrice - priorHigh20) / atr : 0;
  const priceNearEma21 = ema21DistanceAtr <= 1.10;
  const priceNearVwap = vwapDistanceAtr <= 1.10;
  const recentRetestEma21 = touchedEma21Recently && ema21DistanceAtr <= 1.60;
  const recentRetestVwap = touchedVwapRecently && vwapDistanceAtr <= 1.60;

  // V5.2 oversold/exhaustion features. Unlike trend-following logic, bearish short-term
  // MACD/EMA/VWAP conditions are allowed here: they can be evidence of the dip itself.
  const bbRange = Math.max(bb.upper - bb.lower, currentPrice * 0.000001);
  const bbPosition = Math.max(-0.5, Math.min(1.5, (currentPrice - bb.lower) / bbRange));
  const stochRising = Number(stoch.k || 0) > Number(stochPrev.k || 0);
  const williamsRising = Number(williams14) > Number(williams14Prev);
  const lastBodyPctAtr = atr > 0 ? Math.abs(currentPrice - currentOpen) / atr : 0;
  const lastBearishBody = currentPrice < currentOpen;
  const recent3ReturnPct = prevReturn1Pct + prevReturn2Pct + prevReturn3Pct;
  const belowLowerBandAtr = atr > 0 && currentPrice < bb.lower ? (bb.lower - currentPrice) / atr : 0;

  // Shared participation/volatility values must be initialized before the
  // exhaustion model uses them. Keeping these here avoids JS temporal-dead-zone
  // errors when EXHAUSTION_SCALP_SPOT is evaluated.
  const recentVolumes = volume.slice(-20);
  const avgVolume20 = recentVolumes.length ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 0;
  const relativeVolume = avgVolume20 ? last(volume) / avgVolume20 : 1;
  const adxValue = Number(adx.adx || 0);
  const bbWidthPct = bb.middle ? ((bb.upper - bb.lower) / bb.middle) * 100 : 0;
  const atrPct = currentPrice ? (atr / currentPrice) * 100 : 0;

  let exhaustionScore = 0;
  if (Number(stoch.k) < 20) exhaustionScore += 1.0;
  if (Number(stoch.k) < 10) exhaustionScore += 0.35;
  if (williams14 < -80) exhaustionScore += 1.0;
  if (williams14 < -90) exhaustionScore += 0.35;
  if (Number(cci) < -100) exhaustionScore += 0.9;
  if (Number(cci) < -200) exhaustionScore += 0.35;
  if (Number(mfi) < 25) exhaustionScore += 0.9;
  if (Number(mfi) < 15) exhaustionScore += 0.35;
  if (rsi < 38) exhaustionScore += 0.8;
  if (rsi < 32) exhaustionScore += 0.35;
  if (bbPosition <= 0.15) exhaustionScore += 0.9;
  if (currentPrice <= bb.lower) exhaustionScore += 0.35;
  if (sma20 >= sma50) exhaustionScore += 0.65;
  if (adxValue >= 25) exhaustionScore += 0.35;
  if (stochRising) exhaustionScore += 0.35;
  if (williamsRising) exhaustionScore += 0.25;

  let breakdownPenalty = 0;
  if (isStructureBearish) breakdownPenalty -= 1.75;
  if (lastBearishBody && lastBodyPctAtr >= 1.5) breakdownPenalty -= 1.0;
  if (relativeVolume > 4 && lastBearishBody) breakdownPenalty -= 1.0;
  if (recent3ReturnPct < -Math.max(3.0, atrPct * 2.5)) breakdownPenalty -= 0.8;
  if (belowLowerBandAtr > 0.75) breakdownPenalty -= 0.8;
  if (distanceEma50Pct < -6) breakdownPenalty -= 0.8;
  if (atrPct > 10 || bbWidthPct > 26) breakdownPenalty -= 1.0;
  breakdownPenalty = Math.max(-4, breakdownPenalty);

  const exhaustionTotalScore = exhaustionScore + breakdownPenalty;

  // Exact V3 control-group scoring retained for apples-to-apples historical comparison.
  let v3TrendScore = 0;
  v3TrendScore += isEmaUptrend ? 0.8 : -0.8;
  v3TrendScore += supertrendBullish ? 0.8 : -0.8;
  v3TrendScore += ichimoku.bias * 0.8;
  v3TrendScore += isGoldenCross ? 0.6 : -0.3;
  v3TrendScore = Math.max(-3, Math.min(3, v3TrendScore));

  let v3MomentumScore = 0;
  v3MomentumScore += isMacdBullish ? 0.8 : -0.8;
  if (rsi >= 50 && rsi <= 68) v3MomentumScore += 0.7;
  else if (rsi >= 72) v3MomentumScore -= 0.8;
  else if (rsi < 35) v3MomentumScore += 0.25;
  if (stoch.k < 20) v3MomentumScore += 0.4;
  if (stoch.k > 85) v3MomentumScore -= 0.4;
  v3MomentumScore += percentR.score * 0.35;
  v3MomentumScore = Math.max(-2, Math.min(2, v3MomentumScore));

  let v3StructureScore = 0;
  if (isStructureBullish) v3StructureScore += 1.2;
  if (isStructureBearish) v3StructureScore -= 1.2;
  v3StructureScore += isLinRegBullish ? 0.4 : -0.4;
  v3StructureScore += isUTBotBuy ? 0.4 : -0.4;
  v3StructureScore = Math.max(-2, Math.min(2, v3StructureScore));

  let v3ParticipationScore = 0;
  v3ParticipationScore += isAboveVWAP ? 0.7 : -0.5;
  if (mfi >= 45 && mfi <= 75) v3ParticipationScore += 0.4;
  else if (mfi >= 85) v3ParticipationScore -= 0.4;
  if (Number(adx.adx || 0) >= 25) v3ParticipationScore += 0.5;
  v3ParticipationScore = Math.max(-1.5, Math.min(1.5, v3ParticipationScore));

  // Score indicator families, then apply a separate spot-only V4 eligibility layer.
  // The V4 rules are based on the first 7,750-trade research pass: ADX/trend quality
  // mattered more than raw vote count, while TP1 and very short-term entries were weak.
  let trendScore = 0;
  trendScore += isEmaUptrend ? 0.9 : -0.9;
  trendScore += supertrendBullish ? 0.7 : -0.7;
  trendScore += ichimoku.bias * 0.45; // reduced weight: research did not justify a large independent vote
  trendScore += isGoldenCross ? 0.65 : -0.35;
  trendScore = Math.max(-3, Math.min(3, trendScore));

  let momentumScore = 0;
  momentumScore += isMacdBullish ? 0.35 : -0.35; // deliberately de-emphasized
  if (rsi >= 48 && rsi <= 67) momentumScore += 0.75;
  else if (rsi >= 72) momentumScore -= 0.9;
  else if (rsi < 35) momentumScore += 0.15;
  if (stoch.k < 20) momentumScore += 0.3;
  if (stoch.k > 88) momentumScore -= 0.45;
  momentumScore += percentR.score * 0.25;
  momentumScore = Math.max(-2, Math.min(2, momentumScore));

  let structureScore = 0;
  if (structure === 'Bullish Structure') structureScore += 1.35;
  else if (structure.includes('BOS')) structureScore += 0.85;
  if (isStructureBearish) structureScore -= 1.5;
  structureScore += isLinRegBullish ? 0.35 : -0.35;
  structureScore += isUTBotBuy ? 0.3 : -0.3;
  structureScore = Math.max(-2, Math.min(2, structureScore));

  let participationScore = 0;
  participationScore += isAboveVWAP ? 0.35 : -0.25;
  if (mfi >= 45 && mfi <= 75) participationScore += 0.3;
  else if (mfi >= 85) participationScore -= 0.35;
  if (adxValue >= 40) participationScore += 0.9;
  else if (adxValue >= 30) participationScore += 0.55;
  else if (adxValue < 20) participationScore -= 0.45;
  if (relativeVolume >= 0.8 && relativeVolume <= 3.0) participationScore += 0.25;
  if (relativeVolume < 0.45) participationScore -= 0.35;
  participationScore = Math.max(-1.5, Math.min(1.5, participationScore));

  let volatilityScore = 0;
  if (bbWidthPct >= 1 && bbWidthPct <= 9) volatilityScore += 0.45;
  if (bbWidthPct > 14 || atrPct > 8) volatilityScore -= 0.5;
  volatilityScore = Math.max(-0.5, Math.min(0.5, volatilityScore));

  let v3VolatilityScore = 0;
  if (bbWidthPct >= 1 && bbWidthPct <= 8) v3VolatilityScore += 0.5;
  if (bbWidthPct > 12) v3VolatilityScore -= 0.3;
  v3VolatilityScore = Math.max(-0.5, Math.min(0.5, v3VolatilityScore));

  // V5 Spot Trend Pullback model. Trend establishes direction; pullback quality
  // measures entry location; confirmation checks that the retracement is starting to turn up.
  let pullbackTrendScore = 0;
  if (ema21 > ema50) pullbackTrendScore += 0.9;
  if (currentPrice > ema50) pullbackTrendScore += 0.55;
  if (ema21SlopePct3 > 0) pullbackTrendScore += 0.55;
  pullbackTrendScore = Math.max(0, Math.min(2, pullbackTrendScore));

  let pullbackQualityScore = 0;
  if (pullbackDepthPct >= 0.8 && pullbackDepthPct <= 8) pullbackQualityScore += 1.0;
  else if (pullbackDepthPct > 0.2 && pullbackDepthPct < 0.8) pullbackQualityScore += 0.35;
  if (priceNearEma21 || priceNearVwap) pullbackQualityScore += 0.8;
  if (touchedEma21Recently || touchedVwapRecently) pullbackQualityScore += 0.65;
  if (rsiPrev1 >= 38 && rsiPrev1 <= 60) pullbackQualityScore += 0.55;
  pullbackQualityScore = Math.max(0, Math.min(3, pullbackQualityScore));

  let reversalConfirmationScore = 0;
  if (rsiDelta1 > 0) reversalConfirmationScore += 0.85;
  if (rsiDelta1 > 0 && rsiDelta2 <= 0) reversalConfirmationScore += 0.45;
  if (macdHistogramDelta > 0) reversalConfirmationScore += 0.65;
  if (currentPrice > ema9) reversalConfirmationScore += 0.55;
  if (bullishCandle) reversalConfirmationScore += 0.5;
  reversalConfirmationScore = Math.max(0, Math.min(3, reversalConfirmationScore));

  let pullbackParticipationScore = 0;
  if (relativeVolume >= 0.9 && relativeVolume <= 2.5) pullbackParticipationScore += 1.0;
  else if (relativeVolume >= 0.7 && relativeVolume < 0.9) pullbackParticipationScore += 0.35;
  if (mfi >= 40 && mfi <= 78) pullbackParticipationScore += 0.5;
  if (isAboveVWAP || distanceVwapPct > -1.0) pullbackParticipationScore += 0.5;
  pullbackParticipationScore = Math.max(0, Math.min(2, pullbackParticipationScore));

  let extensionPenalty = 0;
  if (distanceEma21Pct > 3 || (atr > 0 && (currentPrice - ema21) / atr > 2.0)) extensionPenalty -= 1.5;
  if (vwapDistanceAtr > 2.0 && currentPrice > vwap) extensionPenalty -= 2.0;
  if (bbPosition > 1.0) extensionPenalty -= 2.0;
  if (Number(cci) > 150) extensionPenalty -= 1.0;
  if (barsSinceLocalHigh <= 1 && distanceRecentHighPct > -0.5) extensionPenalty -= 1.0;
  if (rsi > 68) extensionPenalty -= 1.25;
  if (relativeVolume > 3.5) extensionPenalty -= 1.0;
  if (isStructureBearish) extensionPenalty -= 2.0;
  if (atrPct > 8 || bbWidthPct > 18) extensionPenalty -= 1.0;
  extensionPenalty = Math.max(-6, extensionPenalty);

  const pullbackTotalScore = pullbackTrendScore + pullbackQualityScore + reversalConfirmationScore + pullbackParticipationScore + extensionPenalty;

  // Separate momentum-breakout model. A breakout can be a valid setup, but it must never
  // be mislabeled as a pullback. This model requires a fresh break of the prior 20-bar high,
  // trend strength, participation and momentum without extreme extension.
  let breakoutScore = 0;
  if (ema21 > ema50 && ema21SlopePct3 > 0) breakoutScore += 1.5;
  if (currentPrice > priorHigh20 && breakoutAbovePriorHighAtr >= 0) breakoutScore += 1.5;
  if (adxValue >= 22) breakoutScore += 1.0;
  if (Number(adx.pdi || 0) > Number(adx.mdi || 0)) breakoutScore += 0.6;
  if (macdHistogramDelta > 0) breakoutScore += 0.7;
  if (bullishCandle) breakoutScore += 0.4;
  if (relativeVolume >= 1.0 && relativeVolume <= 3.5) breakoutScore += 0.8;
  if (rsi >= 52 && rsi <= 70) breakoutScore += 0.5;
  if (isStructureBearish) breakoutScore -= 2.5;
  if (bbPosition > 1.20 || rsi > 74 || Number(stoch.k) > 88) breakoutScore -= 1.5;
  breakoutScore = Math.max(-4, Math.min(8, breakoutScore));

  const v4TotalScore = trendScore + momentumScore + structureScore + participationScore + volatilityScore;
  const v3TotalScore = v3TrendScore + v3MomentumScore + v3StructureScore + v3ParticipationScore + v3VolatilityScore;
  const profile = options.profile || STRATEGY_PROFILES.TREND_PULLBACK_SPOT;
  const useBaselineScoring = profile === STRATEGY_PROFILES.V3_BASELINE || profile === STRATEGY_PROFILES.RESEARCH_SPOT;
  const usePullbackScoring = profile === STRATEGY_PROFILES.PULLBACK_SPOT || profile === STRATEGY_PROFILES.TREND_PULLBACK_SPOT;
  const useExhaustionScoring = profile === STRATEGY_PROFILES.EXHAUSTION_SCALP_SPOT;
  const useBreakoutScoring = profile === STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT;
  const useTimeframeEdgeScoring = profile === STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT;
  const selectedTrendScore = useBreakoutScoring ? Math.min(2, breakoutScore) : (useExhaustionScoring ? Math.max(0, isGoldenCross ? 1 : 0) : (usePullbackScoring ? pullbackTrendScore : (useBaselineScoring ? v3TrendScore : trendScore)));
  const selectedMomentumScore = useBreakoutScoring ? (macdHistogramDelta > 0 ? 1 : 0) + (bullishCandle ? 0.5 : 0) : (useExhaustionScoring ? exhaustionScore : (usePullbackScoring ? reversalConfirmationScore : (useBaselineScoring ? v3MomentumScore : momentumScore)));
  const selectedStructureScore = useBreakoutScoring ? (isStructureBearish ? -1.5 : (structure === 'CHOP (Ranging)' ? 0 : 1)) : (useExhaustionScoring ? (isStructureBearish ? -1 : 0.5) : (usePullbackScoring ? pullbackQualityScore : (useBaselineScoring ? v3StructureScore : structureScore)));
  const selectedParticipationScore = useBreakoutScoring ? (relativeVolume >= 1 && relativeVolume <= 3.5 ? 1 : 0) : (useExhaustionScoring ? (relativeVolume >= 0.6 && relativeVolume <= 3.5 ? 0.75 : 0) : (usePullbackScoring ? pullbackParticipationScore : (useBaselineScoring ? v3ParticipationScore : participationScore)));
  const selectedVolatilityScore = useBreakoutScoring ? (bbPosition <= 1.2 ? 0.5 : -1) : (useExhaustionScoring ? breakdownPenalty : (usePullbackScoring ? extensionPenalty : (useBaselineScoring ? v3VolatilityScore : volatilityScore)));
  const totalScore = useTimeframeEdgeScoring ? 0 : (useBreakoutScoring ? breakoutScore : (useExhaustionScoring ? exhaustionTotalScore : (usePullbackScoring ? pullbackTotalScore : (useBaselineScoring ? v3TotalScore : v4TotalScore))));
  const timeframe = normalizeTimeframe(options.timeframe || '30m');
  const regime = options.regime || { label: 'UNKNOWN', score: 0, allowLong: false, strongLong: false };

  const rejectionReasons = [];
  if (['1m', '3m', '5m'].includes(timeframe)) rejectionReasons.push('Very-short timeframe disabled in V4 auto spot profile');
  if (!regime.allowLong) rejectionReasons.push(`BTC regime is ${regime.label || 'UNKNOWN'} — stay in cash`);
  if (adxValue < 30) rejectionReasons.push('ADX below 30');
  if (trendScore < 0.8) rejectionReasons.push('Trend family below 0.8');
  if (structureScore < 0.35) rejectionReasons.push('Structure family below 0.35');
  if (isStructureBearish) rejectionReasons.push('Bearish/CHOCH market structure');
  if (rsi < 38 || rsi > 70) rejectionReasons.push('RSI outside V4 entry band');
  if (relativeVolume < 0.45) rejectionReasons.push('Very weak relative volume');
  if (atrPct > 8 || bbWidthPct > 18) rejectionReasons.push('Extreme volatility');

  const weakBullExtraPass = regime.label !== 'WEAK_BULL' || (adxValue >= 40 && trendScore >= 1.4 && structureScore >= 0.8);
  if (!weakBullExtraPass) rejectionReasons.push('Weak-bull regime requires stronger coin confirmation');

  const v4Qualified = rejectionReasons.length === 0;
  const v4Strong = v4Qualified && regime.label === 'BULL' && adxValue >= 40 && trendScore >= 1.5 && structureScore >= 0.8 && totalScore >= 3.8;

  const pullbackRejectionReasons = [];
  const trendGate = ema21 > ema50 && currentPrice > ema50 && ema21SlopePct3 > 0 && adxValue >= 22;
  const structureGate = !isStructureBearish && structure !== 'CHOP (Ranging)';
  const locationGate = priceNearEma21 || priceNearVwap || recentRetestEma21 || recentRetestVwap;
  const freshPullbackGate = pullbackDepthPct >= 0.6 && barsSinceLocalHigh >= 2;
  const extensionGate = bbPosition <= 1.0 && !(Number(cci) > 150) && !(vwapDistanceAtr > 2.0 && currentPrice > vwap);
  const oscillatorGate = Number(stoch.k) <= 72 && rsi <= 68;

  if (!trendGate) pullbackRejectionReasons.push('Trend gate failed (EMA21>EMA50, price>EMA50, rising EMA21, ADX>=22 required)');
  if (!structureGate) pullbackRejectionReasons.push('Structure gate failed — CHOP/bearish structure is not a trend pullback');
  if (!locationGate) pullbackRejectionReasons.push('Location gate failed — not close enough to EMA21/VWAP support');
  if (!freshPullbackGate) pullbackRejectionReasons.push('No real pullback — too close to the local high or pullback too shallow');
  if (!extensionGate) pullbackRejectionReasons.push('Entry is extended (upper Bollinger / CCI / VWAP distance)');
  if (reversalConfirmationScore < 1.35) pullbackRejectionReasons.push('Pullback has not confirmed an upward turn');
  if (relativeVolume < 0.65) pullbackRejectionReasons.push('Relative volume too weak');
  if (relativeVolume > 3.5) pullbackRejectionReasons.push('Relative volume spike too extreme');
  if (!oscillatorGate) pullbackRejectionReasons.push('Oscillator overextended — not a pullback entry');
  if (atrPct > 10 || bbWidthPct > 24) pullbackRejectionReasons.push('Extreme volatility');
  const exhaustionRejectionReasons = [];
  if (exhaustionScore < 4.0) exhaustionRejectionReasons.push('Not enough oversold/exhaustion confluence');
  if (Number(stoch.k) >= 35) exhaustionRejectionReasons.push('Stochastic not sufficiently cooled');
  if (williams14 >= -65) exhaustionRejectionReasons.push('Williams %R not sufficiently oversold');
  if (bbPosition > 0.45) exhaustionRejectionReasons.push('Price not near lower Bollinger region');
  if (relativeVolume < 0.45) exhaustionRejectionReasons.push('Relative volume too weak');
  if (relativeVolume > 5.0) exhaustionRejectionReasons.push('Extreme volume spike / liquidation risk');
  if (breakdownPenalty <= -2.5) exhaustionRejectionReasons.push('Accelerating breakdown risk too high');
  if (!isGoldenCross && currentPrice < ema50) exhaustionRejectionReasons.push('Broader structure too weak for exhaustion buy');
  if (atrPct > 12 || bbWidthPct > 30) exhaustionRejectionReasons.push('Extreme volatility');

  const breakoutRejectionReasons = [];
  if (!(ema21 > ema50 && ema21SlopePct3 > 0 && currentPrice > ema50 && adxValue >= 22)) breakoutRejectionReasons.push('Breakout trend gate failed');
  if (isStructureBearish || structure === 'CHOP (Ranging)') breakoutRejectionReasons.push('Breakout structure gate failed');
  if (!(currentPrice > priorHigh20)) breakoutRejectionReasons.push('No fresh break above prior 20-bar high');
  if (!(relativeVolume >= 1.0 && relativeVolume <= 3.5)) breakoutRejectionReasons.push('Breakout volume confirmation failed');
  if (!((macdHistogramDelta > 0 || bullishCandle) && rsi >= 52 && rsi <= 72)) breakoutRejectionReasons.push('Breakout momentum confirmation failed');
  if (!(bbPosition <= 1.20 && rsi <= 74 && Number(stoch.k) <= 88 && vwapDistanceAtr <= 3.0)) breakoutRejectionReasons.push('Breakout too extended');

  // V5.4 timeframe-specific edge model. The same indicator should not mean the same
  // thing on every timeframe. These broad gates come from the research batches and are
  // intentionally rounded so the model is not fitted to one short sample.
  const edgeRejectionReasons = [];
  let edgeSetupType = 'TIMEFRAME_EDGE';
  let edgeQualityScore = 0;
  let edgeQualified = false;
  let edgeStrong = false;
  const selloffDecelerating = prevReturn1Pct > prevReturn2Pct || rsiDelta1 > -0.5 || macdHistogramDelta > 0;
  const shortReversalConfirmations = [stochRising, williamsRising, macdHistogramDelta > 0, bullishCandle, selloffDecelerating].filter(Boolean).length;

  // V5.15 recovery-state features. Oversold/CHOCH is a setup state, not an entry.
  // A 30m long must show that price has actually reclaimed something meaningful.
  const reclaimedVwap = Number.isFinite(prevVwap) && prevClose <= prevVwap && currentPrice > vwap;
  const reclaimedEma21 = prevClose <= ema21Prev1 && currentPrice > ema21;
  const bullishStructureNow = /bullish structure|bos \(bullish\)/i.test(structure);
  const bearishTransitionBefore = /choch|bearish structure/i.test(prevStructure);
  const structureRecovered = bearishTransitionBefore && bullishStructureNow;
  const holdsAboveVwap = isAboveVWAP && prevClose > prevVwap;
  const momentumTurnedUp = macdHistogramDelta > 0 && rsiDelta1 > 0;
  const recoveryConfirmationCount = [reclaimedVwap, reclaimedEma21, structureRecovered, holdsAboveVwap, momentumTurnedUp].filter(Boolean).length;
  let recoveryStage = 'EXHAUSTED / WATCH';

  const timeframeStrategy = recommendedStrategyForTimeframe(timeframe);

  if (timeframe === '1m' || timeframe === '3m') {
    edgeSetupType = timeframeStrategy.name;
    recoveryStage = 'EXECUTION ONLY';
    edgeRejectionReasons.push(`${timeframe} is execution-only: use it to improve fill timing after a higher-timeframe setup, not to create a standalone position`);
  } else if (timeframe === '5m') {
    edgeSetupType = 'ENTRY_TRIGGER_5M';
    const trendOk = ema9 > ema21 && ema21 >= ema50 * 0.995 && ema21SlopePct3 >= -0.15;
    const structureOk = !isStructureBearish && structure !== 'CHOP (Ranging)';
    const locationOk = currentPrice >= vwap || reclaimedVwap || reclaimedEma21 || priceNearVwap || priceNearEma21;
    const triggerOk = reclaimedVwap || reclaimedEma21 || (momentumTurnedUp && bullishCandle) || (macdHistogramDelta > 0 && currentPrice > ema9);
    const participationOk = relativeVolume >= 0.65 && relativeVolume <= 4.5;
    const extensionOk = rsi >= 38 && rsi <= 72 && Number(stoch.k) <= 86 && bbPosition <= 1.10 && recent3ReturnPct <= 2.2;
    if (!trendOk) edgeRejectionReasons.push('5m micro trend is not aligned');
    if (!structureOk) edgeRejectionReasons.push('5m bearish/CHOP structure rejected');
    if (!locationOk) edgeRejectionReasons.push('5m price has not reclaimed or reached VWAP/EMA support');
    if (!triggerOk) edgeRejectionReasons.push('5m waiting for reclaim or momentum trigger');
    if (!participationOk) edgeRejectionReasons.push('5m participation outside useful range');
    if (!extensionOk) edgeRejectionReasons.push('5m move is too extended or oscillator state is poor');
    edgeQualityScore = (trendOk ? 1.6 : 0) + (structureOk ? 1.4 : 0) + (reclaimedVwap ? 1.6 : 0) + (reclaimedEma21 ? 1.2 : 0) + (momentumTurnedUp ? 1.0 : 0) + (currentPrice > vwap ? 0.6 : 0) + (relativeVolume >= 1 ? 0.6 : 0);
    edgeQualified = trendOk && structureOk && locationOk && triggerOk && participationOk && extensionOk && edgeQualityScore >= 4.3;
    edgeStrong = edgeQualified && (reclaimedVwap || reclaimedEma21) && momentumTurnedUp && recoveryConfirmationCount >= 2 && edgeQualityScore >= 5.8;
    recoveryStage = edgeStrong ? 'ENTRY TRIGGER STRONG' : edgeQualified ? 'ENTRY TRIGGER CONFIRMED' : 'WAITING FOR 5M TRIGGER';
  } else if (timeframe === '15m') {
    edgeSetupType = 'TREND_PULLBACK_15M';
    const trendOk = ema21 > ema50 && currentPrice > ema50 && ema21SlopePct3 > 0;
    const structureOk = !isStructureBearish && structure !== 'CHOP (Ranging)';
    const pullbackOk = (priceNearEma21 || priceNearVwap || recentRetestEma21 || recentRetestVwap || reclaimedEma21 || reclaimedVwap) && pullbackDepthPct >= 0.35 && pullbackDepthPct <= 6.0;
    const recoveryOk15 = reclaimedVwap || reclaimedEma21 || momentumTurnedUp || (bullishCandle && macdHistogramDelta > 0);
    const participationOk = relativeVolume >= 0.6 && relativeVolume <= 4.0;
    const extensionOk = rsi <= 72 && Number(stoch.k) <= 85 && bbPosition <= 1.10 && recent3ReturnPct <= 2.0;
    if (!trendOk) edgeRejectionReasons.push('15m trend pullback requires EMA21>EMA50 with a rising EMA21');
    if (!structureOk) edgeRejectionReasons.push('15m bearish/CHOP structure rejected');
    if (!pullbackOk) edgeRejectionReasons.push('15m waiting for a real pullback into EMA21/VWAP support');
    if (!recoveryOk15) edgeRejectionReasons.push('15m pullback has not turned back upward');
    if (!participationOk) edgeRejectionReasons.push('15m participation outside useful range');
    if (!extensionOk) edgeRejectionReasons.push('15m entry is already extended');
    edgeQualityScore = (trendOk ? 2.0 : 0) + (structureOk ? 1.5 : 0) + (pullbackOk ? 1.25 : 0) + (reclaimedVwap ? 1.25 : 0) + (reclaimedEma21 ? 1.0 : 0) + (momentumTurnedUp ? 0.75 : 0) + (relativeVolume >= 1 ? 0.5 : 0);
    edgeQualified = trendOk && structureOk && pullbackOk && recoveryOk15 && participationOk && extensionOk && edgeQualityScore >= 4.75;
    edgeStrong = edgeQualified && recoveryConfirmationCount >= 2 && (reclaimedVwap || reclaimedEma21) && edgeQualityScore >= 6.0;
    recoveryStage = edgeStrong ? 'STRONG TREND PULLBACK' : edgeQualified ? 'TREND PULLBACK CONFIRMED' : 'WAITING FOR 15M PULLBACK';
  } else if (timeframe === '30m') {
    edgeSetupType = 'RECOVERY_REVERSAL_30M';

    const dipOk = recent3ReturnPct <= -0.30 && recent3ReturnPct >= -2.50;
    const exhaustionOk = exhaustionScore >= 4.0 && exhaustionScore <= 7.0;
    const participationOk = relativeVolume >= 0.75 && relativeVolume <= 4.0;
    const volatilityOk = atrPct >= 0.35 && atrPct <= 1.50;
    const breakdownOk = breakdownPenalty > -2.5 && belowLowerBandAtr <= 1.1 && !(lastBearishBody && lastBodyPctAtr > 2.0);
    const confirmedBearishStructure = structure === 'Bearish Structure';
    const freshBearishChoch = structure === 'CHOCH (Bearish)' && !reclaimedVwap && !reclaimedEma21 && !structureRecovered;
    const vwapRecoveryOk = reclaimedVwap || holdsAboveVwap || (vwapDistanceAtr <= 0.45 && reclaimedEma21);
    const primaryRecovery = reclaimedVwap || reclaimedEma21 || momentumTurnedUp;
    const recoveryOk = primaryRecovery && recoveryConfirmationCount >= 1;
    const noFreshBreakdown = !confirmedBearishStructure && !freshBearishChoch;

    if (!dipOk) edgeRejectionReasons.push('30m waiting for a controlled prior pullback (-0.3% to -2.5% over 3 bars)');
    if (!exhaustionOk) edgeRejectionReasons.push('30m candidate is not in a usable exhaustion zone');
    if (!participationOk) edgeRejectionReasons.push('30m liquidity/participation outside usable range');
    if (!volatilityOk) edgeRejectionReasons.push('30m volatility outside usable range');
    if (!breakdownOk) edgeRejectionReasons.push('30m selloff is still accelerating / breakdown risk');
    if (confirmedBearishStructure) edgeRejectionReasons.push('30m confirmed Bearish Structure — no long entry');
    if (freshBearishChoch) edgeRejectionReasons.push('30m bearish CHOCH is WATCH only until a reclaim occurs');
    if (!primaryRecovery) edgeRejectionReasons.push('30m exhausted but not recovered — wait for VWAP/EMA21 reclaim or momentum turn');
    if (!vwapRecoveryOk) edgeRejectionReasons.push('30m recovery has not reclaimed/held VWAP');

    const recoveryScore =
      (reclaimedVwap ? 2.75 : 0) +
      (holdsAboveVwap ? 1.25 : 0) +
      (reclaimedEma21 ? 1.5 : 0) +
      (momentumTurnedUp ? 1.0 : 0) +
      (structureRecovered ? 0.25 : 0);
    const contextScore =
      (dipOk ? 0.8 : 0) +
      (exhaustionOk ? 0.8 : 0) +
      (participationOk ? 0.5 : 0) +
      (volatilityOk ? 0.5 : 0) +
      (breakdownOk ? 0.8 : 0) +
      (regime.label === 'BULL' ? 0.5 : regime.label === 'WEAK_BULL' ? 0.35 : regime.label === 'RANGE' ? -0.5 : regime.label === 'BEAR' ? -0.75 : -0.25);

    const recoveryPathScore = recoveryScore + contextScore;
    const recoveryQualified = dipOk && exhaustionOk && participationOk && volatilityOk && breakdownOk && noFreshBreakdown && recoveryOk && vwapRecoveryOk && recoveryPathScore >= 4.35;
    const strongRecovery = recoveryConfirmationCount >= 2 && (reclaimedVwap || holdsAboveVwap) && momentumTurnedUp;
    const strongRecoveryQualified = recoveryQualified && strongRecovery && recoveryPathScore >= 5.75;

    // V5.16: 30m also permits continuation entries. A healthy bull trend should not be
    // forced to manufacture a fresh exhaustion/reclaim sequence before every entry.
    const continuationStructureOk = !confirmedBearishStructure && structure !== 'CHOCH (Bearish)';
    const continuationTrendOk = ema9 > ema21 && ema21 >= ema50 * 0.995 && currentPrice >= ema21;
    const continuationLocationOk = isAboveVWAP || priceNearVwap || holdsAboveVwap;
    const continuationMomentumOk = isMacdBullish || momentumTurnedUp || isUTBotBuy;
    const continuationContextOk = rsi >= 45 && rsi <= 82 && Number(stoch.k) <= 97 && bbPosition <= 1.30;
    const continuationHardVeto = confirmedBearishStructure || (currentPrice < ema21 && currentPrice < vwap && !isMacdBullish);

    let continuationScore = 0;
    continuationScore += continuationTrendOk ? 1.75 : -0.75;
    continuationScore += continuationStructureOk ? 1.20 : -1.25;
    continuationScore += isAboveVWAP ? 1.20 : (priceNearVwap ? 0.45 : -0.40);
    continuationScore += isMacdBullish ? 0.85 : (momentumTurnedUp ? 0.45 : -0.20);
    continuationScore += isUTBotBuy ? 0.55 : -0.15;
    continuationScore += ichimoku.bias > 0 ? 0.55 : (ichimoku.bias < 0 ? -0.45 : 0);
    continuationScore += isLinRegBullish ? 0.30 : 0;
    continuationScore += adxValue >= 20 ? 0.30 : 0;
    continuationScore += regime.label === 'BULL' ? 0.45 : regime.label === 'WEAK_BULL' ? 0.25 : regime.label === 'BEAR' ? -0.55 : 0;
    if (rsi > 78) continuationScore -= 0.45;
    if (Number(stoch.k) > 92) continuationScore -= 0.30;
    if (bbPosition > 1.15) continuationScore -= 0.30;

    const continuationExtended = rsi > 84 || Number(stoch.k) > 98 || bbPosition > 1.35;
    const continuationQualified = !continuationHardVeto && continuationTrendOk && continuationLocationOk && continuationMomentumOk && continuationContextOk && continuationScore >= 4.05;
    const strongContinuationQualified = continuationQualified && !continuationExtended && continuationScore >= 5.35 && isAboveVWAP && (isMacdBullish || momentumTurnedUp);

    edgeQualityScore = Math.max(recoveryPathScore, continuationScore);
    edgeQualified = recoveryQualified || continuationQualified;
    edgeStrong = strongRecoveryQualified || strongContinuationQualified;

    if (strongRecoveryQualified) recoveryStage = 'STRONG RECOVERY CONFIRMED';
    else if (strongContinuationQualified) recoveryStage = 'STRONG 30M TREND CONTINUATION';
    else if (recoveryQualified) recoveryStage = 'RECOVERY CONFIRMED';
    else if (continuationQualified) recoveryStage = '30M TREND CONTINUATION';
    else if (continuationExtended && continuationScore >= 3.35) recoveryStage = 'EXTENDED / WAIT FOR DIP';
    else if (continuationScore >= 3.10) recoveryStage = 'BULLISH WATCH';
    else if (dipOk && exhaustionOk) recoveryStage = freshBearishChoch ? 'EXHAUSTED / CHOCH WATCH' : 'EXHAUSTED / WAITING FOR RECLAIM';
    else recoveryStage = 'NO SETUP';

    if (!edgeQualified && continuationScore < 3.10 && !dipOk) edgeRejectionReasons.push(`30m neither recovery nor continuation qualified (trend score ${continuationScore.toFixed(2)})`);
  } else if (timeframe === '1h' || timeframe === '2h' || timeframe === '4h' || timeframe === '6h' || timeframe === '8h' || timeframe === '12h' || timeframe === '1d' || timeframe === '3d' || timeframe === '1w') {
    const strategyMap = {
      '1h':'CONTROLLED_TREND_1H','2h':'SWING_PULLBACK_2H','4h':'TREND_CONTINUATION_4H','6h':'TREND_CONTINUATION_6H',
      '8h':'SWING_CONTINUATION_8H','12h':'MACRO_PULLBACK_12H','1d':'MACRO_TREND_1D','3d':'POSITION_TREND_3D','1w':'MACRO_REGIME_1W'
    };
    edgeSetupType = strategyMap[timeframe];

    // V5.15: higher-timeframe continuation is scored, not killed by one oscillator.
    // Overbought RSI/Stoch is a penalty / EXTENDED state, not an automatic rejection.
    const emaFastUp = ema9 > ema21;
    const emaMacroUp = ema21 > ema50;
    const priceAboveMacro = currentPrice > ema50;
    const structureBullish = /bullish structure|bos \(bullish\)/i.test(structure);
    const hardBearishVeto = isStructureBearish && currentPrice < ema21 && !isMacdBullish;
    const severeBreakdownVeto = breakdownPenalty <= -3 && currentPrice < vwap && currentPrice < ema21;
    const extended = rsi > 80 || Number(stoch.k) > 95 || bbPosition > 1.25;

    let score = 0;
    score += emaFastUp ? 1.15 : -0.35;
    score += emaMacroUp ? 1.45 : -0.75;
    score += priceAboveMacro ? 0.85 : -0.55;
    score += structureBullish ? 1.25 : (structure === 'CHOP (Ranging)' ? -0.25 : 0.35);
    score += isMacdBullish ? 0.85 : -0.45;
    score += isAboveVWAP ? 0.85 : -0.35;
    score += isUTBotBuy ? 0.55 : -0.25;
    score += ichimoku.bias > 0 ? 0.55 : (ichimoku.bias < 0 ? -0.55 : 0);
    score += isLinRegBullish ? 0.35 : -0.15;
    score += adxValue >= 24 ? 0.45 : (adxValue >= 18 ? 0.15 : -0.15);
    score += relativeVolume >= 0.55 && relativeVolume <= 4.5 ? 0.30 : -0.20;
    score += roc9Pct > 0 ? 0.35 : (roc9Pct < -2 ? -0.45 : 0);
    score += momentumTurnedUp ? 0.35 : 0;
    if (rsi > 84) score -= 1.20; else if (rsi > 78) score -= 0.55;
    if (Number(stoch.k) > 97) score -= 0.65; else if (Number(stoch.k) > 90) score -= 0.25;
    if (bbPosition > 1.35) score -= 0.75; else if (bbPosition > 1.15) score -= 0.30;
    if (atrPct > 12) score -= 0.75;

    const threshold = timeframe === '1h' ? 5.35 : timeframe === '2h' ? 5.15 : 4.85;
    const strongThreshold = timeframe === '1h' ? 6.65 : 6.35;
    edgeQualityScore = score;
    edgeQualified = !hardBearishVeto && !severeBreakdownVeto && score >= threshold;
    edgeStrong = edgeQualified && !extended && score >= strongThreshold;
    recoveryStage = hardBearishVeto || severeBreakdownVeto ? 'BEARISH INVALIDATION' : extended && score >= threshold - 0.75 ? 'EXTENDED / WAIT FOR DIP' : score >= threshold - 1.25 ? 'BULLISH WATCH' : 'NO SETUP';
    if (!edgeQualified) {
      if (hardBearishVeto || severeBreakdownVeto) edgeRejectionReasons.push(`${timeframe} bearish invalidation`);
      else if (extended) edgeRejectionReasons.push(`${timeframe} bullish context is extended; wait for a better entry`);
      else edgeRejectionReasons.push(`${timeframe} weighted trend score ${score.toFixed(2)} below ${threshold.toFixed(2)}`);
    }
  } else {
    edgeSetupType = 'UNSUPPORTED_TIMEFRAME';
    edgeRejectionReasons.push('Unsupported timeframe');
  }

  const selectedRejectionReasons = useTimeframeEdgeScoring ? edgeRejectionReasons : (useBreakoutScoring ? breakoutRejectionReasons : (useExhaustionScoring ? exhaustionRejectionReasons : (usePullbackScoring ? pullbackRejectionReasons : rejectionReasons)));

  let finalSignal = 'CASH / NO TRADE ⚪', signalColor = '#94a3b8';
  if (profile === STRATEGY_PROFILES.TIMEFRAME_EDGE_SPOT) {
    if (edgeStrong) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (edgeQualified) {
      if (timeframe === '30m' && recoveryStage.includes('TREND CONTINUATION')) finalSignal = 'TREND BUY 🟢';
      else finalSignal = ['1h','2h','4h','6h','8h','12h','1d','3d','1w'].includes(timeframe) ? 'TREND BUY 🟢' : 'BUY 🟢';
      signalColor = '#34d399';
    }
    else if (['1m','3m'].includes(timeframe)) { finalSignal = 'EXECUTION ONLY ⚪'; signalColor = '#94a3b8'; }
    else if (recoveryStage.includes('EXTENDED')) { finalSignal = 'EXTENDED / WAIT FOR DIP 🟠'; signalColor = '#fb923c'; }
    else if (recoveryStage.includes('BULLISH WATCH')) { finalSignal = 'WATCH / BULLISH 🟡'; signalColor = '#f59e0b'; }
    else if (['5m','15m','30m'].includes(timeframe) && (recoveryStage.includes('WATCH') || recoveryStage.includes('WAITING'))) { finalSignal = recoveryStage.includes('RECLAIM') ? 'WAIT FOR RECLAIM 🟡' : 'WATCH / NO TRADE 🟡'; signalColor = '#f59e0b'; }
    else if (isStructureBearish || breakdownPenalty <= -2.5) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#ef4444'; }
  } else if (profile === STRATEGY_PROFILES.V3_BASELINE) {
    if (totalScore >= 5.3 && rsi < 72 && !isStructureBearish) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (totalScore >= 3.0 && rsi < 74) { finalSignal = 'BUY 🟢'; signalColor = '#34d399'; }
    else if (totalScore <= -4.5 || rsi >= 80) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#ef4444'; }
    else if (totalScore <= -2.5) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#f87171'; }
  } else if (profile === STRATEGY_PROFILES.PULLBACK_SPOT || profile === STRATEGY_PROFILES.TREND_PULLBACK_SPOT) {
    // V5.3: hard validity gates come BEFORE scoring. Enough points can no longer override
    // bad market location, CHOP/weak trend or an already-extended breakout.
    const mandatoryPass = trendGate && structureGate && locationGate && freshPullbackGate && extensionGate && oscillatorGate;
    const confirmationPass = reversalConfirmationScore >= 1.35;
    const participationPass = relativeVolume >= 0.65 && relativeVolume <= 3.5;
    const qualified = mandatoryPass && confirmationPass && participationPass && pullbackTotalScore >= 4.0 && atrPct <= 10 && bbWidthPct <= 24;
    const strong = qualified && adxValue >= 25 && pullbackQualityScore >= 2.0 && reversalConfirmationScore >= 2.0 && pullbackTotalScore >= 5.5 && rsi <= 64 && Number(stoch.k) <= 62 && Number(cci) <= 125 && bbPosition <= 0.90;
    if (strong) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (qualified) { finalSignal = 'BUY 🟢'; signalColor = '#34d399'; }
    else if (isStructureBearish || currentPrice < ema50) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#ef4444'; }
  } else if (profile === STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT) {
    const breakoutStructurePass = !isStructureBearish && structure !== 'CHOP (Ranging)';
    const breakoutTrendPass = ema21 > ema50 && ema21SlopePct3 > 0 && currentPrice > ema50 && adxValue >= 22;
    const breakoutLevelPass = currentPrice > priorHigh20 && breakoutAbovePriorHighAtr >= 0;
    const breakoutParticipationPass = relativeVolume >= 1.0 && relativeVolume <= 3.5;
    const breakoutMomentumPass = (macdHistogramDelta > 0 || bullishCandle) && rsi >= 52 && rsi <= 72;
    const breakoutExtensionPass = bbPosition <= 1.20 && rsi <= 74 && Number(stoch.k) <= 88 && vwapDistanceAtr <= 3.0;
    const qualified = breakoutStructurePass && breakoutTrendPass && breakoutLevelPass && breakoutParticipationPass && breakoutMomentumPass && breakoutExtensionPass && breakoutScore >= 4.8;
    const strong = qualified && adxValue >= 28 && relativeVolume >= 1.2 && breakoutScore >= 5.8 && rsi <= 68 && Number(stoch.k) <= 80;
    if (strong) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (qualified) { finalSignal = 'BUY 🟢'; signalColor = '#34d399'; }
    else if (isStructureBearish) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#ef4444'; }
  } else if (profile === STRATEGY_PROFILES.EXHAUSTION_SCALP_SPOT) {
    // Alpha-style spot exhaustion entry: short-term bearish indicators are allowed.
    // The setup is buying an oversold cluster while avoiding an accelerating breakdown.
    const baseQualified = exhaustionRejectionReasons.length === 0 && exhaustionTotalScore >= 4.2;
    const strong = baseQualified && exhaustionScore >= 5.5 && exhaustionTotalScore >= 5.0 && (Number(stoch.k) < 20 || williams14 < -80) && rsi <= 42;
    if (strong) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (baseQualified) { finalSignal = 'BUY 🟢'; signalColor = '#34d399'; }
    else if (breakdownPenalty <= -2.5) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#ef4444'; }
  } else if (profile === STRATEGY_PROFILES.RESEARCH_SPOT) {
    // Broad spot-only research profile: do NOT pre-filter by BTC regime/ADX/RVOL.
    // We record those features and let the resulting dataset tell us which conditions matter.
    const researchHardBlock = rsi >= 82 || atrPct > 12 || bbWidthPct > 28;
    if (!researchHardBlock && totalScore >= 5.0 && rsi < 74 && !isStructureBearish) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (!researchHardBlock && totalScore >= 2.6 && rsi < 76) { finalSignal = 'BUY 🟢'; signalColor = '#34d399'; }
    else if (totalScore <= -3.5 || rsi >= 82) { finalSignal = 'AVOID / CASH 🔴'; signalColor = '#ef4444'; }
  } else {
    if (v4Strong) { finalSignal = 'STRONG BUY 🚀'; signalColor = '#10b981'; }
    else if (v4Qualified) { finalSignal = 'BUY 🟢'; signalColor = '#34d399'; }
  }

  const feeBufferPct = options.feeBufferPct ?? 0.0025;
  const tp1Price = currentPrice + Math.max(1.0 * atr, currentPrice * feeBufferPct);
  const tp2Price = currentPrice + Math.max(2.0 * atr, currentPrice * (feeBufferPct + 0.002));
  const tp3Price = currentPrice + Math.max(3.5 * atr, currentPrice * (feeBufferPct + 0.005));
  const stopPrice = currentPrice - 2.5 * atr;
  const pct = p => currentPrice ? ((p - currentPrice) / currentPrice) * 100 : 0;

  let bbStatus = 'Mid-Range';
  if (currentPrice > bb.upper) bbStatus = 'Upper Band (Overextended)';
  else if (currentPrice < bb.lower) bbStatus = 'Lower Band (Discount)';

  return {
    price: currentPrice,
    rsi: rsi.toFixed(2),
    macdStr: isMacdBullish ? 'Bullish' : 'Bearish',
    emaStr: isEmaUptrend ? 'Uptrend' : 'Downtrend',
    macroEmaStr: isGoldenCross ? 'Bullish Macro' : 'Bearish Macro',
    supertrendStr: supertrendBullish ? 'Bullish' : 'Bearish',
    linRegStr: isLinRegBullish ? 'Above LinReg' : 'Below LinReg',
    utBotStr: isUTBotBuy ? 'UT Long' : 'UT Short',
    ichimokuStr: ichimoku.status,
    percentRStr: percentR.status,
    percentScore: percentR.score,
    smcStr: structure,
    stochStr: `${Number(stoch.k).toFixed(1)} (${stoch.k < 20 ? 'Oversold' : stoch.k > 80 ? 'Overbought' : 'Neutral'})`,
    adxStr: `${Number(adx.adx).toFixed(1)} (${adx.adx > 25 ? 'Trending' : 'Ranging'})`,
    cci: Number(cci).toFixed(1),
    mfi: Number(mfi).toFixed(1),
    williamsR14: Number(williams14.toFixed(2)),
    roc9Pct: Number(roc9Pct.toFixed(3)),
    sma20: Number(sma20.toFixed(8)),
    sma50: Number(sma50.toFixed(8)),
    bbWidth: `${bbWidthPct.toFixed(2)}%`,
    vwapStr: isAboveVWAP ? 'Above VWAP' : 'Below VWAP',
    vwap,
    vpvr,
    bbStatus,
    finalSignal,
    signalColor,
    consensusScore: Number((useTimeframeEdgeScoring ? edgeQualityScore : totalScore).toFixed(2)),
    strategyProfile: profile,
    edgeQualityScore: Number(edgeQualityScore.toFixed(2)),
    edgeSetupType, edgeQualified, edgeStrong,
    reversalConfirmationCount: shortReversalConfirmations,
    recoveryStage, recoveryConfirmationCount, reclaimedVwap, reclaimedEma21, structureRecovered, holdsAboveVwap, momentumTurnedUp, prevStructure,
    regime,
    rejectionReasons: selectedRejectionReasons,
    v4Qualified,
    v3Score: Number(v3TotalScore.toFixed(2)),
    v4Score: Number(v4TotalScore.toFixed(2)),
    pullbackScore: Number(pullbackTotalScore.toFixed(2)),
    breakoutScore: Number(breakoutScore.toFixed(2)),
    recommendedStrategy: timeframeStrategy?.label || edgeSetupType,
    recommendedStrategyCode: timeframeStrategy?.name || edgeSetupType,
    setupType: useTimeframeEdgeScoring ? edgeSetupType : (profile === STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT ? 'MOMENTUM_BREAKOUT' : (usePullbackScoring ? 'TREND_PULLBACK' : (useExhaustionScoring ? 'EXHAUSTION_REVERSAL' : profile))),
    exhaustionScore: Number(exhaustionTotalScore.toFixed(2)),
    exhaustionFeatures: {
      rawOversoldScore: Number(exhaustionScore.toFixed(2)), breakdownPenalty: Number(breakdownPenalty.toFixed(2)),
      williamsR14: Number(williams14.toFixed(2)), williamsR14Prev: Number(williams14Prev.toFixed(2)),
      stochK: Number(Number(stoch.k).toFixed(2)), stochPrevK: Number(Number(stochPrev.k).toFixed(2)),
      stochRising, williamsRising, bbPosition: Number(bbPosition.toFixed(4)), belowLowerBandAtr: Number(belowLowerBandAtr.toFixed(4)),
      lastBodyAtr: Number(lastBodyPctAtr.toFixed(4)), lastBearishBody, recent3ReturnPct: Number(recent3ReturnPct.toFixed(4))
    },
    pullbackFeatures: {
      ema21: Number(ema21.toFixed(8)), ema50: Number(ema50.toFixed(8)),
      ema21DistancePct: Number(distanceEma21Pct.toFixed(4)), ema50DistancePct: Number(distanceEma50Pct.toFixed(4)),
      vwapDistancePct: Number(distanceVwapPct.toFixed(4)), recentHighDistancePct: Number(distanceRecentHighPct.toFixed(4)),
      recentLowDistancePct: Number(distanceRecentLowPct.toFixed(4)), pullbackDepthPct: Number(pullbackDepthPct.toFixed(4)),
      barsSinceLocalHigh, ema21SlopePct3: Number(ema21SlopePct3.toFixed(4)),
      rsiPrev1: Number(rsiPrev1.toFixed(3)), rsiPrev2: Number(rsiPrev2.toFixed(3)), rsiDelta1: Number(rsiDelta1.toFixed(3)), rsiDelta2: Number(rsiDelta2.toFixed(3)),
      macdHistogram: Number(macdHistogram.toFixed(8)), macdHistogramPrev: Number(macdHistogramPrev.toFixed(8)), macdHistogramDelta: Number(macdHistogramDelta.toFixed(8)),
      bullishCandle, prevReturn1Pct: Number(prevReturn1Pct.toFixed(4)), prevReturn2Pct: Number(prevReturn2Pct.toFixed(4)), prevReturn3Pct: Number(prevReturn3Pct.toFixed(4)),
      touchedEma21Recently, touchedVwapRecently, priceNearEma21, priceNearVwap, recentRetestEma21, recentRetestVwap,
      ema21DistanceAtr: Number(ema21DistanceAtr.toFixed(4)), vwapDistanceAtr: Number(vwapDistanceAtr.toFixed(4)), recentHighDistanceAtr: Number(recentHighDistanceAtr.toFixed(4)),
      trendGate, structureGate, locationGate, freshPullbackGate, extensionGate, oscillatorGate,
      trendStateScore: Number(pullbackTrendScore.toFixed(2)), pullbackQualityScore: Number(pullbackQualityScore.toFixed(2)),
      reversalConfirmationScore: Number(reversalConfirmationScore.toFixed(2)), pullbackParticipationScore: Number(pullbackParticipationScore.toFixed(2)),
      extensionPenalty: Number(extensionPenalty.toFixed(2)), breakoutScore: Number(breakoutScore.toFixed(2)), breakoutAbovePriorHighAtr: Number(breakoutAbovePriorHighAtr.toFixed(4)),
      recoveryStage, recoveryConfirmationCount, reclaimedVwap, reclaimedEma21, structureRecovered, holdsAboveVwap, momentumTurnedUp, prevStructure
    },
    adxValue: Number(adxValue.toFixed(2)),
    relativeVolume: Number(relativeVolume.toFixed(3)),
    atrPct: Number(atrPct.toFixed(3)),
    familyScores: {
      trend: Number(selectedTrendScore.toFixed(2)),
      momentum: Number(selectedMomentumScore.toFixed(2)),
      structure: Number(selectedStructureScore.toFixed(2)),
      participation: Number(selectedParticipationScore.toFixed(2)),
      volatility: Number(selectedVolatilityScore.toFixed(2))
    },
    suggestedSL: Math.abs(pct(stopPrice)).toFixed(2),
    stopPrice,
    tp1: pct(tp1Price).toFixed(2),
    tp2: pct(tp2Price).toFixed(2),
    tp3: pct(tp3Price).toFixed(2),
    tp1Price, tp2Price, tp3Price,
    atr,
    isBuySignal: finalSignal.includes('BUY'),
    isStrongBuy: finalSignal.includes('STRONG BUY'),
    snapshot: {
      rsi: rsi.toFixed(2),
      macd: isMacdBullish ? 'Bullish' : 'Bearish',
      stoch: `${Number(stoch.k).toFixed(1)} (${stoch.k < 20 ? 'Oversold' : stoch.k > 80 ? 'Overbought' : 'Neutral'})`,
      adx: `${Number(adx.adx).toFixed(1)} (${adx.adx > 25 ? 'Trending' : 'Ranging'})`,
      vwap: isAboveVWAP ? 'Above VWAP' : 'Below VWAP',
      cci: Number(cci.toFixed ? cci.toFixed(2) : Number(cci).toFixed(2)),
      mfi: Number(mfi.toFixed ? mfi.toFixed(2) : Number(mfi).toFixed(2)),
      williamsR14: Number(williams14.toFixed(2)),
      roc9Pct: Number(roc9Pct.toFixed(3)),
      sma20: Number(sma20.toFixed(8)),
      sma50: Number(sma50.toFixed(8)),
      smc: structure,
      ichimoku: ichimoku.status,
      consensus: finalSignal,
      score: Number((useTimeframeEdgeScoring ? edgeQualityScore : totalScore).toFixed(2)),
      v3Score: Number(v3TotalScore.toFixed(2)),
      v4Score: Number(v4TotalScore.toFixed(2)),
    pullbackScore: Number(pullbackTotalScore.toFixed(2)),
    breakoutScore: Number(breakoutScore.toFixed(2)),
    recommendedStrategy: timeframeStrategy?.label || edgeSetupType,
    recommendedStrategyCode: timeframeStrategy?.name || edgeSetupType,
    setupType: useTimeframeEdgeScoring ? edgeSetupType : (profile === STRATEGY_PROFILES.MOMENTUM_BREAKOUT_SPOT ? 'MOMENTUM_BREAKOUT' : (usePullbackScoring ? 'TREND_PULLBACK' : (useExhaustionScoring ? 'EXHAUSTION_REVERSAL' : profile))),
    exhaustionScore: Number(exhaustionTotalScore.toFixed(2)),
    exhaustionFeatures: {
      rawOversoldScore: Number(exhaustionScore.toFixed(2)), breakdownPenalty: Number(breakdownPenalty.toFixed(2)),
      williamsR14: Number(williams14.toFixed(2)), williamsR14Prev: Number(williams14Prev.toFixed(2)),
      stochK: Number(Number(stoch.k).toFixed(2)), stochPrevK: Number(Number(stochPrev.k).toFixed(2)),
      stochRising, williamsRising, bbPosition: Number(bbPosition.toFixed(4)), belowLowerBandAtr: Number(belowLowerBandAtr.toFixed(4)),
      lastBodyAtr: Number(lastBodyPctAtr.toFixed(4)), lastBearishBody, recent3ReturnPct: Number(recent3ReturnPct.toFixed(4))
    },
    pullbackFeatures: {
      ema21: Number(ema21.toFixed(8)), ema50: Number(ema50.toFixed(8)),
      ema21DistancePct: Number(distanceEma21Pct.toFixed(4)), ema50DistancePct: Number(distanceEma50Pct.toFixed(4)),
      vwapDistancePct: Number(distanceVwapPct.toFixed(4)), recentHighDistancePct: Number(distanceRecentHighPct.toFixed(4)),
      recentLowDistancePct: Number(distanceRecentLowPct.toFixed(4)), pullbackDepthPct: Number(pullbackDepthPct.toFixed(4)),
      barsSinceLocalHigh, ema21SlopePct3: Number(ema21SlopePct3.toFixed(4)),
      rsiPrev1: Number(rsiPrev1.toFixed(3)), rsiPrev2: Number(rsiPrev2.toFixed(3)), rsiDelta1: Number(rsiDelta1.toFixed(3)), rsiDelta2: Number(rsiDelta2.toFixed(3)),
      macdHistogram: Number(macdHistogram.toFixed(8)), macdHistogramPrev: Number(macdHistogramPrev.toFixed(8)), macdHistogramDelta: Number(macdHistogramDelta.toFixed(8)),
      bullishCandle, prevReturn1Pct: Number(prevReturn1Pct.toFixed(4)), prevReturn2Pct: Number(prevReturn2Pct.toFixed(4)), prevReturn3Pct: Number(prevReturn3Pct.toFixed(4)),
      touchedEma21Recently, touchedVwapRecently, priceNearEma21, priceNearVwap, recentRetestEma21, recentRetestVwap,
      ema21DistanceAtr: Number(ema21DistanceAtr.toFixed(4)), vwapDistanceAtr: Number(vwapDistanceAtr.toFixed(4)), recentHighDistanceAtr: Number(recentHighDistanceAtr.toFixed(4)),
      trendGate, structureGate, locationGate, freshPullbackGate, extensionGate, oscillatorGate,
      trendStateScore: Number(pullbackTrendScore.toFixed(2)), pullbackQualityScore: Number(pullbackQualityScore.toFixed(2)),
      reversalConfirmationScore: Number(reversalConfirmationScore.toFixed(2)), pullbackParticipationScore: Number(pullbackParticipationScore.toFixed(2)),
      extensionPenalty: Number(extensionPenalty.toFixed(2)), breakoutScore: Number(breakoutScore.toFixed(2)), breakoutAbovePriorHighAtr: Number(breakoutAbovePriorHighAtr.toFixed(4)),
      recoveryStage, recoveryConfirmationCount, reclaimedVwap, reclaimedEma21, structureRecovered, holdsAboveVwap, momentumTurnedUp, prevStructure
    },
      strategyProfile: profile,
      regime: regime.label || 'UNKNOWN',
      regimeScore: Number(regime.score || 0),
      regimeAdx: Number(regime.adx || 0),
      regimeRsi: Number(regime.rsi || 0),
      regimeAtrPct: Number(regime.atrPct || 0),
      regimeStructure: regime.structure || '',
      adxValue: Number(adxValue.toFixed(2)),
      relativeVolume: Number(relativeVolume.toFixed(3)),
      atrPct: Number(atrPct.toFixed(3)),
      pullbackScore: Number(pullbackTotalScore.toFixed(2)),
      exhaustionScore: Number(exhaustionTotalScore.toFixed(2)),
      exhaustionRawScore: Number(exhaustionScore.toFixed(2)),
      breakdownPenalty: Number(breakdownPenalty.toFixed(2)),
      williamsR14: Number(williams14.toFixed(2)),
      williamsR14Prev: Number(williams14Prev.toFixed(2)),
      stochK: Number(Number(stoch.k).toFixed(2)),
      stochPrevK: Number(Number(stochPrev.k).toFixed(2)),
      stochRising, williamsRising, bbPosition: Number(bbPosition.toFixed(4)), belowLowerBandAtr: Number(belowLowerBandAtr.toFixed(4)),
      lastBodyAtr: Number(lastBodyPctAtr.toFixed(4)), lastBearishBody, recent3ReturnPct: Number(recent3ReturnPct.toFixed(4)),
      ema21DistancePct: Number(distanceEma21Pct.toFixed(4)),
      ema50DistancePct: Number(distanceEma50Pct.toFixed(4)),
      vwapDistancePct: Number(distanceVwapPct.toFixed(4)),
      recentHighDistancePct: Number(distanceRecentHighPct.toFixed(4)),
      recentLowDistancePct: Number(distanceRecentLowPct.toFixed(4)),
      pullbackDepthPct: Number(pullbackDepthPct.toFixed(4)),
      barsSinceLocalHigh,
      ema21SlopePct3: Number(ema21SlopePct3.toFixed(4)),
      rsiPrev1: Number(rsiPrev1.toFixed(3)),
      rsiPrev2: Number(rsiPrev2.toFixed(3)),
      rsiDelta1: Number(rsiDelta1.toFixed(3)),
      rsiDelta2: Number(rsiDelta2.toFixed(3)),
      macdHistogram: Number(macdHistogram.toFixed(8)),
      macdHistogramPrev: Number(macdHistogramPrev.toFixed(8)),
      macdHistogramDelta: Number(macdHistogramDelta.toFixed(8)),
      bullishCandle,
      prevReturn1Pct: Number(prevReturn1Pct.toFixed(4)),
      prevReturn2Pct: Number(prevReturn2Pct.toFixed(4)),
      prevReturn3Pct: Number(prevReturn3Pct.toFixed(4)),
      touchedEma21Recently, touchedVwapRecently, priceNearEma21, priceNearVwap, recentRetestEma21, recentRetestVwap,
      ema21DistanceAtr: Number(ema21DistanceAtr.toFixed(4)), vwapDistanceAtr: Number(vwapDistanceAtr.toFixed(4)), recentHighDistanceAtr: Number(recentHighDistanceAtr.toFixed(4)),
      trendGate, structureGate, locationGate, freshPullbackGate, extensionGate, oscillatorGate,
      pullbackTrendScore: Number(pullbackTrendScore.toFixed(2)),
      pullbackQualityScore: Number(pullbackQualityScore.toFixed(2)),
      reversalConfirmationScore: Number(reversalConfirmationScore.toFixed(2)),
      pullbackParticipationScore: Number(pullbackParticipationScore.toFixed(2)),
      extensionPenalty: Number(extensionPenalty.toFixed(2)),
      edgeQualityScore: Number(edgeQualityScore.toFixed(2)),
      edgeSetupType,
      edgeQualified, edgeStrong,
      reversalConfirmationCount: shortReversalConfirmations,
      selloffDecelerating,
      recoveryStage, recoveryConfirmationCount, reclaimedVwap, reclaimedEma21, structureRecovered, holdsAboveVwap, momentumTurnedUp, prevStructure,
      rejectionReasons: selectedRejectionReasons.join(' | '),
      families: {
        trend: Number(selectedTrendScore.toFixed(2)), momentum: Number(selectedMomentumScore.toFixed(2)),
        structure: Number(selectedStructureScore.toFixed(2)), participation: Number(selectedParticipationScore.toFixed(2)),
        volatility: Number(selectedVolatilityScore.toFixed(2))
      }
    }
  };
}
