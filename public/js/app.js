const socket = io();

function parseTimeframeToMs(tf = '5m') {
    const m = String(tf).trim().match(/^(\d+)(m|h|d|w)$/i);
    if (!m) return 5 * 60 * 1000;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'm') return n * 60 * 1000;
    if (unit === 'h') return n * 60 * 60 * 1000;
    if (unit === 'd') return n * 24 * 60 * 60 * 1000;
    if (unit === 'w') return n * 7 * 24 * 60 * 60 * 1000;
    return 5 * 60 * 1000;
}



function fetchAllPairs() {
    fetch('/api/all-pairs')
        .then(res => res.json())
        .then(data => {
            const container = document.getElementById('pairs-container');
            if (container && data.pairs) {
                const venues = data.venues || {};
                container.innerHTML = `
                    <div style="margin-bottom:10px;color:var(--text-muted);font-size:12px;">
                        ${data.count || data.pairs.length} eligible USDT spot pairs across configured exchanges.
                        User exclusions and technical safety filters are applied.
                    </div>
                    ${data.pairs.map(p => {
                        const ex = venues[p] || [];
                        return `<span class="asset-chip" title="${ex.join(', ')}">${p} <small style="color:var(--text-muted);">(${ex.length})</small></span>`;
                    }).join('')}
                `;
            }
        })
        .catch(err => console.error("Failed to fetch pairs", err));
}

function createTradingViewWidget(containerId, symbol, interval = "5") {
    const formattedSymbol = `BINANCE:${symbol.replace('/', '')}`;
    return new TradingView.widget({
        "autosize": true,
        "symbol": formattedSymbol,
        "interval": interval,
        "timezone": "Etc/UTC",
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "toolbar_bg": "#1e293b",
        "enable_publishing": false,
        "hide_side_toolbar": false,
        "allow_symbol_change": true,
        "details": true,
        "hotlist": false,
        "calendar": false,
        "container_id": containerId,
        "studies": ["STD;RSI", "STD;MACD", "STD;Bollinger_Bands"]
    });
}

window.loadChartGridPreset = function() {
    const layout = document.getElementById('gridPresetSelect')?.value || '2x2';
    const gridContainer = document.getElementById('tv-grid-container');
    if (!gridContainer) return;

    if (layout === '2x2') {
        gridContainer.style.gridTemplateColumns = '1fr 1fr';
        gridContainer.style.gridTemplateRows = '1fr 1fr';
        gridContainer.innerHTML = `
            <div id="tv_chart_1" style="height: 100%;"></div>
            <div id="tv_chart_2" style="height: 100%;"></div>
            <div id="tv_chart_3" style="height: 100%;"></div>
            <div id="tv_chart_4" style="height: 100%;"></div>
        `;
        createTradingViewWidget("tv_chart_1", "BTC/USDT", "5");
        createTradingViewWidget("tv_chart_2", "ETH/USDT", "15");
        createTradingViewWidget("tv_chart_3", "SOL/USDT", "60");
        createTradingViewWidget("tv_chart_4", "XRP/USDT", "240");
    } else if (layout === '1x2') {
        gridContainer.style.gridTemplateColumns = '1fr 1fr';
        gridContainer.style.gridTemplateRows = '1fr';
        gridContainer.innerHTML = `
            <div id="tv_chart_1" style="height: 100%;"></div>
            <div id="tv_chart_2" style="height: 100%;"></div>
        `;
        createTradingViewWidget("tv_chart_1", "BTC/USDT", "5");
        createTradingViewWidget("tv_chart_2", "ETH/USDT", "15");
    } else {
        gridContainer.style.gridTemplateColumns = '1fr';
        gridContainer.style.gridTemplateRows = '1fr';
        gridContainer.innerHTML = `<div id="tv_chart_1" style="height: 100%;"></div>`;
        createTradingViewWidget("tv_chart_1", "BTC/USDT", "5");
    }
};

function getActivePositionForPair(pair) {
    const mPos = manualWallet.openPositions.find(p => p.pair === pair);
    if (mPos) return { wallet: 'Manual', pos: mPos };
    const aPos = autoWallet.openPositions.find(p => p.pair === pair);
    if (aPos) return { wallet: 'Auto', pos: aPos };
    return null;
}

function getPositionSignalAlert(pair) {
    if (!latestSignalsArray || latestSignalsArray.length === 0) return '<span style="color: #94a3b8;">Scanning...</span>';
    const sig = latestSignalsArray.find(s => s.pair === pair);
    if (!sig) return '<span style="color: #94a3b8;">No Signal Data</span>';

    if (sig.percentScore < 0 || sig.finalSignal.includes('SELL') || sig.finalSignal.includes('STRONG SELL')) {
        return `<span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">⚠️ EXIT SIGNAL (${sig.percentRStr})</span>`;
    }
    return `<span style="background: rgba(16, 185, 129, 0.2); color: #10b981; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">✅ Trend Healthy</span>`;
}

function getAdaptiveHoldMs(timeframe = '5m') {
    const tf = String(timeframe).toLowerCase();
    const tfMsMap = {
        '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
        '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
        '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000
    };
    const tfMs = tfMsMap[tf] || 300_000;
    const candles = tfMs <= 300_000 ? 48 : tfMs <= 900_000 ? 32 : tfMs <= 3_600_000 ? 24 : 12;
    return candles * tfMs;
}

class PaperWallet {
    constructor(type = "Manual", initialBalance = 1000) {
        this.type = type;
        this.cashBalance = initialBalance;
        this.startingCapital = initialBalance;
        this.tradeCount = 0;
        this.openPositions = [];
        this.closedHistory = [];
        this.takerFeeRate = 0.0010;
    }

    openPosition(pair, buyEx, sellEx, buyAsk, targetHigh, targetLow, tradeAmount, triggerSource = "Manual Entry", indicatorSnapshot = {}, timeframe = "1h") {
        if (this.cashBalance < tradeAmount) {
            alert(`❌ Insufficient cash in ${this.type} Wallet! You only have $${this.cashBalance.toFixed(2)} available.`);
            return false;
        }

        const buyFeeUSD = tradeAmount * this.takerFeeRate;
        const effectiveCapital = tradeAmount - buyFeeUSD;
        const tokensBought = effectiveCapital / buyAsk;

        this.cashBalance -= tradeAmount;

        const existingIndex = this.openPositions.findIndex(p => p.pair === pair);
        if (existingIndex !== -1) {
            if (this.type === 'Auto') {
                console.warn(`V5 Auto Portfolio skipped duplicate ${pair}: automatic DCA is disabled.`);
                this.cashBalance += tradeAmount;
                return false;
            }
            const pos = this.openPositions[existingIndex];
            
            const oldTokens = pos.tokensBought;
            const newTotalTokens = oldTokens + tokensBought;
            const newTotalCapital = pos.tradeAmount + tradeAmount;
            const newTotalBuyFees = (pos.buyFeeUSD || 0) + buyFeeUSD;
            // Keep execution price separate from cost basis: fees are already tracked in buyFeeUSD.
            const newMeanBuyPrice = ((pos.buyAsk * oldTokens) + (buyAsk * tokensBought)) / newTotalTokens;
            const dcaCount = (pos.dcaCount || 1) + 1;
            const tpPctFromLatestSignal = buyAsk > 0 ? Math.max(0, (targetHigh - buyAsk) / buyAsk) : 0;
            const slPctFromLatestSignal = buyAsk > 0 ? Math.max(0, (buyAsk - targetLow) / buyAsk) : 0;

            pos.buyAsk = newMeanBuyPrice;
            pos.tradeAmount = newTotalCapital;
            pos.buyFeeUSD = newTotalBuyFees;
            pos.tokensBought = newTotalTokens;
            // Re-anchor risk targets to the new average execution price after DCA.
            pos.targetHigh = newMeanBuyPrice * (1 + tpPctFromLatestSignal);
            pos.targetLow = newMeanBuyPrice * (1 - slPctFromLatestSignal);
            pos.dcaCount = dcaCount;
            pos.triggerSource = `${triggerSource} (DCA x${dcaCount})`;
            pos.indicatorSnapshot = indicatorSnapshot;

            syncAllWalletsWithServer();
            updateAllWalletUIs();
            return true;
        }

        this.tradeCount++;
        const pos = {
            id: `#${this.tradeCount}`,
            entryTime: new Date().toLocaleTimeString(),
            entryTimestamp: Date.now(),
            time: new Date().toLocaleTimeString(),
            timeframe,
            pair,
            buyEx,
            sellEx,
            buyAsk,
            tradeAmount,
            buyFeeUSD,
            tokensBought,
            targetHigh,
            targetLow,
            triggerSource,
            indicatorSnapshot,
            dcaCount: 1,
            currentSellPrice: buyAsk,
            type: this.type
        };

        this.openPositions.push(pos);
        syncAllWalletsWithServer();
        updateAllWalletUIs();
        return true;
    }

