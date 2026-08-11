let historicalDataCache = [];
let lastBatchExport = null;
let currentResearchJobId = null;
let researchPollTimer = null;
let lastHistoricalScan = null;

    const defaultStartDate = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
    const defaultEndDate = new Date();
    document.getElementById('histStartDate').value = defaultStartDate.toISOString().slice(0, 16);
    document.getElementById('histEndDate').value = defaultEndDate.toISOString().slice(0, 16);

    function getHistoricalRange() {
        const startTimestamp = document.getElementById('histStartDate').value;
        const endTimestamp = document.getElementById('histEndDate').value;
        const startMs = new Date(startTimestamp).getTime();
        const endMs = new Date(endTimestamp).getTime();
        if (!startTimestamp || !endTimestamp || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            alert('❌ Please choose both a valid start and end date/time.');
            return null;
        }
        if (endMs <= startMs) {
            alert('❌ Historical End Date & Time must be after the start.');
            return null;
        }
        if (endMs > Date.now()) {
            alert('❌ The historical end date cannot be in the future.');
            return null;
        }
        return { startTimestamp, endTimestamp, startMs, endMs };
    }

    async function loadHistoricalScreener() {
        const range = getHistoricalRange();
        if (!range) return;
        const { startTimestamp, endTimestamp } = range;
        const timeframe = document.getElementById('histTimeframe').value;
        const scanLimit = document.getElementById('histScanLimit')?.value || 'all';
        const strategyProfile = document.getElementById('strategyProfile')?.value || 'TIMEFRAME_EDGE_SPOT';
        const body = document.getElementById('screenerBody');

        body.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Scanning ${scanLimit === 'all' ? 'all eligible' : 'top ' + scanLimit + ' liquid'} Binance pairs at the interval start...</td></tr>`;
        const diagEl = document.getElementById('scanDiagnostics');
        if (diagEl) diagEl.innerText = 'Historical scan in progress. Large universes can take longer because Binance requires one OHLCV request per pair.';
        document.getElementById('simResultPanel').style.display = 'none';
        document.getElementById('batchSummaryPanel').style.display = 'none';

        try {
            const res = await fetch('/api/historical-screener', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ startTimestamp, timeframe, scanLimit, strategyProfile })
            });

            const data = await res.json();
            if (!data.success) {
                alert('❌ Failed: ' + data.message);
                return;
            }

            historicalDataCache = data.signals || [];
            lastHistoricalScan = {
                startTimestamp,
                timeframe,
                scanLimit: String(scanLimit),
                strategyProfile
            };
            const d = data.diagnostics || {};
            document.getElementById('scanPointLabel').innerText = `Test Interval: ${new Date(startTimestamp).toLocaleString()} → ${new Date(endTimestamp).toLocaleString()} | ${data.strategyProfile || strategyProfile} | ${timeframe}`;
            const regimeEl = document.getElementById('regimeDiagnostics');
            if (regimeEl && data.benchmark?.regime) {
                const r = data.benchmark.regime;
                regimeEl.style.display = 'block';
                regimeEl.innerHTML = `<strong>BTC ${data.benchmark.timeframe} Spot Regime:</strong> ${r.label} (score ${r.score}) · ADX ${r.adx} · RSI ${r.rsi} · ${r.structure || ''}<br><span style="color:var(--text-muted);">BTC regime is recorded as context. V5.4 uses timeframe-specific coin gates; BTC context is not a universal hard veto.</span>`;
            }
            if (diagEl) {
                const secs = Number(d.elapsedMs || 0) / 1000;
                diagEl.innerHTML = `Scanned <strong>${d.requested ?? 0}</strong> pairs · analyzed <strong>${d.analyzed ?? 0}</strong> · BUY/STRONG BUY <strong>${d.buySignals ?? 0}</strong> · failed <strong>${d.failed ?? 0}</strong> · ${secs.toFixed(1)}s`;
                if ((d.failed || 0) > 0 && Array.isArray(d.failures) && d.failures.length) {
                    diagEl.innerHTML += `<br><span style="color: var(--warning);">Sample failures: ${d.failures.slice(0, 4).map(f => `${f.pair}: ${f.error}`).join(' | ')}</span>`;
                }
            }
            renderHistoricalTable();

        } catch (e) {
            if (diagEl) diagEl.innerText = `Historical scan failed: ${e.message}`;
            alert('❌ Network/Server Error: ' + e.message);
        }
    }

    function renderHistoricalTable() {
        const body = document.getElementById('screenerBody');
        const spotOnly = document.getElementById('spotOnlyCheck').checked;

        let displayArray = [...historicalDataCache];
        if (spotOnly) {
            displayArray = displayArray.filter(s => s.finalSignal.includes('BUY'));
        }

        if (displayArray.length === 0) {
            if (historicalDataCache.length > 0 && spotOnly) {
                body.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">The scan worked, but there were no BUY/STRONG BUY signals at this timestamp. Turn off SPOT MODE to inspect all analyzed pairs.</td></tr>';
            } else {
                body.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No analyzable historical results were returned. Check the diagnostics above for failed requests or unavailable candle history.</td></tr>';
            }
            return;
        }

        body.innerHTML = '';
        displayArray.forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight: bold;">${s.pair}</td>
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
                <td style="font-weight: bold; color: ${s.signalColor};">${s.finalSignal}<span class="sub-text">Regime: ${s.regime?.label || 'N/A'} · ADX ${s.adxValue ?? ''} · RVOL ${s.relativeVolume ?? ''}</span>${(s.rejectionReasons || []).length ? `<span class="sub-text" style="color:var(--warning);">${s.rejectionReasons.slice(0,2).join(' · ')}</span>` : ''}</td>
                <td style="font-size: 12px; font-weight: bold; line-height: 1.5;">
                    <span class="negative">SL (1.5x ATR): $${formatPrice(s.stopPrice)} (-${s.suggestedSL}%)</span><br>
                    <span class="positive">TP1: $${formatPrice(s.tp1Price)} (+${s.tp1}%)</span><br>
                    <span class="positive">TP2: $${formatPrice(s.tp2Price)} (+${s.tp2}%)</span><br>
                    <span class="positive">TP3: $${formatPrice(s.tp3Price)} (+${s.tp3}%)</span>
                </td>
                <td>
                    <button class="trade-btn" onclick="fastForwardSingleTrade('${s.pair}')">🟢 Buy Spot</button>
                </td>
            `;
            body.appendChild(tr);
        });
    }

    function csvEscape(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }

    function safeFilePart(value) {
        return String(value || '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    }

    function downloadTextFile(filename, text, mimeType) {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function buildBatchAnalysisCsv(data) {
        const stats = data.stats || {};
        const runId = `run-${Date.now()}`;
        const headers = [
            'run_id','range_start','range_end','strategy_profile','benchmark_timeframe','timeframe','requested_tp_level','effective_tp_level','trade_amount_per_coin','symbols_tested',
            'run_total_trades','run_wins','run_losses','run_win_rate_pct','run_net_pnl_usd','run_profit_factor',
            'run_gross_profit_usd','run_gross_loss_usd','run_avg_pnl_usd','run_avg_win_usd','run_avg_loss_usd',
            'run_total_fees_usd','run_avg_drawdown_pct','run_avg_hold_hours',
            'trade_id','pair','entry_time','exit_time','entry_signal','exit_reason','entry_price','exit_price',
            'target_tp_price','stop_loss_price','trade_amount_usd','fees_usd','net_pnl_usd','max_drawdown_pct',
            'lowest_price_dip','hold_hours','rsi','macd','stoch','adx','adx_value','relative_volume','atr_pct','vwap','smc','ichimoku','consensus',
            'consensus_score','regime','regime_score','regime_adx','regime_rsi','regime_atr_pct','regime_structure','rejection_reasons','trend_score','momentum_score','structure_score','participation_score','volatility_score'
        ];

        const rows = (data.results || []).map((r, idx) => {
            const snap = r.snapshot || {};
            const fam = snap.families || {};
            return [
                runId, data.range?.start, data.range?.end, data.strategyProfile, data.benchmarkTimeframe, data.timeframe, data.tpLevel, data.effectiveTpLevel,
                data.tradeAmountPerCoin, data.symbolsTested,
                stats.totalTrades, stats.wins, stats.losses, stats.winRate, stats.netPnl, stats.profitFactor,
                stats.grossProfit, stats.grossLoss, stats.avgPnl, stats.avgWin, stats.avgLoss,
                stats.totalFees, stats.avgDrawdownPct, stats.avgHoldHours,
                r.id || `#${idx + 1}`, r.pair, r.entryTime, r.exitTime || r.closedTime, r.inSignal, r.exitReason || r.outSignal,
                r.entryPrice ?? r.buyAsk, r.exitPrice, r.targetTpPrice, r.stopLossPrice, r.tradeAmount,
                r.totalFeesUSD ?? r.fees, r.netProfitUSD, r.maxDrawdownPct, r.lowestPriceDip, r.holdHours,
                snap.rsi, snap.macd, snap.stoch, snap.adx, snap.adxValue, snap.relativeVolume, snap.atrPct, snap.vwap, snap.smc, snap.ichimoku, snap.consensus,
                snap.score, snap.regime, snap.regimeScore, snap.regimeAdx, snap.regimeRsi, snap.regimeAtrPct, snap.regimeStructure, snap.rejectionReasons, fam.trend, fam.momentum, fam.structure, fam.participation, fam.volatility
            ];
        });

        if (!rows.length) {
            rows.push([
                runId, data.range?.start, data.range?.end, data.strategyProfile, data.benchmarkTimeframe, data.timeframe, data.tpLevel, data.effectiveTpLevel,
                data.tradeAmountPerCoin, data.symbolsTested,
                stats.totalTrades, stats.wins, stats.losses, stats.winRate, stats.netPnl, stats.profitFactor,
                stats.grossProfit, stats.grossLoss, stats.avgPnl, stats.avgWin, stats.avgLoss,
                stats.totalFees, stats.avgDrawdownPct, stats.avgHoldHours
            ]);
        }

        return [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
    }

    function exportLastBatchCsv() {
        if (!lastBatchExport) return;
        const start = safeFilePart(lastBatchExport.range?.start?.slice(0, 16));
        const end = safeFilePart(lastBatchExport.range?.end?.slice(0, 16));
        const filename = `quant-batch_${lastBatchExport.strategyProfile}_${lastBatchExport.timeframe}_${lastBatchExport.effectiveTpLevel || lastBatchExport.tpLevel}_${start}_to_${end}.csv`;
        downloadTextFile(filename, buildBatchAnalysisCsv(lastBatchExport), 'text/csv;charset=utf-8');
    }


    function buildCoinSummaryCsv(data) {
        const headers = [
            'range_start','range_end','strategy_profile','benchmark_timeframe','timeframe','requested_tp_level','effective_tp_level','starting_capital_per_coin',
            'pair','status','candles_scanned','final_balance','net_pnl_usd','return_pct','trades','wins','losses','win_rate_pct','profit_factor','total_fees_usd','avg_drawdown_pct','avg_hold_hours','data_error'
        ];
        const rows = (data.coinSummaries || []).map(c => [
            data.range?.start, data.range?.end, data.strategyProfile, data.benchmarkTimeframe, data.timeframe, data.tpLevel, data.effectiveTpLevel, data.tradeAmountPerCoin,
            c.pair, c.status, c.candlesScanned, c.finalBalance, c.netPnlUSD, c.returnPct, c.trades, c.wins, c.losses, c.winRatePct,
            Number.isFinite(c.profitFactor) ? c.profitFactor : 'INF', c.totalFeesUSD, c.avgDrawdownPct, c.avgHoldHours, c.error || ''
        ]);
        return [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
    }

    function exportCoinSummaryCsv() {
        if (!lastBatchExport) return;
        const start = safeFilePart(lastBatchExport.range?.start?.slice(0, 16));
        const end = safeFilePart(lastBatchExport.range?.end?.slice(0, 16));
        const filename = `quant-coin-summary_${lastBatchExport.strategyProfile}_${lastBatchExport.timeframe}_${lastBatchExport.effectiveTpLevel || lastBatchExport.tpLevel}_${start}_to_${end}.csv`;
        downloadTextFile(filename, buildCoinSummaryCsv(lastBatchExport), 'text/csv;charset=utf-8');
    }
    function exportLastBatchJson() {
        if (!lastBatchExport) return;
        const start = safeFilePart(lastBatchExport.range?.start?.slice(0, 16));
        const end = safeFilePart(lastBatchExport.range?.end?.slice(0, 16));
        const filename = `quant-batch_${lastBatchExport.strategyProfile}_${lastBatchExport.timeframe}_${lastBatchExport.effectiveTpLevel || lastBatchExport.tpLevel}_${start}_to_${end}.json`;
        downloadTextFile(filename, JSON.stringify(lastBatchExport, null, 2), 'application/json;charset=utf-8');
    }

    function updateResearchProgress(job) {
        const panel = document.getElementById('researchProgressPanel');
        const text = document.getElementById('researchProgressText');
        const pctEl = document.getElementById('researchProgressPct');
        const bar = document.getElementById('researchProgressBar');
        const last = document.getElementById('researchLastSaved');
        const folder = document.getElementById('researchOutputFolder');
        const zipBtn = document.getElementById('downloadResearchZipBtn');
        if (panel) panel.style.display = 'block';
        const total = Number(job.totalCoins || 0);
        const done = Number(job.completedCoins || 0);
        const pct = total ? Math.min(100, (done / total) * 100) : 0;
        if (pctEl) pctEl.innerText = `${pct.toFixed(1)}%`;
        if (bar) bar.style.width = `${pct}%`;
        if (text) text.innerHTML = `<strong>${job.status}</strong> · ${done}/${total} coins · Current: <strong>${job.currentCoin || '-'}</strong><br>${job.currentMessage || ''}<br>Trades saved: <strong>${job.totalTrades || 0}</strong> · traded coins: ${job.tradedCoins || 0} · no signals: ${job.noSignalCoins || 0} · data errors: ${job.dataErrorCoins || 0}`;
        if (last) last.innerText = job.lastCompleted ? `Last saved: ${job.lastCompleted.pair} → ${job.lastCompleted.csv_file} (${job.lastCompleted.status})` : '';
        if (folder) folder.innerText = job.outputFolder ? `Server folder: ${job.outputFolder}` : '';
        if (zipBtn) zipBtn.style.display = job.downloadReady ? 'inline-block' : 'none';

        document.getElementById('batchTotal').innerText = job.totalTrades || 0;
        document.getElementById('batchWinRate').innerText = `${Number(job.winRatePct || 0).toFixed(1)}%`;
        document.getElementById('batchWl').innerText = `${job.totalWins || 0}W / ${job.totalLosses || 0}L`;
        const pnlEl = document.getElementById('batchNetPnl');
        if (pnlEl) {
            const pnl = Number(job.totalNetPnlUSD || 0);
            pnlEl.innerText = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
            pnlEl.className = pnl >= 0 ? 'positive' : 'negative';
        }
        document.getElementById('batchProfitFactor').innerText = job.profitFactor ?? '0.00';
        document.getElementById('batchAvgPnl').innerText = job.totalTrades ? `${(job.totalNetPnlUSD / job.totalTrades) >= 0 ? '+' : ''}$${(job.totalNetPnlUSD / job.totalTrades).toFixed(2)}` : '$0.00';
        document.getElementById('batchAvgDrawdown').innerText = 'see per-coin CSV';
        const intervalNote = document.getElementById('batchIntervalDiagnostics');
        if (intervalNote) intervalNote.innerHTML = `Sequential job: <strong>${done}/${total}</strong> coins complete · one coin is fully tested and saved before the next starts.`;
    }

    async function pollResearchJob(jobId) {
        if (researchPollTimer) clearTimeout(researchPollTimer);
        try {
            const res = await fetch(`/api/research-jobs/${encodeURIComponent(jobId)}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Research status failed');
            const job = data.job;
            updateResearchProgress(job);
            if (job.status === 'COMPLETED' || job.status === 'FAILED') {
                researchPollTimer = null;
                if (job.status === 'COMPLETED') {
                    const body = document.getElementById('batchResultsBody');
                    body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--success);"><strong>Research complete.</strong><br>${job.completedCoins} coin CSV files were saved one-by-one. Download the ZIP above, or use the files directly from <code>${job.outputFolder}</code>.</td></tr>`;
                }
                return;
            }
            researchPollTimer = setTimeout(() => pollResearchJob(jobId), 1000);
        } catch (e) {
            const text = document.getElementById('researchProgressText');
            if (text) text.innerHTML = `<span style="color:var(--danger)">Progress check failed: ${e.message}. Retrying...</span>`;
            researchPollTimer = setTimeout(() => pollResearchJob(jobId), 3000);
        }
    }

    async function runBatchSimulation() {
        const range = getHistoricalRange();
        if (!range) return;
        const { startTimestamp, endTimestamp } = range;
        const timeframe = document.getElementById('histTimeframe').value;
        const tradeAmountPerCoin = document.getElementById('histAmount').value;
        const tpLevel = document.getElementById('histTpTarget').value;
        const strategyProfile = document.getElementById('strategyProfile')?.value || 'TIMEFRAME_EDGE_SPOT';
        const scanLimit = document.getElementById('histScanLimit')?.value || 'all';
        const spotOnlyResearch = Boolean(document.getElementById('spotOnlyCheck')?.checked);
        let selectedSymbols = null;

        if (spotOnlyResearch) {
            const scanMatches = lastHistoricalScan
                && lastHistoricalScan.startTimestamp === startTimestamp
                && lastHistoricalScan.timeframe === timeframe
                && String(lastHistoricalScan.scanLimit) === String(scanLimit)
                && lastHistoricalScan.strategyProfile === strategyProfile;

            if (!scanMatches) {
                alert('❌ SPOT MODE is checked. First click “Scan Market at Interval Start” with the current start date, timeframe, strategy, and universe. The sequential run will then use only those BUY / STRONG BUY coins.');
                return;
            }

            selectedSymbols = historicalDataCache
                .filter(s => String(s.finalSignal || '').includes('BUY'))
                .map(s => s.pair);

            if (selectedSymbols.length === 0) {
                alert('❌ SPOT MODE is checked, but the interval-start scan found no BUY / STRONG BUY coins. Uncheck SPOT MODE to research the full selected universe, or choose another start point.');
                return;
            }
        }

        const summaryPanel = document.getElementById('batchSummaryPanel');
        const body = document.getElementById('batchResultsBody');
        summaryPanel.style.display = 'block';
        summaryPanel.scrollIntoView({ behavior: 'smooth' });
        body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-muted);">Creating sequential research job. The server will process ONE coin at a time and save its CSV before starting the next coin. If SPOT MODE is checked, only BUY / STRONG BUY coins from the current interval-start scan are queued.</td></tr>`;
        document.getElementById('downloadResearchZipBtn').style.display = 'none';
        document.getElementById('researchProgressPanel').style.display = 'block';
        document.getElementById('researchProgressText').innerText = 'Creating job...';

        try {
            const res = await fetch('/api/research-jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    timeframe, startTimestamp, endTimestamp, tradeAmountPerCoin, tpLevel, strategyProfile, scanLimit,
                    spotOnlyResearch, selectedSymbols
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Could not create research job');
            currentResearchJobId = data.job.id;
            updateResearchProgress(data.job);
            pollResearchJob(currentResearchJobId);
        } catch (e) {
            alert('❌ Research job error: ' + e.message);
        }
    }

    async function fastForwardSingleTrade(symbol) {
        const range = getHistoricalRange();
        if (!range) return;
        const { startTimestamp, endTimestamp } = range;
        const timeframe = document.getElementById('histTimeframe').value;
        const tradeAmount = document.getElementById('histAmount').value;
        const tpLevel = document.getElementById('histTpTarget').value;
        const strategyProfile = document.getElementById('strategyProfile')?.value || 'TIMEFRAME_EDGE_SPOT';

        const resultPanel = document.getElementById('simResultPanel');
        const closedBody = document.getElementById('simClosedLogsBody');
        const headerBox = document.getElementById('tradeSummaryHeader');

        closedBody.innerHTML = '<tr><td colspan="14" style="text-align: center; color: var(--text-muted);">Warming indicators before the selected start, entering at the next tradable candle open, then testing only until the selected interval end...</td></tr>';
        resultPanel.style.display = 'block';
        resultPanel.scrollIntoView({ behavior: 'smooth' });

        try {
            const res = await fetch('/api/backtest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    symbol, 
                    timeframe, 
                    startTimestamp,
                    endTimestamp, 
                    tradeAmount, 
                    tpLevel,
                    strategyProfile,
                    forceManualEntry: true 
                })
            });

            const data = await res.json();
            if (!data.success) {
                alert('❌ Fast-forward error: ' + data.message);
                return;
            }

            headerBox.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <strong style="font-size: 16px; color: var(--accent);">${data.pair} Fast-Forward Simulation Audit</strong>
                        <div style="font-size: 12px; color: var(--text-muted);">Profile: <strong>${data.strategyProfile}</strong> | Timeframe: <strong>${data.timeframe}</strong> | Target: <strong>${data.effectiveTpLevel || tpLevel}</strong> | BTC regime TF: <strong>${data.benchmarkTimeframe || '-'}</strong> | Range: <strong>${new Date(data.range.start).toLocaleString()} → ${new Date(data.range.end).toLocaleString()}</strong> | Scanned ${data.totalCandlesScanned} candles</div>
                    </div>
                    <div style="text-align: right;">
                        <span style="font-size: 12px; color: var(--text-muted);">Trade Result P/L:</span>
                        <div class="${data.totalPnl >= 0 ? 'positive' : 'negative'}" style="font-size: 20px;">
                            ${data.totalPnl >= 0 ? '+' : ''}$${data.totalPnl}
                        </div>
                    </div>
                </div>
            `;

            closedBody.innerHTML = '';
            if (!data.closedDeals || data.closedDeals.length === 0) {
                closedBody.innerHTML = '<tr><td colspan="14" style="text-align: center; color: var(--text-muted);">Simulation ended without trade exit.</td></tr>';
                return;
            }

            data.closedDeals.forEach((deal, idx) => {
                const tr = document.createElement('tr');
                const pnlClass = deal.netProfitUSD >= 0 ? 'positive' : 'negative';
                const pnlSign = deal.netProfitUSD >= 0 ? '+' : '';
                
                let exitBadgeClass = 'badge-exit-win';
                if (deal.netProfitUSD < 0) exitBadgeClass = 'badge-exit-loss';
                if (deal.outSignal.includes('TTL')) exitBadgeClass = 'badge-exit-ttl';

                tr.innerHTML = `
                    <td style="font-weight: bold;">#${idx + 1}</td>
                    <td><span class="badge-tf">${deal.timeframe}</span></td>
                    <td>${deal.entryTime}</td>
                    <td>${deal.closedTime}</td>
                    <td><span class="badge-type">MANUAL</span></td>
                    <td style="font-weight: bold;">${deal.pair}</td>
                    <td><span class="badge-signal">${deal.inSignal}</span></td>
                    <td>
                        <div style="font-size: 11px; color: #94a3b8; line-height: 1.4;">
                            RSI: ${deal.snapshot.rsi} | MACD: ${deal.snapshot.macd} | Stoch: ${deal.snapshot.stoch} | ADX: ${deal.snapshot.adx} | VWAP: ${deal.snapshot.vwap}
                        </div>
                    </td>
                    <td><span class="${exitBadgeClass}">${deal.outSignal}</span></td>
                    <td>$${deal.tradeAmount.toFixed(2)}<br><span style="color: var(--text-muted); font-size: 11px;">DCA x1</span></td>
                    <td>$${formatPrice(deal.buyAsk)}</td>
                    <td style="color: var(--danger); font-weight: bold;">
                        $${formatPrice(deal.lowestPriceDip)} 
                        <span style="font-size: 11px; color: #94a3b8;">(-${deal.maxDrawdownPct}%)</span>
                    </td>
                    <td>$${formatPrice(deal.exitPrice)}</td>
                    <td class="${pnlClass}">
                        ${pnlSign}$${deal.netProfitUSD.toFixed(2)} 
                        <span style="font-size: 11px; color: #94a3b8;">(Fee: $${deal.totalFeesUSD.toFixed(2)})</span>
                    </td>
                `;
                closedBody.appendChild(tr);
            });

        } catch (e) {
            alert('❌ Network Error: ' + e.message);
        }
    }

    document.getElementById('downloadBatchCsvBtn')?.addEventListener('click', exportLastBatchCsv);
    document.getElementById('downloadCoinSummaryCsvBtn')?.addEventListener('click', exportCoinSummaryCsv);
    document.getElementById('downloadBatchJsonBtn')?.addEventListener('click', exportLastBatchJson);

    document.getElementById('downloadResearchZipBtn')?.addEventListener('click', () => { if (currentResearchJobId) window.location.href = `/api/research-jobs/${encodeURIComponent(currentResearchJobId)}/download`; });
