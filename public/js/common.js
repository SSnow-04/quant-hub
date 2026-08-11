// Shared browser helpers used by both the live dashboard and historical tester.

function formatPrice(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return '0.00000000';
    if (Math.abs(n) < 0.0001) return n.toFixed(18).replace(/\.?0+$/, '');
    if (Math.abs(n) < 0.01) return n.toFixed(8);
    if (Math.abs(n) < 1) return n.toFixed(6);
    return n.toFixed(4);
}

function getValClass(value) {
    if (!value) return 'val-neut';
    const s = String(value).toLowerCase();
    if (s.includes('bull') || s.includes('uptrend') || s.includes('above cloud') ||
        s.includes('above') || s.includes('ut long') || s.includes('discount') ||
        s.includes('buy') || s.includes('os reversal') || s.includes('oversold') ||
        s.includes('trending')) return 'val-bull';
    if (s.includes('bear') || s.includes('downtrend') || s.includes('below cloud') ||
        s.includes('below') || s.includes('ut short') || s.includes('overextended') ||
        s.includes('sell') || s.includes('ob reversal') || s.includes('overbought')) return 'val-bear';
    return 'val-neut';
}