    checkLimits(rawTickers) {
        if (this.openPositions.length === 0) return;
        let needsUpdate = false;
        const now = Date.now();

        for (let i = this.openPositions.length - 1; i >= 0; i--) {
            const pos = this.openPositions[i];
            const exName = pos.sellEx ? pos.sellEx.toLowerCase() : 'binance';
            const exCache = rawTickers[exName] || rawTickers['binance'];
            const liveData = exCache ? exCache[pos.pair] : null;

            if (liveData && (liveData.bid > 0 || liveData.ask > 0)) {
                const currentBid = liveData.bid || liveData.ask;
                pos.currentSellPrice = currentBid; 

                const maxHoldMs = getAdaptiveHoldMs(pos.timeframe || '5m');
                if (now - (pos.entryTimestamp || now) >= maxHoldMs) {
                    this.closePosition(i, currentBid, '⏰ ADAPTIVE MAX HOLD EXIT');
                }
                else if (currentBid >= pos.targetHigh) {
                    this.closePosition(i, pos.targetHigh, '🎯 LIMIT TAKE PROFIT HIT');
                }
                else if (currentBid <= pos.targetLow) {
                    this.closePosition(i, pos.targetLow, '🛑 STOP LOSS HIT');
                } else {
                    needsUpdate = true;
                }
            }
        }
        
        if (needsUpdate) updateAllWalletUIs();
    }

    checkSignalExits(signals = []) {
        if (!this.openPositions.length || !Array.isArray(signals)) return;

        for (let i = this.openPositions.length - 1; i >= 0; i--) {
            const pos = this.openPositions[i];
            const sig = signals.find(s => s.pair === pos.pair);
            if (!sig) continue;

            // Never invalidate a position while the strategy still says BUY.
            // In V5 Pullback Spot, BTC regime is context only; it must not cause
            // an immediate sell while the coin's own signal remains healthy.
            const signalLabel = String(sig.finalSignal || '');
            if (signalLabel.includes('BUY')) continue;

            // Give a new trade at least one full strategy candle before allowing
            // signal-invalidation exits. TP/SL remain active immediately.
            const graceMs = Math.max(parseTimeframeToMs(pos.timeframe || '5m'), 60_000);
            const heldMs = Date.now() - Number(pos.entryTimestamp || Date.now());
            if (heldMs < graceMs) continue;

            const structureScore = Number(sig.familyScores?.structure ?? 0);
            const pullbackStructure = Number(sig.pullbackScores?.quality ?? sig.pullbackQualityScore ?? 0);
            const explicitlyAvoid = signalLabel.includes('AVOID') || signalLabel.includes('SELL');
            const hardStructureBreak = structureScore <= -1.0 || String(sig.smcStr || '').toUpperCase().includes('CHOCH');
            const belowTrendSupport = Number(sig.price) > 0 && Number(sig.ema50) > 0 && Number(sig.price) < Number(sig.ema50);

            // Exit only on an actual invalidation of the coin thesis. BTC regime
            // alone is intentionally NOT a universal exit trigger for the V5.4 spot profiles.
            if (explicitlyAvoid && (hardStructureBreak || belowTrendSupport || structureScore <= -1.0)) {
                const exitPrice = pos.currentSellPrice || pos.buyAsk;
                this.closePosition(i, exitPrice, `📉 SIGNAL INVALIDATION (${signalLabel || 'Bearish'})`);
            }
        }
    }

    forceClose(posId) {
        const index = this.openPositions.findIndex(p => p.id === posId);
        if (index === -1) return;
        
        const pos = this.openPositions[index];
        const sellPrice = pos.currentSellPrice || pos.buyAsk;
        
        if (confirm(`Are you sure you want to Market Sell ${pos.pair} at $${formatPrice(sellPrice)}?`)) {
            this.closePosition(index, sellPrice, '✋ MANUAL MARKET SELL NOW');
        }
    }

    closePosition(index, exitPrice, reason) {
        const pos = this.openPositions[index];
        const grossExitUSD = pos.tokensBought * exitPrice;
        const sellFeeUSD = grossExitUSD * this.takerFeeRate;
        const netExitUSD = grossExitUSD - sellFeeUSD;

        this.cashBalance += netExitUSD;

        const totalFeesUSD = (pos.buyFeeUSD || 0) + sellFeeUSD;
        const netProfitUSD = netExitUSD - pos.tradeAmount; 

        const closedRecord = {
            id: pos.id,
            entryTime: pos.entryTime || pos.time,
            closedTime: new Date().toLocaleTimeString(),
            timeframe: pos.timeframe || '1h',
            pair: pos.pair,
            inSignal: pos.triggerSource || 'Manual Entry',
            outSignal: reason,
            indicatorSnapshot: pos.indicatorSnapshot || {},
            route: `${pos.buyEx.toUpperCase()} ➔ ${pos.sellEx.toUpperCase()}`,
            tradeAmount: pos.tradeAmount,
            buyAsk: pos.buyAsk,
            exitPrice,
            buyFeeUSD: pos.buyFeeUSD || 0,
            sellFeeUSD,
            totalFeesUSD,
            netProfitUSD,
            dcaCount: pos.dcaCount || 1,
            newBalance: this.cashBalance,
            type: this.type
        };

        this.closedHistory.unshift(closedRecord);
        this.openPositions.splice(index, 1); 

        syncAllWalletsWithServer();
        updateAllWalletUIs();
    }
}

const manualWallet = new PaperWallet("Manual", 1000);
const autoWallet = new PaperWallet("Auto", 1000);

function syncAllWalletsWithServer() {
    socket.emit('sync-wallet-state', {
        manualWallet: {
            cashBalance: manualWallet.cashBalance,
            startingCapital: manualWallet.startingCapital,
            tradeCount: manualWallet.tradeCount,
            openPositions: manualWallet.openPositions,
            closedHistory: manualWallet.closedHistory
        },
        autoWallet: {
            cashBalance: autoWallet.cashBalance,
            startingCapital: autoWallet.startingCapital,
            tradeCount: autoWallet.tradeCount,
            openPositions: autoWallet.openPositions,
            closedHistory: autoWallet.closedHistory
        }
    });
}

