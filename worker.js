/* =====================================================
   強震モニタ collector（Cloudflare Worker + Durable Object）
   ・強震モニタの取得とGIF解析はここ1か所だけで行う
   ・ブラウザには wss で差分だけを配信する
   ・閲覧者が0人の間は取得しない
   ===================================================== */

import { DurableObject } from "cloudflare:workers";

const BASE_URL =
  "http://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_s/";

const LATEST_URL =
  "http://www.kmoni.bosai.go.jp/webservice/server/pros/latest.json";

const POINTS_URL =
  "https://raw.githubusercontent.com/ingen084/kyoshin-monitor-observation-points/refs/heads/master/intensity-points.json";

/* 取得間隔(ms)。500にすると反応は速いが、無料プランの1日10万リクエストを超えやすい */
const POLL_MS = 1000;

/* 最新時刻の画像が無い時に遡る秒数 */
const FALLBACK_SECONDS = 3;

const FETCH_TIMEOUT = 4500;

/* 空なら全許可。自分のサイトだけにするなら ["https://あなたのサイト"] */
const ALLOWED_ORIGINS = [];

/* =====================================================
   入口
   ===================================================== */

export default {
  async fetch(req, env) {
    if (req.headers.get("Upgrade") !== "websocket") {
      /* ブラウザで /status を開くと取得係の状態が見える（確認用） */
      if (new URL(req.url).pathname === "/status") {
        const id = env.COLLECTOR.idFromName("main");
        return env.COLLECTOR.get(id).fetch(req);
      }

      return new Response("wss only (collector v2)", { status: 426 });
    }

    if (ALLOWED_ORIGINS.length) {
      const origin = req.headers.get("Origin") || "";
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return new Response("forbidden", { status: 403 });
      }
    }

    const id = env.COLLECTOR.idFromName("main");
    return env.COLLECTOR.get(id).fetch(req);
  },
};

/* =====================================================
   Durable Object（全員で共有する1つだけの取得係）
   ===================================================== */

