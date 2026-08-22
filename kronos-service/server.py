import json, os, sys, math, traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor" / "Kronos"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

MODEL_NAME = os.getenv("KRONOS_MODEL", "NeoQuasar/Kronos-small")
TOKENIZER_NAME = os.getenv("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base")
PORT = int(os.getenv("KRONOS_PORT", "8765"))
DEVICE_ENV = os.getenv("KRONOS_DEVICE", "auto")
LOOKBACK = int(os.getenv("KRONOS_LOOKBACK", "192"))
SAMPLE_COUNT = int(os.getenv("KRONOS_SAMPLE_COUNT", "3"))

predictor = None
model_error = None

def tf_seconds(tf):
    table = {"1m":60,"3m":180,"5m":300,"15m":900,"30m":1800,"1h":3600,"2h":7200,"4h":14400,"6h":21600,"8h":28800,"12h":43200,"1d":86400,"3d":259200,"1w":604800}
    return table.get(str(tf).lower(), 1800)

def horizon_for_tf(tf):
    return {"1m":12,"3m":10,"5m":8,"15m":6,"30m":6,"1h":5,"2h":4,"4h":4,"6h":3,"8h":3,"12h":3,"1d":3,"3d":2,"1w":2}.get(str(tf).lower(), 4)

def init_model():
    global predictor, model_error
    try:
        if not VENDOR.exists():
            raise RuntimeError(f"Kronos source missing at {VENDOR}. Run setup-kronos first.")
        import torch
        from model import Kronos, KronosTokenizer, KronosPredictor
        device = DEVICE_ENV
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        tokenizer = KronosTokenizer.from_pretrained(TOKENIZER_NAME)
        model = Kronos.from_pretrained(MODEL_NAME)
        predictor = KronosPredictor(model, tokenizer, device=device, max_context=512)
        model_error = None
        print(f"[Kronos] loaded {MODEL_NAME} on {device}", flush=True)
    except Exception as e:
        model_error = str(e)
        predictor = None
        print(f"[Kronos] unavailable: {model_error}", flush=True)

def build_forecast(payload):
    if predictor is None:
        return {"ok":False,"available":False,"error":model_error or "Kronos model unavailable"}
    candles = payload.get("candles") or []
    tf = payload.get("timeframe") or "30m"
    if len(candles) < 60:
        return {"ok":False,"available":True,"error":"Need at least 60 candles"}
    import pandas as pd
    usable = candles[-min(len(candles), LOOKBACK):]
    rows = []
    timestamps = []
    for c in usable:
        if not isinstance(c, (list,tuple)) or len(c) < 5: continue
        ts, o, h, l, cl = c[:5]
        v = c[5] if len(c) > 5 else 0
        rows.append([float(o),float(h),float(l),float(cl),float(v or 0)])
        timestamps.append(pd.to_datetime(int(ts), unit='ms', utc=True))
    if len(rows) < 60:
        return {"ok":False,"available":True,"error":"Not enough valid candles"}
    x_df = pd.DataFrame(rows, columns=["open","high","low","close","volume"])
    x_ts = pd.Series(timestamps)
    horizon = int(payload.get("horizon") or horizon_for_tf(tf))
    step = tf_seconds(tf)
    last_ts = timestamps[-1]
    y_ts = pd.Series([last_ts + pd.Timedelta(seconds=step*(i+1)) for i in range(horizon)])
    pred = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=horizon, T=1.0, top_p=0.9, sample_count=max(1, SAMPLE_COUNT))
    last_close = float(x_df.iloc[-1]["close"])
    closes = [float(v) for v in pred["close"].tolist()]
    highs = [float(v) for v in pred["high"].tolist()]
    lows = [float(v) for v in pred["low"].tolist()]
    end_close = closes[-1]
    ret = (end_close-last_close)/last_close*100 if last_close else 0
    max_up = (max(highs)-last_close)/last_close*100 if last_close else 0
    max_down = (min(lows)-last_close)/last_close*100 if last_close else 0
    positive_steps = sum(1 for c in closes if c > last_close)
    directional = positive_steps / max(1,len(closes))
    # Bounded score: forecast assists the technical engine but cannot overpower it.
    score = max(-1.5, min(1.5, ret/2.0))
    if directional >= .67: score += .25
    elif directional <= .33: score -= .25
    score = max(-1.75, min(1.75, score))
    label = "BULLISH" if score >= .55 else "BEARISH" if score <= -.55 else "NEUTRAL"
    confidence = min(1.0, abs(score)/1.75 * .75 + abs(directional-.5)*.5)
    return {
        "ok":True,"available":True,"model":MODEL_NAME,"timeframe":tf,"horizon":horizon,
        "lastClose":last_close,"forecastEndClose":end_close,"forecastReturnPct":ret,
        "forecastMaxUpsidePct":max_up,"forecastMaxDownsidePct":max_down,
        "positiveStepRatio":directional,"score":score,"label":label,"confidence":confidence,
        "pathClose":closes
    }

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/health":
            self._send(200,{"ok":True,"available":predictor is not None,"model":MODEL_NAME,"error":model_error})
        else: self._send(404,{"ok":False,"error":"not found"})
    def do_POST(self):
        if self.path != "/forecast": return self._send(404,{"ok":False,"error":"not found"})
        try:
            length = int(self.headers.get("Content-Length","0")); payload = json.loads(self.rfile.read(length) or b"{}")
            self._send(200, build_forecast(payload))
        except Exception as e:
            traceback.print_exc(); self._send(500,{"ok":False,"available":predictor is not None,"error":str(e)})
    def log_message(self, fmt, *args):
        return

if __name__ == "__main__":
    init_model()
    print(f"[Kronos] service listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