function updateAllWalletUIs() {
    let manualInvested = 0, manualOpenVal = 0, manualUnrealized = 0;

    manualWallet.openPositions.forEach(p => {
        manualInvested += p.tradeAmount;
        const livePrice = p.currentSellPrice || p.buyAsk;
        const currentVal = p.tokensBought * livePrice * (1 - manualWallet.takerFeeRate);
        manualOpenVal += currentVal;
        manualUnrealized += (currentVal - p.tradeAmount);
    });

    const manualEquity = manualWallet.cashBalance + manualOpenVal;
    const balanceEl = document.getElementById('wallet-balance');
    const cashEl = document.getElementById('wallet-cash');
    const investedEl = document.getElementById('wallet-invested');
    
    if (balanceEl) balanceEl.innerText = `$${manualEquity.toFixed(2)}`;
    if (cashEl) cashEl.innerText = `$${manualWallet.cashBalance.toFixed(2)}`;
    if (investedEl) investedEl.innerText = `$${manualInvested.toFixed(2)}`;
    
    const mUnrealizedEl = document.getElementById('wallet-unrealized');
    if (mUnrealizedEl) {
        mUnrealizedEl.innerText = `${manualUnrealized >= 0 ? '+' : ''}$${manualUnrealized.toFixed(2)}`;
        mUnrealizedEl.className = manualUnrealized >= 0 ? 'positive' : 'negative';
    }

    const allClosed = [...manualWallet.closedHistory, ...autoWallet.closedHistory];
    allClosed.sort((a, b) => new Date(b.closedTime) - new Date(a.closedTime));

    const totalRealizedPnl = manualWallet.closedHistory.reduce((sum, t) => sum + t.netProfitUSD, 0);
    const mRealizedEl = document.getElementById('wallet-pnl');
    if (mRealizedEl) {
        mRealizedEl.innerText = `${totalRealizedPnl >= 0 ? '+' : ''}$${totalRealizedPnl.toFixed(2)}`;
        mRealizedEl.className = totalRealizedPnl >= 0 ? 'positive' : 'negative';
    }

    let autoInvested = 0, autoOpenVal = 0, autoUnrealized = 0;

    autoWallet.openPositions.forEach(p => {
        autoInvested += p.tradeAmount;
        const livePrice = p.currentSellPrice || p.buyAsk;
        const currentVal = p.tokensBought * livePrice * (1 - autoWallet.takerFeeRate);
        autoOpenVal += currentVal;
        autoUnrealized += (currentVal - p.tradeAmount);
    });

    const autoEquity = autoWallet.cashBalance + autoOpenVal;
    const aBal = document.getElementById('auto-wallet-balance');
    const aCash = document.getElementById('auto-wallet-cash');
    const aInv = document.getElementById('auto-wallet-invested');
    if (aBal) aBal.innerText = `$${autoEquity.toFixed(2)}`;
    if (aCash) aCash.innerText = `$${autoWallet.cashBalance.toFixed(2)}`;
    if (aInv) aInv.innerText = `$${autoInvested.toFixed(2)}`;

    const aUnrealizedEl = document.getElementById('auto-wallet-unrealized');
    if (aUnrealizedEl) {
        aUnrealizedEl.innerText = `${autoUnrealized >= 0 ? '+' : ''}$${autoUnrealized.toFixed(2)}`;
        aUnrealizedEl.className = autoUnrealized >= 0 ? 'positive' : 'negative';
    }

    const autoRealizedPnl = autoWallet.closedHistory.reduce((sum, t) => sum + t.netProfitUSD, 0);
    const aRealizedEl = document.getElementById('auto-wallet-pnl');
    if (aRealizedEl) {
        aRealizedEl.innerText = `${autoRealizedPnl >= 0 ? '+' : ''}$${autoRealizedPnl.toFixed(2)}`;
        aRealizedEl.className = autoRealizedPnl >= 0 ? 'positive' : 'negative';
    }

    renderPositionTable(manualWallet.openPositions, 'manual-positions-body', manualWallet);
    renderPositionTable(autoWallet.openPositions, 'auto-positions-body', autoWallet);

    updateSignalFilterDropdown(allClosed);
    renderClosedDealsTable();
    renderSignalStudyAnalytics(allClosed);
    renderSignalsTable(); 
}

function updateSignalFilterDropdown(allClosed) {
    const select = document.getElementById('signalFilterSelect');
    if (!select) return;
    const currentVal = select.value;

    let signalsSet = new Set();
    allClosed.forEach(c => {
        signalsSet.add(c.inSignal);
        signalsSet.add(c.outSignal);
    });

    let html = `<option value="ALL">🔍 All Signals (Combined)</option>`;
    signalsSet.forEach(sig => {
        html += `<option value="${sig}" ${currentVal === sig ? 'selected' : ''}>${sig}</option>`;
    });
    select.innerHTML = html;
}