export class Collector extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.points = null;
    this.stations = [];
    this.prevKeys = new Uint32Array(0);

    this.w = 0;
    this.h = 0;

    this.lastMs = 0;
    this.serverMs = 0;
    this.lastErr = "";
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") {
      const jst = this.lastMs
        ? new Date(this.lastMs + 9 * 3600e3)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19) + " JST"
        : null;

      const alarm = await this.ctx.storage.getAlarm();

      return new Response(
        JSON.stringify(
          {
            version: "collector v2",
            clients: this.ctx.getWebSockets().length,
            stations: this.stations.length,
            lastImage: jst,
            serverMs: this.serverMs,
            lastErr: this.lastErr,
            alarmScheduled: alarm !== null,
          },
          null,
          2
        ),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    /* 途中参加者には現在の全状態を先に送る */
    if (this.lastMs && this.stations.length) {
      try {
        server.send(this.buildFrame(this.fullIndices(), true));
      } catch (_) {}
    }

    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* クライアントのping。再起動後でも取得を再開させる */
  async webSocketMessage(ws, message) {
    await this.ensureAlarm();
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch (_) {}
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "error");
    } catch (_) {}
  }

  async ensureAlarm() {
    const current = await this.ctx.storage.getAlarm();

    if (current === null) {
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }
  }

  /* 1回のalarm = 新しい実行枠なので、サブリクエスト上限(50)にも当たらない */
  async alarm() {
    const clients = this.ctx.getWebSockets().length;

    /* 誰もいなければ止める */
    if (clients === 0) return;

    const t0 = Date.now();

    try {
      await this.step(clients);
      this.lastErr = "";
    } catch (e) {
      const msg = String((e && e.message) || e);

      if (msg !== this.lastErr) {
        this.lastErr = msg;
        this.broadcastText(JSON.stringify({ type: "error", msg }));
      }
    }

    const wait = Math.max(100, POLL_MS - (Date.now() - t0));

    await this.ctx.storage.setAlarm(Date.now() + wait);
  }

  async step(clients) {
    const t0 = Date.now();

    const latest = await this.fetchLatest();

    if (latest <= this.lastMs) return;

    const points = await this.loadPoints();

    let img = null;
    let usedMs = 0;
    let lastError = null;

    for (let i = 0; i <= FALLBACK_SECONDS; i++) {
      const cand = latest - i * 1000;

      if (cand <= this.lastMs) break;

      try {
        const res = await fetch(imageUrlFor(cand), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
        });

        if (!res.ok) {
          throw new Error("画像 HTTP " + res.status);
        }

        const buf = new Uint8Array(await res.arrayBuffer());

        if (!buf.length) {
          throw new Error("空の画像");
        }

        img = decodeGif(buf);
        usedMs = cand;

        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!img) {
      throw new Error(
        "最新画像を取得できません。" + ((lastError && lastError.message) || "")
      );
    }

    /* 画像サイズが変わった時(初回含む)は観測点を作り直し、全員に全データを送る */
    let rebuilt = false;

    if (img.W !== this.w || img.H !== this.h || !this.stations.length) {
      this.w = img.W;
      this.h = img.H;

      this.stations = points.filter(
        (p) => p.x >= 0 && p.y >= 0 && p.x < img.W && p.y < img.H
      );

      this.prevKeys = new Uint32Array(this.stations.length);
      rebuilt = true;
    }

    const changed = [];
    const n = this.stations.length;
    const pal = img.pal;

    for (let i = 0; i < n; i++) {
      const s = this.stations[i];

      const col = s.x - img.left;
      const row = s.y - img.top;

      let key = 0;

      if (col >= 0 && row >= 0 && col < img.w && row < img.h) {
        const ci = img.px[img.rowPos[row] * img.w + col];

        if (ci !== img.trans && pal && ci * 3 + 2 < pal.length) {
          const o = ci * 3;
          key = ((1 << 24) | (pal[o] << 16) | (pal[o + 1] << 8) | pal[o + 2]) >>> 0;
        }
      }

      if (key !== this.prevKeys[i]) {
        this.prevKeys[i] = key;
        changed.push(i);
      }
    }

    this.lastMs = usedMs;
    this.serverMs = Date.now() - t0;

    const frame = rebuilt
      ? this.buildFrame(this.fullIndices(), true, clients)
      : this.buildFrame(changed, false, clients);

    this.broadcastBinary(frame);
  }

  fullIndices() {
    const out = [];

    for (let i = 0; i < this.prevKeys.length; i++) {
      if (this.prevKeys[i] !== 0) out.push(i);
    }

    return out;
  }

  /* [type u8][画像時刻ms f64][幅 u16][高さ u16][flags u8]
     [観測点総数 u16][件数 u16][サーバー処理ms u16][閲覧数 u16]
     続けて件数ぶん
     [index u16][有効 u8][r u8][g u8][b u8][スケール値 f32] (little endian)
     スケール値 = 色を多項式補間で変換した値（手順④の結果） */
  buildFrame(indices, full, clients) {
    const count = indices.length;

    const out = new Uint8Array(22 + count * 10);
    const dv = new DataView(out.buffer);

    dv.setUint8(0, 1);
    dv.setFloat64(1, this.lastMs, true);
    dv.setUint16(9, this.w, true);
    dv.setUint16(11, this.h, true);
    dv.setUint8(13, full ? 1 : 0);
    dv.setUint16(14, this.stations.length, true);
    dv.setUint16(16, count, true);
    dv.setUint16(18, Math.min(this.serverMs, 65535), true);
    dv.setUint16(20, clients ?? this.ctx.getWebSockets().length, true);

    let o = 22;

    for (let k = 0; k < count; k++) {
      const i = indices[k];
      const key = this.prevKeys[i];

      const r = (key >> 16) & 255;
      const g = (key >> 8) & 255;
      const b = key & 255;

      /* ④ 色 → スケール値（多項式補間） */
      const position = key ? colorToPosition(rgbToHSV(r, g, b)) : null;

      dv.setUint16(o, i, true);

      out[o + 2] = position === null ? 0 : 1;
      out[o + 3] = r;
      out[o + 4] = g;
      out[o + 5] = b;

      dv.setFloat32(o + 6, position === null ? 0 : position, true);

      o += 10;
    }

    return out;
  }

  broadcastBinary(data) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch (_) {}
    }
  }

  broadcastText(text) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch (_) {}
    }
  }

  async fetchLatest() {
    const res = await fetch(LATEST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      throw new Error("latest.json HTTP " + res.status);
    }

    const raw = await res.text();

    let data;

    try {
      data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch (_) {
      throw new Error("latest.jsonのJSON解析に失敗しました");
    }

    return findLatestTime(data);
  }

  async loadPoints() {
    if (this.points) return this.points;

    const res = await fetch(POINTS_URL, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error("観測点JSON HTTP " + res.status);
    }

    const raw = await res.text();
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));

    const recs = walkRecords(data);

    if (!recs.length) {
      throw new Error("観測点データが見つかりません");
    }

    const prepared = preparePoints(recs);

    if (!prepared.length) {
      throw new Error("有効な観測点がありません");
    }

    this.points = prepared;

    return prepared;
  }
}