window.renderClosedDealsTable = function() {
    const allClosed = [...manualWallet.closedHistory, ...autoWallet.closedHistory];
    allClosed.sort((a, b) => new Date(b.closedTime) - new Date(a.closedTime));

    const filterVal = document.getElementById('signalFilterSelect')?.value || 'ALL';

    let filtered = allClosed;
    if (filterVal !== 'ALL') {
        filtered = allClosed.filter(c => c.inSignal === filterVal || c.outSignal === filterVal);
    }

    const totalDeals = filtered.length;
    let winningDeals = filtered.filter(t => t.netProfitUSD > 0).length;
    let losingDeals = totalDeals - winningDeals;
    let winRatePct = totalDeals > 0 ? (winningDeals / totalDeals) * 100 : 0;
    let filteredPnl = filtered.reduce((sum, t) => sum + t.netProfitUSD, 0);

    const statTotal = document.getElementById('stat-total-deals');
    const statWinRate = document.getElementById('stat-win-rate');
    const statWl = document.getElementById('stat-wl-count');
    const statPnl = document.getElementById('stat-net-pnl');

    if (statTotal) statTotal.innerText = totalDeals;
    if (statWinRate) {
        statWinRate.innerText = `${winRatePct.toFixed(1)}%`;
        statWinRate.style.color = winRatePct >= 50 ? 'var(--success)' : 'var(--danger)';
    }
    if (statWl) statWl.innerText = `${winningDeals}W / ${losingDeals}L`;
    if (statPnl) {
        statPnl.innerText = `${filteredPnl >= 0 ? '+' : ''}$${filteredPnl.toFixed(2)}`;
        statPnl.className = filteredPnl >= 0 ? 'positive' : 'negative';
    }

    const closedBody = document.getElementById('logs-body');
    if (closedBody) {
        if (filtered.length === 0) {
            closedBody.innerHTML = '<tr><td colspan="13" style="text-align: center; color: #94a3b8;">No matching closed deals for this signal filter.</td></tr>';
        } else {
            closedBody.innerHTML = '';
            filtered.forEach(c => {
                const badge = c.type === 'Auto' ? `<span class="badge-auto">AUTO</span>` : `<span class="badge-manual">MANUAL</span>`;
                const snap = c.indicatorSnapshot || {};
                const snapStr = Object.keys(snap).length > 0 
                    ? `<div style="font-size: 11px; color: #94a3b8; line-height: 1.4;">RSI: ${snap.rsi} | MACD: ${snap.macd} | Stoch: ${snap.stoch || 'N/A'} | ADX: ${snap.adx || 'N/A'} | VWAP: ${snap.vwap || 'N/A'}</div>`
                    : '<span style="color: #94a3b8; font-size: 11px;">No snapshot</span>';

                const pnlClass = c.netProfitUSD >= 0 ? 'positive' : 'negative';
                const pnlSign = c.netProfitUSD >= 0 ? '+' : '';
                const pnlDisplay = `${pnlSign}$${c.netProfitUSD.toFixed(2)} <span style="font-size: 11px; color: #94a3b8;">(Fee: $${(c.totalFeesUSD || 0).toFixed(2)})</span>`;
                const dcaBadge = (c.dcaCount && c.dcaCount > 1) ? `<br><span style="background: rgba(59, 130, 246, 0.2); color: var(--accent); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px;">🔄 DCA x${c.dcaCount}</span>` : `<br><span style="color: var(--text-muted); font-size: 11px;">DCA x1</span>`;

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${c.id}</td>
                    <td><span style="background: rgba(139, 92, 246, 0.15); color: #a78bfa; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px;">${c.timeframe}</span></td>
                    <td>${c.entryTime || '-'}</td>
                    <td>${c.closedTime}</td>
                    <td>${badge}</td>
                    <td style="font-weight: bold;">${c.pair}</td>
                    <td><span style="background: rgba(59, 130, 246, 0.15); color: var(--accent); padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">${c.inSignal}</span></td>
                    <td>${snapStr}</td>
                    <td><span style="background: rgba(239, 68, 68, 0.15); color: #ef4444; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">${c.outSignal}</span></td>
                    <td style="color: #cbd5e1;">$${c.tradeAmount.toFixed(2)}${dcaBadge}</td>
                    <td>$${formatPrice(c.buyAsk)}</td>
                    <td>$${formatPrice(c.exitPrice)}</td>
                    <td class="${pnlClass}">${pnlDisplay}</td>
                `;
                closedBody.appendChild(tr);
            });
        }
    }
};

function renderSignalStudyAnalytics(allClosed) {
    const studyBody = document.getElementById('signal-stats-body');
    if (!studyBody) return;

    if (allClosed.length === 0) {
        studyBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #94a3b8;">No data available for indicator study yet.</td></tr>';
        return;
    }

    let statsMap = {};
    allClosed.forEach(c => {
        const sig = `${c.inSignal} (${c.timeframe})`;
        if (!statsMap[sig]) {
            statsMap[sig] = { total: 0, wins: 0, losses: 0, pnl: 0 };
        }
        statsMap[sig].total++;
        if (c.netProfitUSD > 0) statsMap[sig].wins++;
        else statsMap[sig].losses++;
        statsMap[sig].pnl += c.netProfitUSD;
    });

    studyBody.innerHTML = '';
    Object.keys(statsMap).forEach(sig => {
        const data = statsMap[sig];
        const winRate = (data.wins / data.total) * 100;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><span style="background: rgba(59, 130, 246, 0.15); color: var(--accent); padding: 4px 10px; border-radius: 4px; font-weight: bold;">${sig}</span></td>
            <td style="font-weight: bold;">${data.total}</td>
            <td style="font-weight: bold; color: ${winRate >= 50 ? 'var(--success)' : 'var(--danger)'};">${winRate.toFixed(1)}%</td>
            <td>${data.wins}W / ${data.losses}L</td>
            <td class="${data.pnl >= 0 ? 'positive' : 'negative'}">${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}</td>
        `;
        studyBody.appendChild(tr);
    });
}

function renderPositionTable(positions, tableBodyId, walletInstance) {
    const body = document.getElementById(tableBodyId);
    if (!body) return;
    body.innerHTML = '';

    if (positions.length === 0) {
        body.innerHTML = '<tr><td colspan="11" style="text-align: center; color: #94a3b8;">No active positions in this vault.</td></tr>';
        return;
    }

    positions.forEach(p => {
        const livePrice = p.currentSellPrice || p.buyAsk;
        const estReturn = (p.tokensBought * livePrice * (1 - walletInstance.takerFeeRate)) - p.tradeAmount;
        const pnlColor = estReturn >= 0 ? '#10b981' : '#ef4444';
        
        const elapsedMs = Date.now() - (p.entryTimestamp || Date.now());
        const maxHoldMs = getAdaptiveHoldMs(p.timeframe || '5m');
        const remainingMs = Math.max(0, maxHoldMs - elapsedMs);
        const remMins = Math.floor(remainingMs / 60000);
        const remHrs = Math.floor(remMins / 60);
        const ttlStr = `Adaptive max hold: ${remHrs}h ${remMins % 60}m remaining`;

        const buyFeeStr = `<br><span style="font-size: 11px; color: #f59e0b;">Total Buy Fees: $${(p.buyFeeUSD || 0).toFixed(2)}</span>`;
        const floatingPnlStr = `<br><span style="font-size: 11px; color: ${pnlColor}; font-weight: bold;">Unrealized PNL: ${estReturn >= 0 ? '+' : ''}$${estReturn.toFixed(2)}</span>`;
        const ttlDisplay = `<br><span style="font-size: 11px; color: var(--warning);">${ttlStr}</span>`;
        
        const liveStr = `<span style="color: #f8fafc;">Live Bid: $${formatPrice(livePrice)}</span>${buyFeeStr}${floatingPnlStr}${ttlDisplay}`;
        const signalAlertBadge = getPositionSignalAlert(p.pair);

        const dcaCount = p.dcaCount || 1;
        const dcaBadge = dcaCount > 1 ? `<br><span style="background: rgba(59, 130, 246, 0.2); color: var(--accent); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px;">🔄 DCA x${dcaCount}</span>` : `<br><span style="color: var(--text-muted); font-size: 11px;">DCA x1</span>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${p.id}</td>
            <td>${p.time}</td>
            <td style="font-weight: bold;">${p.pair}</td>
            <td><span style="background: rgba(59, 130, 246, 0.15); color: var(--accent); padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 11px;">${p.triggerSource || 'Signal Entry'}</span></td>
            <td>${signalAlertBadge}</td>
            <td style="color: #cbd5e1;">$${p.tradeAmount.toFixed(2)}${dcaBadge}</td>
            <td>$${formatPrice(p.buyAsk)}</td>
            <td class="positive">$${formatPrice(p.targetHigh)}</td>
            <td class="negative">$${formatPrice(p.targetLow)}</td>
            <td>
                <div style="color: #3b82f6; font-weight: bold; margin-bottom: 5px;">⏳ ACTIVE</div>
                <div style="font-size: 13px; color: #cbd5e1;">${liveStr}</div>
            </td>
            <td>
                <button class="action-btn warning" onclick="forceCloseWalletPosition('${walletInstance.type}', '${p.id}')" style="padding: 6px 10px; font-size: 12px;">Market Sell</button>
            </td>
        `;
        body.appendChild(tr);
    });
}

window.forceCloseWalletPosition = function(walletType, id) {
    if (walletType === 'Auto') autoWallet.forceClose(id);
    else manualWallet.forceClose(id);
};

socket.on('load-wallet-state', (state) => {
    if (state.manualWallet) {
        manualWallet.cashBalance = state.manualWallet.cashBalance;
        manualWallet.startingCapital = state.manualWallet.startingCapital;
        manualWallet.tradeCount = state.manualWallet.tradeCount;
        manualWallet.openPositions = state.manualWallet.openPositions;
        manualWallet.closedHistory = state.manualWallet.closedHistory;
    }
    if (state.autoWallet) {
        autoWallet.cashBalance = state.autoWallet.cashBalance;
        autoWallet.startingCapital = state.autoWallet.startingCapital;
        autoWallet.tradeCount = state.autoWallet.tradeCount;
        autoWallet.openPositions = state.autoWallet.openPositions;
        autoWallet.closedHistory = state.autoWallet.closedHistory;
    }
    updateAllWalletUIs();
});

window.resetAccount = function() {
    if (confirm("Are you sure you want to completely reset all wallets back to $1,000 clean slates?")) {
        fetch('/api/reset-wallet')
            .then(res => res.json())
            .then(data => {
                if (data.success) location.reload();
            });
    }
};

window.openImportModal = function() { document.getElementById('importModal').style.display = 'flex'; };
window.closeImportModal = function() { document.getElementById('importModal').style.display = 'none'; };

window.submitImportJson = function() {
    const raw = document.getElementById('importJsonText').value.trim();
    try {
        const json = JSON.parse(raw);
        fetch('/api/import-wallet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(json)
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                closeImportModal();
                location.reload();
            } else { alert("❌ Import failed."); }
        });
    } catch (e) { alert("❌ Invalid JSON syntax."); }
};