/* =====================================================
   時刻まわり
   ===================================================== */

const p2 = (n) => String(n).padStart(2, "0");

function imageUrlFor(ms) {
  const d = new Date(ms + 9 * 3600e3);

  const Y = d.getUTCFullYear();
  const M = p2(d.getUTCMonth() + 1);
  const D = p2(d.getUTCDate());
  const h = p2(d.getUTCHours());
  const m = p2(d.getUTCMinutes());
  const s = p2(d.getUTCSeconds());

  return `${BASE_URL}${Y}${M}${D}/${Y}${M}${D}${h}${m}${s}.jma_s.gif`;
}

function parseTimeValue(value) {
  if (typeof value === "number") {
    if (value > 1000000000000) return value;
    if (value > 1000000000) return value * 1000;
    return null;
  }

  if (typeof value !== "string") return null;

  const s = value.trim();

  if (/^\d{14}$/.test(s)) {
    const iso =
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T` +
      `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+09:00`;

    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }

  const compact = s.match(
    /(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );

  if (compact) {
    const iso =
      `${compact[1]}-${compact[2]}-${compact[3]}T` +
      `${compact[4]}:${compact[5]}:${compact[6]}+09:00`;

    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }

  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    if (n > 1000000000000) return n;
    if (n > 1000000000) return n * 1000;
  }

  return null;
}

function findLatestTime(data) {
  const candidates = [];

  function walk(value, key = "") {
    if (value === null || value === undefined) return;

    if (typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) walk(item, key);
      } else {
        for (const [k, v] of Object.entries(value)) walk(v, k);
      }
      return;
    }

    const ms = parseTimeValue(value);

    if (ms === null) return;

    const name = String(key).toLowerCase();

    let priority = 0;

    if (name.includes("latest")) priority += 10;
    if (name.includes("time")) priority += 5;
    if (name.includes("date")) priority += 3;

    candidates.push({ ms, priority });
  }

  walk(data);

  if (!candidates.length) {
    throw new Error("latest.json内に認識可能な時刻がありません");
  }

  candidates.sort((a, b) =>
    b.priority !== a.priority ? b.priority - a.priority : b.ms - a.ms
  );

  return candidates[0].ms;
}

/* =====================================================
   観測点（ブラウザ側と同じ処理）
   ===================================================== */

function walkRecords(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) walkRecords(v, out);
    return out;
  }

  if (value && typeof value === "object") {
    if (value.location && value.point && value.point.center_point) {
      out.push(value);
    }

    for (const v of Object.values(value)) {
      if (v && typeof v === "object") walkRecords(v, out);
    }
  }

  return out;
}

function preparePoints(recs) {
  const result = [];

  for (const item of recs) {
    const loc = item.location || {};
    const point = item.point || {};

    const center = point.center_point || {};
    const offset = point.offset || {};

    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);

    const x = Number(center.x) + Number(offset.x || 0);
    const y = Number(center.y) + Number(offset.y || 0);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      continue;
    }

    if (item.is_suspended === true) continue;

    result.push({ x: Math.round(x), y: Math.round(y) });
  }

  return result;
}

/* =====================================================
   ④ 色 → スケール値
   RGB → HSV → 区分的多項式補間
   ===================================================== */

function rgbToHSV(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);

  const delta = max - min;

  let h = 0;
  const v = max;

  const s = max === 0 ? 0 : delta / max;

  if (delta !== 0) {
    if (max === r) {
      h = (g - b) / delta;

      if (g < b) {
        h += 6;
      }
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }

    h /= 6;
  }

  return { h, s, v };
}

function colorToPosition(hsv) {
  const h = hsv.h;
  const s = hsv.s;
  const v = hsv.v;

  if (!(v > 0.1 && s > 0.75)) {
    return null;
  }

  let p = 0;

  if (h > 0.1476) {
    const h2 = h * h;
    const h3 = h2 * h;
    const h4 = h3 * h;
    const h5 = h4 * h;
    const h6 = h5 * h;

    p =
      280.31 * h6 -
      916.05 * h5 +
      1142.6 * h4 -
      709.95 * h3 +
      234.65 * h2 -
      40.27 * h +
      3.2217;
  } else if (h > 0.001) {
    const h2 = h * h;
    const h3 = h2 * h;
    const h4 = h3 * h;

    p = 151.4 * h4 - 49.32 * h3 + 6.753 * h2 - 2.481 * h + 0.9033;
  } else {
    p = -0.005171 * v * v - 0.3282 * v + 1.2236;
  }

  if (p < 0) {
    p = 0;
  }

  if (!Number.isFinite(p)) {
    return null;
  }

  return p;
}

/* =====================================================
   GIFデコーダ（依存なし・1フレーム目のみ）
   ===================================================== */

function decodeGif(buf) {
  const u16 = (p) => buf[p] | (buf[p + 1] << 8);

  if (buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) {
    throw new Error("GIFではありません");
  }

  const W = u16(6);
  const H = u16(8);
  const gf = buf[10];

  let p = 13;
  let gct = null;

  if (gf & 0x80) {
    const n = 3 * (2 << (gf & 7));
    gct = buf.subarray(p, p + n);
    p += n;
  }

  let trans = -1;

  while (p < buf.length) {
    const b = buf[p++];

    if (b === 0x21) {
      const label = buf[p++];

      if (label === 0xf9 && buf[p] >= 4) {
        if (buf[p + 1] & 1) trans = buf[p + 4];
      }

      let sz;

      while (p < buf.length && (sz = buf[p++]) !== 0) p += sz;

    } else if (b === 0x2c) {
      const left = u16(p);
      const top = u16(p + 2);
      const w = u16(p + 4);
      const h = u16(p + 6);
      const f = buf[p + 8];

      p += 9;

      let pal = gct;

      if (f & 0x80) {
        const n = 3 * (2 << (f & 7));
        pal = buf.subarray(p, p + n);
        p += n;
      }

      const minCode = buf[p++];

      let total = 0;
      let q = p;
      let sz;

      while (q < buf.length && (sz = buf[q++]) !== 0) {
        total += sz;
        q += sz;
      }

      const data = new Uint8Array(total);

      let dp = 0;
      q = p;

      while (q < buf.length && (sz = buf[q++]) !== 0) {
        data.set(buf.subarray(q, q + sz), dp);
        dp += sz;
        q += sz;
      }

      const px = new Uint8Array(w * h);

      lzwDecode(minCode, data, px);

      /* 実際の行 → 展開後の行位置 */
      const rowPos = new Uint16Array(h);

      if (f & 0x40) {
        let d = 0;

        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let r = start; r < h; r += step) rowPos[r] = d++;
        }
      } else {
        for (let r = 0; r < h; r++) rowPos[r] = r;
      }

      return { W, H, left, top, w, h, pal, trans, px, rowPos };

    } else if (b === 0x3b) {
      break;
    } else {
      throw new Error("不明なGIFブロック");
    }
  }

  throw new Error("GIF画像データがありません");
}

function lzwDecode(minCode, data, out) {
  const clear = 1 << minCode;
  const eoi = clear + 1;

  let size = minCode + 1;
  let mask = (1 << size) - 1;
  let next = eoi + 1;

  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);

  for (let c = 0; c < clear; c++) suffix[c] = c;

  const n = out.length;

  let bits = 0;
  let datum = 0;
  let ip = 0;
  let op = 0;
  let old = -1;
  let first = 0;

  while (op < n) {
    while (bits < size) {
      if (ip >= data.length) return op;

      datum |= data[ip++] << bits;
      bits += 8;
    }

    let code = datum & mask;

    datum >>= size;
    bits -= size;

    if (code === clear) {
      size = minCode + 1;
      mask = (1 << size) - 1;
      next = eoi + 1;
      old = -1;
      continue;
    }

    if (code === eoi) break;

    if (old === -1) {
      out[op++] = suffix[code];
      old = code;
      first = code;
      continue;
    }

    const inCode = code;
    let sp = 0;

    if (code >= next) {
      stack[sp++] = first;
      code = old;
    }

    while (code >= clear) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }

    first = suffix[code];
    stack[sp++] = first;

    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;

      if ((next & mask) === 0 && next < 4096) {
        size++;
        mask = (1 << size) - 1;
      }
    }

    old = inCode;

    while (sp > 0 && op < n) out[op++] = stack[--sp];
  }

  return op;
}