let currentTradeContext = null;

window.manualPaperTrade = function(pair, buyEx, sellEx, buyAsk, tp1, tp2, tp3, sl, triggerSource = "Manual Screener") {
    const sigObj = latestSignalsArray.find(s => s.pair === pair) || {};
    const indicatorSnapshot = {
        rsi: sigObj.rsi || 'N/A',
        macd: sigObj.macdStr || 'N/A',
        stoch: sigObj.stochStr || 'N/A',
        adx: sigObj.adxStr || 'N/A',
        vwap: sigObj.vwapStr || 'N/A',
        smc: sigObj.smcStr || 'N/A',
        ichimoku: sigObj.ichimokuStr || 'N/A',
        consensus: sigObj.finalSignal || 'N/A'
    };
    const currentTimeframe = document.getElementById('timeframeSelect')?.value || '1h';

    const activeInfo = getActivePositionForPair(pair);
    const modalDcaNotice = activeInfo ? ` ⚠️ [DCA Mode: Holding $${activeInfo.pos.tradeAmount.toFixed(2)} in ${activeInfo.wallet} Vault]` : '';

    currentTradeContext = { pair, buyEx, sellEx, buyAsk, tp1, tp2, tp3, sl, triggerSource, indicatorSnapshot, timeframe: currentTimeframe };
    document.getElementById('modalTitle').innerText = `🧪 Paper Trade: ${pair}`;
    document.getElementById('modalSubtitle').innerText = `Spot Buy on ${buyEx.toUpperCase()} ➔ Sell on ${sellEx.toUpperCase()} | Entry Price: $${formatPrice(buyAsk)} (${currentTimeframe})${modalDcaNotice}`;
    document.getElementById('modalBalance').innerText = `$${manualWallet.cashBalance.toFixed(2)}`;
    document.getElementById('modalAmount').value = 100;
    
    document.getElementById('modalTpTargetSelect').value = "TP2";
    applyModalTargetChoice();
    document.getElementById('tradeModal').style.display = 'flex';
};

window.applyModalTargetChoice = function() {
    if (!currentTradeContext) return;
    const choice = document.getElementById('modalTpTargetSelect').value;
    let tpPct = currentTradeContext.tp2 || 2.0;
    if (choice === 'TP1') tpPct = currentTradeContext.tp1 || 1.0;
    if (choice === 'TP3') tpPct = currentTradeContext.tp3 || 3.5;
    
    document.getElementById('modalTpPct').value = tpPct;
    document.getElementById('modalSlPct').value = currentTradeContext.sl || 1.5;
    updateModalPrices();
};

function updateModalPrices() {
    if (!currentTradeContext) return;
    const buyAsk = currentTradeContext.buyAsk;
    const tpPct = parseFloat(document.getElementById('modalTpPct').value) || 0;
    const slPct = parseFloat(document.getElementById('modalSlPct').value) || 0;
    document.getElementById('modalTpPrice').value = (buyAsk * (1 + (tpPct / 100))).toFixed(8).replace(/\.?0+$/, '');
    document.getElementById('modalSlPrice').value = (buyAsk * (1 - (slPct / 100))).toFixed(8).replace(/\.?0+$/, '');
}

function updateModalPcts() {
    if (!currentTradeContext) return;
    const buyAsk = currentTradeContext.buyAsk;
    const tpPrice = parseFloat(document.getElementById('modalTpPrice').value) || 0;
    const slPrice = parseFloat(document.getElementById('modalSlPrice').value) || 0;
    if (buyAsk > 0) {
        document.getElementById('modalTpPct').value = (((tpPrice - buyAsk) / buyAsk) * 100).toFixed(2);
        document.getElementById('modalSlPct').value = (((buyAsk - slPrice) / buyAsk) * 100).toFixed(2);
    }
}

document.getElementById('modalTpPct').addEventListener('input', updateModalPrices);
document.getElementById('modalSlPct').addEventListener('input', updateModalPrices);
document.getElementById('modalTpPrice').addEventListener('input', updateModalPcts);
document.getElementById('modalSlPrice').addEventListener('input', updateModalPcts);

window.closeModal = function() {
    document.getElementById('tradeModal').style.display = 'none';
    currentTradeContext = null;
};

window.submitModalTrade = function() {
    if (!currentTradeContext) return;
    const tradeAmount = parseFloat(document.getElementById('modalAmount').value);
    const targetHigh = parseFloat(document.getElementById('modalTpPrice').value);
    const targetLow = parseFloat(document.getElementById('modalSlPrice').value);
    const sourceLabel = currentTradeContext.triggerSource || "Manual Entry";
    const snapshot = currentTradeContext.indicatorSnapshot || {};
    const tf = currentTradeContext.timeframe || '1h';

    if (isNaN(tradeAmount) || tradeAmount <= 0) { alert("❌ Invalid trade amount."); return; }
    if (isNaN(targetHigh) || isNaN(targetLow)) { alert("❌ Invalid limits."); return; }

    manualWallet.openPosition(
        currentTradeContext.pair, 
        currentTradeContext.buyEx, 
        currentTradeContext.sellEx, 
        currentTradeContext.buyAsk, 
        targetHigh, 
        targetLow, 
        tradeAmount,
        sourceLabel,
        snapshot,
        tf
    );
    closeModal();
};

window.switchTab = function(tabId) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    
    const targetTab = document.getElementById(tabId);
    if (targetTab) targetTab.classList.add('active');
    
    document.querySelectorAll('.tab-btn').forEach(b => {
        if (b.getAttribute('onclick')?.includes(tabId)) {
            b.classList.add('active');
        }
    });

    if (tabId === 'bubbles-tab') {
        fetchAllPairs();
    }
    if (tabId === 'charts-grid-tab') {
        setTimeout(() => {
            window.loadChartGridPreset();
        }, 100);
    }
};

let latestSignalsArray = [];
let signalSortCol = 'consensus'; 
let signalSortAsc = false;
let showSpotOnly = true;

window.toggleSpotFilter = function() {
    showSpotOnly = document.getElementById('spotFilterToggle').checked;
    renderSignalsTable();
    window.calculatePortfolioAllocation();
};



const TIMEFRAME_STRATEGY_INFO = {
    '1m':  { label: 'Execution Only / Fill Timing', detail: 'No standalone entries. Use after a higher-timeframe BUY to improve execution.' },
    '3m':  { label: 'Execution Only / Micro Confirmation', detail: 'No standalone entries. Use for micro confirmation after 5m/15m/30m setup.' },
    '5m':  { label: 'Entry Trigger / Micro Trend', detail: 'Strict VWAP/EMA reclaim + momentum trigger. Designed for fast entries, not oversold guessing.' },
    '15m': { label: 'Trend Pullback + Reclaim', detail: 'Buy controlled dips inside an existing bullish trend after support/reclaim confirmation.' },
    '30m': { label: 'Recovery Reversal', detail: 'Exhaustion is WATCH only; BUY requires recovery/reclaim confirmation.' },
    '1h':  { label: 'Controlled Trend / Pullback', detail: 'Trend-aligned continuation with reasonable location; avoid chased entries.' },
    '2h':  { label: 'Swing Pullback Continuation', detail: 'Swing pullback into EMA/VWAP support with recovery confirmation.' },
    '4h':  { label: 'Trend Continuation', detail: 'Main medium-term trend continuation with structure and momentum alignment.' },
    '6h':  { label: 'Trend Continuation / Swing Hold', detail: 'Slower continuation setup with wider holding window.' },
    '8h':  { label: 'Swing Trend Continuation', detail: 'Higher-timeframe trend and structure continuation.' },
    '12h': { label: 'Macro Pullback', detail: 'Macro trend dip/retest entries rather than short-term reversal chasing.' },
    '1d':  { label: 'Macro Trend Continuation', detail: 'Daily trend/structure continuation for position-style spot trades.' },
    '3d':  { label: 'Position Trend / Major Pullback', detail: 'Position trade bias with major trend and structure alignment.' },
    '1w':  { label: 'Macro Regime / Position Bias', detail: 'Long-horizon regime and position bias; very low signal frequency.' }
};

function updateTimeframeStrategyHint(tf) {
    const info = TIMEFRAME_STRATEGY_INFO[tf] || { label: 'Timeframe Edge', detail: '' };
    const el = document.getElementById('timeframeStrategyHint');
    if (el) el.innerHTML = `<strong>${tf} best fit:</strong> ${info.label}<br><span style="color:var(--text-muted);">${info.detail}</span>`;
}

window.changeLiveStrategyProfile = function() {
    const profile = document.getElementById('liveStrategyProfileSelect')?.value || 'TIMEFRAME_EDGE_SPOT';
    const sigBody = document.getElementById('signals-body');
    if (sigBody) sigBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted);">Loading ${profile} signals...</td></tr>`;
    socket.emit('change-strategy-profile', profile);
};

window.changeTimeframe = function() {
    const tf = document.getElementById('timeframeSelect').value;
    updateTimeframeStrategyHint(tf);
    const portSelect = document.getElementById('portfolioTimeframeSelect');
    if (portSelect) portSelect.value = tf;
    
    const sigBody = document.getElementById('signals-body');
    if (sigBody) sigBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Fetching ${tf} ATR candles from Binance...</td></tr>`;
    socket.emit('change-timeframe', tf);
};

window.changePortfolioTimeframe = function() {
    const tf = document.getElementById('portfolioTimeframeSelect').value;
    updateTimeframeStrategyHint(tf);
    const mainSelect = document.getElementById('timeframeSelect');
    if (mainSelect) mainSelect.value = tf;

    const portBody = document.getElementById('portfolio-allocation-body');
    if (portBody) portBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Fetching ${tf} candle indicators for ranking...</td></tr>`;
    
    socket.emit('change-timeframe', tf);
};

window.sortSignals = function(col) {
    if (signalSortCol === col) { signalSortAsc = !signalSortAsc; } 
    else { signalSortCol = col; signalSortAsc = false; }
    renderSignalsTable();
};

function resolveUiTargetLevel(choice, timeframe) {
    if (choice !== 'AUTO') return choice;
    return ['1m','3m','5m','15m','30m'].includes(timeframe) ? 'TP2' : 'TP3';
}

window.calculatePortfolioAllocation = function() {
    const tbody = document.getElementById('portfolio-allocation-body');
    if (!tbody || latestSignalsArray.length === 0) return;

    const totalBudget = parseFloat(document.getElementById('portfolioBudget').value) || 1000;
    const maxCoinsValue = document.getElementById('maxPortfolioCoins').value || '5';
    const maxCoins = maxCoinsValue === 'ALL' ? Infinity : (parseInt(maxCoinsValue) || 5);
    const requestedTpLevel = document.getElementById('portfolioTpLevel')?.value || "AUTO";
    const portfolioTf = document.getElementById('portfolioTimeframeSelect')?.value || '30m';
    const chosenTpLevel = resolveUiTargetLevel(requestedTpLevel, portfolioTf);

    let candidates = latestSignalsArray.filter(s => s.finalSignal && s.finalSignal.includes('BUY'));
    candidates.sort((a, b) => b.consensusScore - a.consensusScore || parseFloat(b.rsi) - parseFloat(a.rsi));

    const topPool = candidates.slice(0, maxCoins);
    if (topPool.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No BUY-qualified spot coins are visible in Tech Signals right now. Auto screener standing by...</td></tr>';
        return;
    }

    let totalQualityScore = 0;
    topPool.forEach(coin => {
        const safeSLPct = parseFloat(coin.suggestedSL) || 1.5;
        let chosenTpPct = parseFloat(coin.tp2) || 2.0;
        let chosenTpPrice = coin.tp2Price || (coin.price * 1.02);

        if (chosenTpLevel === 'TP1') {
            chosenTpPct = parseFloat(coin.tp1) || 1.0;
            chosenTpPrice = coin.tp1Price || (coin.price * 1.01);
        } else if (chosenTpLevel === 'TP3') {
            chosenTpPct = parseFloat(coin.tp3) || 3.5;
            chosenTpPrice = coin.tp3Price || (coin.price * 1.035);
        }

        coin.chosenDynamicTpPct = chosenTpPct;
        coin.chosenDynamicTpPrice = chosenTpPrice;

        const rrRatio = chosenTpPct / Math.max(safeSLPct, 0.1);
        const qualityScore = Math.max(coin.consensusScore, 1) * (1 + rrRatio);
        coin.calcQualityScore = qualityScore;
        totalQualityScore += qualityScore;
    });

    tbody.innerHTML = '';
    topPool.forEach((coin, index) => {
        const winWeightFraction = coin.calcQualityScore / totalQualityScore;
        const assignedCapital = totalBudget * winWeightFraction;
        const winWeightPctStr = (winWeightFraction * 100).toFixed(1);

        const safeSLPct = parseFloat(coin.suggestedSL) || 1.5;
        const chosenTpPct = coin.chosenDynamicTpPct;
        const chosenTpPrice = coin.chosenDynamicTpPrice;
        const slPrice = coin.stopPrice || (coin.price * (1 - (safeSLPct / 100)));

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight: bold; color: var(--accent);">#${index + 1}</td>
            <td style="font-weight: bold;">${coin.pair}</td>
            <td style="font-weight: bold; color: ${coin.signalColor};">${coin.finalSignal}</td>
            <td class="positive">+${chosenTpPct.toFixed(2)}% <span style="font-size: 11px; color: #a78bfa;">(${winWeightPctStr}% Pool)</span></td>
            <td style="font-weight: bold; color: var(--success);">$${assignedCapital.toFixed(2)}</td>
            <td class="negative">$${formatPrice(slPrice)} (-${safeSLPct.toFixed(2)}%)</td>
            <td class="positive">$${formatPrice(chosenTpPrice)} (+${chosenTpPct.toFixed(2)}%)</td>
        `;
        tbody.appendChild(tr);
    });
};

window.deployPortfolio = function() {
    const totalBudget = parseFloat(document.getElementById('portfolioBudget').value) || 1000;
    const maxCoinsValue = document.getElementById('maxPortfolioCoins').value || '5';
    const maxCoins = maxCoinsValue === 'ALL' ? Infinity : (parseInt(maxCoinsValue) || 5);
    const requestedTpLevel = document.getElementById('portfolioTpLevel')?.value || "AUTO";
    const portfolioTf = document.getElementById('portfolioTimeframeSelect')?.value || '30m';
    const chosenTpLevel = resolveUiTargetLevel(requestedTpLevel, portfolioTf);

    let candidates = latestSignalsArray.filter(s => s.finalSignal && s.finalSignal.includes('BUY'));
    candidates.sort((a, b) => b.consensusScore - a.consensusScore);
    const topPool = candidates.slice(0, maxCoins);

    if (topPool.length === 0) { alert("❌ No BUY-qualified spot assets are currently available in Tech Signals."); return; }

    let executionBudget = totalBudget;
    if (autoWallet.cashBalance < totalBudget) {
        if (!confirm(`Your Auto Portfolio cash is $${autoWallet.cashBalance.toFixed(2)}. Deploy max available cash ($${autoWallet.cashBalance.toFixed(2)})?`)) {
            return;
        }
        executionBudget = autoWallet.cashBalance;
    }

    let totalQualityScore = 0;
    topPool.forEach(coin => {
        const safeSLPct = parseFloat(coin.suggestedSL) || 1.5;
        let chosenTpPct = parseFloat(coin.tp2) || 2.0;
        if (chosenTpLevel === 'TP1') chosenTpPct = parseFloat(coin.tp1) || 1.0;
        if (chosenTpLevel === 'TP3') chosenTpPct = parseFloat(coin.tp3) || 3.5;

        const rrRatio = chosenTpPct / Math.max(safeSLPct, 0.1);
        const qualityScore = Math.max(coin.consensusScore, 1) * (1 + rrRatio);
        coin.calcQualityScore = qualityScore;
        totalQualityScore += qualityScore;
    });

    let deployedCount = 0;
    topPool.forEach((coin) => {
        const winWeightFraction = coin.calcQualityScore / totalQualityScore;
        const assignedCapital = executionBudget * winWeightFraction;

        const safeSLPct = parseFloat(coin.suggestedSL) || 1.5;
        let chosenTpPct = parseFloat(coin.tp2) || 2.0;
        let chosenTpPrice = coin.tp2Price || (coin.price * 1.02);

        if (chosenTpLevel === 'TP1') {
            chosenTpPct = parseFloat(coin.tp1) || 1.0;
            chosenTpPrice = coin.tp1Price || (coin.price * 1.01);
        } else if (chosenTpLevel === 'TP3') {
            chosenTpPct = parseFloat(coin.tp3) || 3.5;
            chosenTpPrice = coin.tp3Price || (coin.price * 1.035);
        }

        const slPrice = coin.stopPrice || (coin.price * (1 - (safeSLPct / 100)));

        const sigObj = latestSignalsArray.find(s => s.pair === coin.pair) || {};
        const indicatorSnapshot = {
            rsi: sigObj.rsi || 'N/A',
            macd: sigObj.macdStr || 'N/A',
            stoch: sigObj.stochStr || 'N/A',
            adx: sigObj.adxStr || 'N/A',
            vwap: sigObj.vwapStr || 'N/A',
            smc: sigObj.smcStr || 'N/A',
            ichimoku: sigObj.ichimokuStr || 'N/A',
            consensus: sigObj.finalSignal || 'N/A'
        };
        const currentTimeframe = document.getElementById('portfolioTimeframeSelect')?.value || '30m';

        const success = autoWallet.openPosition(
            coin.pair, 'binance', 'binance', coin.price, chosenTpPrice, slPrice, assignedCapital, `Auto Tech Signals (${coin.finalSignal}, ${chosenTpLevel})`, indicatorSnapshot, currentTimeframe
        );
        if (success) deployedCount++;
    });

    alert(`🚀 Successfully deployed portfolio across ${deployedCount} Tech Signals BUY assets targeting ${chosenTpLevel}!`);
    switchTab('closed-deals-tab');
};

function renderSignalsTable() {
    const sigBody = document.getElementById('signals-body');
    if (!sigBody) return;
    if (latestSignalsArray.length === 0) {
        sigBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #94a3b8;">Initializing background engine...</td></tr>';
        return;
    }

    let displayArray = [...latestSignalsArray];
    if (showSpotOnly) {
        displayArray = displayArray.filter(s => s.finalSignal.includes('BUY'));
    }

    displayArray.sort((a, b) => {
        let valA, valB;
        if (signalSortCol === 'pair') { valA = a.pair; valB = b.pair; }
        else if (signalSortCol === 'price') { valA = a.price; valB = b.price; }
        else if (signalSortCol === 'momentum') { valA = parseFloat(a.rsi); valB = parseFloat(b.rsi); }
        else if (signalSortCol === 'trend') { valA = a.macroEmaStr; valB = b.macroEmaStr; }
        else if (signalSortCol === 'smc') { valA = a.smcStr; valB = b.smcStr; }
        else if (signalSortCol === 'atr') { valA = parseFloat(a.tp1); valB = parseFloat(b.tp1); } 
        else if (signalSortCol === 'consensus') { valA = a.consensusScore; valB = b.consensusScore; }

        if (valA < valB) return signalSortAsc ? -1 : 1;
        if (valA > valB) return signalSortAsc ? 1 : -1;
        return 0;
    });

    sigBody.innerHTML = '';
    if (displayArray.length === 0) {
        sigBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #94a3b8;">No valid Spot Buy signals right now under this timeframe.</td></tr>';
        return;
    }
    
    displayArray.forEach(s => {
        const tr = document.createElement('tr');
        let tradeBtn = '';
        if (s.finalSignal.includes('BUY')) {
            tradeBtn = `<button class="trade-btn" onclick="manualPaperTrade('${s.pair}', 'binance', 'binance', ${s.price}, ${s.tp1}, ${s.tp2}, ${s.tp3}, ${s.suggestedSL}, 'Alpha Tech Screener')">🟢 Buy Spot</button>`;
        } else if (s.finalSignal.includes('WATCH') || s.finalSignal.includes('WAIT')) {
            tradeBtn = `<span style="color:#f59e0b; font-size:12px; font-weight:bold;">🟡 Watch / Wait</span>`;
        } else if (s.finalSignal.includes('AVOID')) {
            tradeBtn = `<span style="color:#ef4444; font-size:12px; font-weight:bold;">🔴 Avoid / Cash</span>`;
        } else {
            tradeBtn = `<span style="color:var(--text-muted); font-size:12px; font-weight:bold;">⚪ Cash / No Entry</span>`;
        }

        const activeInfo = getActivePositionForPair(s.pair);
        let activeBadge = '';
        if (activeInfo) {
            const avgP = activeInfo.pos.buyAsk;
            const dcaCount = activeInfo.pos.dcaCount || 1;
            const dcaText = dcaCount > 1 ? ` (DCA x${dcaCount})` : '';
            activeBadge = `<span class="badge-active">📍 Active in ${activeInfo.wallet} Vault (Avg: $${formatPrice(avgP)})${dcaText}</span>`;
        }

        tr.innerHTML = `
            <td style="font-weight: bold;">
                ${s.pair}
                <span class="sub-text" style="color:#a78bfa;">${s.recommendedStrategy || s.setupType || ''}</span>
                ${activeBadge}
            </td>
            <td>
                $${formatPrice(s.price)}
                <span class="sub-text">VPVR POC: $${formatPrice(s.vpvr?.pocPrice)}</span>
                <span class="sub-text ${getValClass(s.bbStatus)}">BB: ${s.bbStatus} (${s.bbWidth})</span>
            </td>
            <td>
                RSI: ${s.rsi} | Stoch: <span class="${getValClass(s.stochStr)}">${s.stochStr}</span>
                <span class="sub-text ${getValClass(s.macdStr)}">MACD: ${s.macdStr}</span>
            </td>
            <td>
                EMA 9/21: <span class="${getValClass(s.emaStr)}">${s.emaStr}</span>
                <span class="sub-text ${getValClass(s.vwapStr)}">VWAP: ${s.vwapStr}</span>
            </td>
            <td>
                SMC: <span class="${getValClass(s.smcStr)}">${s.smcStr}</span> | ADX: <span class="${getValClass(s.adxStr)}">${s.adxStr}</span>
                <span class="sub-text">
                    <span class="${getValClass(s.linRegStr)}">${s.linRegStr}</span> | 
                    <span class="${getValClass(s.utBotStr)}">${s.utBotStr}</span> |
                    <span class="${getValClass(s.ichimokuStr)}">${s.ichimokuStr}</span>
                </span>
            </td>
            <td style="font-weight: bold; color: ${s.signalColor};">
                ${s.finalSignal}
                ${s.kronosLabel ? `<span class="sub-text" style="color:${s.kronosLabel === 'BULLISH' ? '#34d399' : s.kronosLabel === 'BEARISH' ? '#f87171' : '#94a3b8'};">🧠 Kronos: ${s.kronosLabel} ${Number(s.kronosForecastReturnPct || 0) >= 0 ? '+' : ''}${Number(s.kronosForecastReturnPct || 0).toFixed(2)}% · score ${Number(s.kronosScore || 0).toFixed(2)}</span>` : `<span class="sub-text" style="color:#64748b;">🧠 Kronos: waiting/offline</span>`}
            </td>
            <td style="font-size: 12px; font-weight: bold; line-height: 1.5;">
                <span class="negative">SL (2.5x ATR): $${formatPrice(s.stopPrice)} (-${s.suggestedSL}%)</span><br>
                <span class="positive">TP1 (1.0x ATR): $${formatPrice(s.tp1Price)} (+${s.tp1}%)</span><br>
                <span class="positive">TP2 (2.0x ATR): $${formatPrice(s.tp2Price)} (+${s.tp2}%)</span><br>
                <span class="positive">TP3 (3.5x ATR): $${formatPrice(s.tp3Price)} (+${s.tp3}%)</span>
            </td>
            <td>${tradeBtn}</td>
        `;
        sigBody.appendChild(tr);
    });
}

socket.on('signals-update', (signals) => {
    latestSignalsArray = Object.keys(signals).map(k => ({ pair: k, ...signals[k] }));

    const regimeBanner = document.getElementById('liveRegimeBanner');
    const regime = latestSignalsArray.find(s => s.regime)?.regime;
    if (regimeBanner && regime) {
        const allowed = regime.allowLong === true;
        regimeBanner.innerHTML = `<strong>BTC Higher-Timeframe Spot Context:</strong> ${regime.label} (score ${regime.score}) · ADX ${regime.adx ?? '-'} · RSI ${regime.rsi ?? '-'}<br><span style="color: var(--text-muted);">V5 records BTC regime as context; Pullback Spot entries are decided by the coin's trend, pullback location, and upward-turn confirmation.</span>`;
        regimeBanner.style.borderLeftColor = allowed ? 'var(--success)' : 'var(--warning)';
    }
    
    const fallbackTickers = { binance: {} };
    latestSignalsArray.forEach(s => {
        fallbackTickers.binance[s.pair] = { bid: s.price, ask: s.price };
    });
    
    // V5.5: TP/SL/max-hold execution is owned by the Node backend.
    // The browser is display/control only; closing this tab must not stop exits.
    renderSignalsTable();
    window.calculatePortfolioAllocation();
});

socket.on('global-scanner-update', (payload) => {
    const results = payload.opportunities || [];
    const rawTickers = payload.rawTickers || {};
    const status = payload.status || {};

    // V5.5: raw quotes are displayed here, but position exits are server-managed.
    const scanBody = document.getElementById('scanner-body');
    if (!scanBody) return;

    if (results.length === 0) {
        const fresh = status.freshQuoteCounts || {};
        const stats = status.quoteStats || {};
        const venueText = Object.keys(fresh).length
            ? Object.entries(fresh).map(([name, count]) => `${name.toUpperCase()}: ${count}`).join(' | ')
            : 'Waiting for exchange quotes';
        const errorText = stats.venues
            ? Object.entries(stats.venues)
                .filter(([, v]) => v?.lastError)
                .map(([name, v]) => `${name.toUpperCase()}: ${v.lastError}`)
                .slice(0, 2)
                .join(' • ')
            : '';

        scanBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align:center; padding:24px;">
                    <div style="font-weight:bold; color:var(--warning); margin-bottom:6px;">No cross-exchange quotes can be compared yet.</div>
                    <div style="color:var(--text-muted); font-size:12px; line-height:1.6;">
                        Quote candidates: ${status.arbitragePairs ?? 0} · Strict metadata-verified: ${status.strictlyVerifiedPairs ?? 0} · Mode: ${(status.identityMode || 'safe').toUpperCase()}<br>
                        Fresh quote cache: ${venueText}<br>
                        ${stats.lastRefreshAt ? `Last refresh: ${new Date(stats.lastRefreshAt).toLocaleTimeString()} (${stats.lastRefreshMs || 0} ms)` : 'First quote refresh is still running.'}
                        ${errorText ? `<br><span style="color:var(--danger);">${errorText}</span>` : ''}
                    </div>
                </td>
            </tr>`;
        return;
    }

    scanBody.innerHTML = '';
    results.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight: bold;">${r.pair}</td>
            <td>
                ${r.route}<br>
                ${r.identityVerified
                    ? `<span style="font-size:11px;color:var(--success);font-weight:bold;">🔐 Asset identity verified (${r.identityMethod || 'metadata'})</span>`
                    : `<span style="font-size:11px;color:var(--warning);font-weight:bold;">🛡️ Identity safety fallback (${r.identityMethod || 'price sanity'})</span>`}
                ${Array.isArray(r.sharedNetworks) && r.sharedNetworks.length ? `<br><span style="font-size:10px;color:var(--text-muted);">Shared network: ${r.sharedNetworks.join(', ')}</span>` : ''}
                ${!r.identityVerified && r.identityReason ? `<br><span style="font-size:10px;color:var(--text-muted);">${r.identityReason}</span>` : ''}
            </td>
            <td>$${formatPrice(r.buyAsk)}</td>
            <td>$${formatPrice(r.sellBid)}</td>
            <td class="${r.netSpread > 0 ? 'positive' : 'negative'}">
                Gross: ${r.grossSpread >= 0 ? '+' : ''}${r.grossSpread.toFixed(3)}%<br>
                <span style="font-size:11px; color:${r.netSpread > 0 ? 'var(--success)' : 'var(--danger)'};">Net est.: ${r.netSpread >= 0 ? '+' : ''}${Number(r.netSpread || 0).toFixed(3)}%</span>
            </td>
            <td>
                ${r.executableAfterFees
                    ? `<span style="background:rgba(16,185,129,.18);color:var(--success);padding:4px 8px;border-radius:4px;font-size:11px;font-weight:bold;">✅ Net-positive quote</span>`
                    : `<span style="color:var(--text-muted);font-size:11px;">Fees erase spread</span>`}
            </td>
        `;
        scanBody.appendChild(tr);
    });
});
setTimeout(() => updateTimeframeStrategyHint(document.getElementById('timeframeSelect')?.value || '5m'), 0);
