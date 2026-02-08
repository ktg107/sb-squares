import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Tesseract from "tesseract.js";

// ─── Constants ──────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);
const QUARTERS = ["q1", "q2", "q3", "q4"];
const Q_LABELS = { q1: "Q1", q2: "Halftime", q3: "Q3", q4: "Final" };
const POOL_TYPES = [
  { key: "quarters", label: "Quarters", desc: "Winner at end of each quarter" },
  { key: "half_final", label: "Half & Final", desc: "Winner at halftime and final only" },
  { key: "every_score", label: "Every Score", desc: "Winner on every score change" },
  { key: "minute", label: "Minute by Minute", desc: "Winner checked every minute" },
];
const BRAND = {
  name: "Pixel Loft Studio",
  url: "https://pixelloft.studio",
  logo: "/PixelLoftStudioLogo.png",
};
const DB = {
  name: "sb-squares",
  version: 1,
  store: "kv",
  poolsKey: "pools",
};
const OCR = {
  minConfidence: 40,
  stripRatio: 0.22,
};
const A4 = {
  ratio: 1.414,
  minWidth: 160,
  maxWidth: 520,
};

const C = {
  bg: "#0f172a", card: "#1e293b", accent: "#3b82f6", accentDark: "#2563eb",
  green: "#22c55e", gold: "#eab308", red: "#ef4444", orange: "#f97316",
  text: "#f8fafc", textDim: "#94a3b8", textMuted: "#64748b", border: "#334155",
  mine: "rgba(59,130,246,0.3)", mineBorder: "#3b82f6",
  winner: "rgba(234,179,8,0.35)", winnerBorder: "#eab308",
};

const inputStyle = {
  padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
  background: C.card, color: C.text, fontSize: 15, outline: "none",
  width: "100%", boxSizing: "border-box",
};
const btnStyle = (bg) => ({
  padding: "10px 20px", borderRadius: 10, border: "none", background: bg,
  color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer",
});
const parseMoney = (val) => {
  if (val === "" || val == null) return "";
  const n = Number(val);
  if (Number.isNaN(n)) return "";
  return Math.max(0, n);
};

function openDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = window.indexedDB.open(DB.name, DB.version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB.store)) {
        db.createObjectStore(DB.store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB.store, "readonly");
    const store = tx.objectStore(DB.store);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB get failed"));
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB.store, "readwrite");
    const store = tx.objectStore(DB.store);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("IndexedDB set failed"));
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = src;
  });
}

function calcGridRect(displayRect, naturalSize, gridBounds) {
  const scaleX = naturalSize.width / displayRect.width;
  const scaleY = naturalSize.height / displayRect.height;
  return {
    x: Math.max(0, gridBounds.x * scaleX),
    y: Math.max(0, gridBounds.y * scaleY),
    w: Math.min(naturalSize.width, gridBounds.w * scaleX),
    h: Math.min(naturalSize.height, gridBounds.h * scaleY),
  };
}

async function ocrStrip(canvas, rect) {
  const ctx = canvas.getContext("2d");
  canvas.width = Math.max(1, Math.floor(rect.w));
  canvas.height = Math.max(1, Math.floor(rect.h));
  ctx.drawImage(rect.img, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  const result = await Tesseract.recognize(canvas, "eng", {
    tessedit_char_whitelist: "0123456789",
  });
  return result?.data?.symbols || [];
}

function offsetSymbols(symbols, offsetX, offsetY) {
  return symbols.map((s) => ({
    ...s,
    bbox: {
      x0: (s.bbox?.x0 || 0) + offsetX,
      x1: (s.bbox?.x1 || 0) + offsetX,
      y0: (s.bbox?.y0 || 0) + offsetY,
      y1: (s.bbox?.y1 || 0) + offsetY,
    },
  }));
}

function pickDigitsFromSymbols(symbols, axis, gridRect) {
  const slots = Array(10).fill(null);
  const axisStart = axis === "x" ? gridRect.x : gridRect.y;
  const axisSize = axis === "x" ? gridRect.w : gridRect.h;

  symbols.forEach((s) => {
    if (!s || !s.text || s.text.length !== 1) return;
    if (!/^[0-9]$/.test(s.text)) return;
    if ((s.confidence || 0) < OCR.minConfidence) return;
    const bbox = s.bbox || {};
    const centerX = (bbox.x0 + bbox.x1) / 2;
    const centerY = (bbox.y0 + bbox.y1) / 2;
    const center = axis === "x" ? centerX : centerY;
    const slot = Math.floor(((center - axisStart) / axisSize) * 10);
    if (slot < 0 || slot > 9) return;
    const current = slots[slot];
    if (!current || (s.confidence || 0) > current.confidence) {
      slots[slot] = { digit: parseInt(s.text, 10), confidence: s.confidence || 0 };
    }
  });

  return slots.map((s) => (s ? s.digit : null));
}

async function detectAxisNumbers(photo, gridBounds, displayRect) {
  const img = await loadImage(photo);
  const natural = { width: img.naturalWidth, height: img.naturalHeight };
  const grid = calcGridRect(displayRect, natural, gridBounds);
  const strip = Math.min(grid.w, grid.h) * OCR.stripRatio;

  const topStrip = {
    img,
    x: grid.x,
    y: Math.max(0, grid.y - strip),
    w: grid.w,
    h: strip + Math.min(strip * 0.2, grid.y),
  };
  const leftStrip = {
    img,
    x: Math.max(0, grid.x - strip),
    y: grid.y,
    w: strip + Math.min(strip * 0.2, grid.x),
    h: grid.h,
  };

  const canvas = document.createElement("canvas");
  const topSymbols = offsetSymbols(await ocrStrip(canvas, topStrip), topStrip.x, topStrip.y);
  const leftSymbols = offsetSymbols(await ocrStrip(canvas, leftStrip), leftStrip.x, leftStrip.y);

  const colNumbers = pickDigitsFromSymbols(topSymbols, "x", grid);
  const rowNumbers = pickDigitsFromSymbols(leftSymbols, "y", grid);
  return { colNumbers, rowNumbers };
}

async function detectGridFromOCR(photo, displayRect) {
  const img = await loadImage(photo);
  const maxDim = 900;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const result = await Tesseract.recognize(canvas, "eng", {
    tessedit_char_whitelist: "0123456789",
  });
  const symbols = (result?.data?.symbols || []).filter((s) => {
    if (!s || !s.text || s.text.length !== 1) return false;
    if (!/^[0-9]$/.test(s.text)) return false;
    return (s.confidence || 0) >= OCR.minConfidence;
  });
  if (symbols.length < 10) throw new Error("Not enough digits detected");

  const topCandidates = symbols.filter((s) => (s.bbox?.y1 || 0) < canvas.height * 0.4);
  const leftCandidates = symbols.filter((s) => (s.bbox?.x1 || 0) < canvas.width * 0.4);
  if (topCandidates.length < 5 || leftCandidates.length < 5) {
    throw new Error("Could not locate top/left digits");
  }

  const topBoxes = topCandidates.map((s) => s.bbox).filter(Boolean);
  const leftBoxes = leftCandidates.map((s) => s.bbox).filter(Boolean);
  if (topBoxes.length === 0 || leftBoxes.length === 0) {
    throw new Error("Digits found but no bounding boxes");
  }
  const minX = Math.min(...topBoxes.map((b) => b.x0));
  const maxX = Math.max(...topBoxes.map((b) => b.x1));
  const minY = Math.min(...leftBoxes.map((b) => b.y0));
  const maxY = Math.max(...leftBoxes.map((b) => b.y1));

  let w = Math.max(50, maxX - minX);
  let h = Math.max(50, maxY - minY);
  if (h / w < A4.ratio) {
    h = w * A4.ratio;
  } else {
    w = h / A4.ratio;
  }

  const x = Math.max(0, Math.min(minX, canvas.width - w));
  const y = Math.max(0, Math.min(minY, canvas.height - h));

  const scaleX = displayRect.width / canvas.width;
  const scaleY = displayRect.height / canvas.height;
  return {
    x: x * scaleX,
    y: y * scaleY,
    w: w * scaleX,
    h: h * scaleY,
  };
}

async function rotateImageDataUrl(photo, direction = "cw") {
  const img = await loadImage(photo);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return photo;
  const clockwise = direction === "cw";
  canvas.width = img.naturalHeight;
  canvas.height = img.naturalWidth;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((clockwise ? 1 : -1) * Math.PI / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return canvas.toDataURL("image/png");
}

function BrandHeader() {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: 10, padding: "10px 12px", background: "rgba(15,23,42,0.9)",
      borderBottom: `1px solid ${C.border}`,
    }}>
      <a href={BRAND.url} target="_blank" rel="noreferrer"
        style={{ display: "inline-flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
        <img src={BRAND.logo} alt={`${BRAND.name} logo`} style={{ width: 28, height: 28 }} />
        <span style={{ color: C.text, fontWeight: 700, fontSize: 13, letterSpacing: 0.3 }}>
          {BRAND.name}
        </span>
      </a>
    </div>
  );
}

function BrandFooter() {
  return (
    <div style={{ padding: "20px 12px 28px", textAlign: "center" }}>
      <a href={BRAND.url} target="_blank" rel="noreferrer"
        style={{ color: C.textDim, fontSize: 12, textDecoration: "none" }}>
        Built by <span style={{ color: C.accent, fontWeight: 700 }}>Pixel Loft Studio AI Engine</span>
      </a>
    </div>
  );
}

// ─── ESPN API ──────────────────────────────────────────────
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

async function fetchGames(dateStr) {
  try {
    const url = dateStr ? `${ESPN_BASE}/scoreboard?dates=${dateStr}` : `${ESPN_BASE}/scoreboard`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("ESPN API error");
    const data = await r.json();
    return (data.events || []).map((ev) => {
      const comp = ev.competitions?.[0] || {};
      const teams = (comp.competitors || []).sort((a, b) => (a.homeAway === "home" ? 1 : -1));
      const away = teams[0] || {};
      const home = teams[1] || {};
      return {
        id: ev.id,
        name: ev.name || `${away.team?.abbreviation} vs ${home.team?.abbreviation}`,
        status: comp.status?.type?.description || "Unknown",
        period: comp.status?.period || 0,
        clock: comp.status?.displayClock || "",
        awayTeam: away.team?.displayName || "Away",
        awayAbbr: away.team?.abbreviation || "AWY",
        awayScore: parseInt(away.score, 10) || 0,
        homeTeam: home.team?.displayName || "Home",
        homeAbbr: home.team?.abbreviation || "HME",
        homeScore: parseInt(home.score, 10) || 0,
        linescores: {
          away: (away.linescores || []).map((l) => l.value),
          home: (home.linescores || []).map((l) => l.value),
        },
      };
    });
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────
function getWinnerCell(colNumbers, rowNumbers, score1, score2) {
  if (!colNumbers || !rowNumbers || score1 == null || score2 == null) return null;
  const colIdx = colNumbers.indexOf(score1 % 10);
  const rowIdx = rowNumbers.indexOf(score2 % 10);
  return colIdx >= 0 && rowIdx >= 0 ? { row: rowIdx, col: colIdx } : null;
}

function getQuarterScores(game) {
  if (!game) return {};
  const scores = {};
  const aq = game.linescores?.away || [];
  const hq = game.linescores?.home || [];
  let aRunning = 0, hRunning = 0;
  for (let i = 0; i < 4; i++) {
    aRunning += aq[i] || 0;
    hRunning += hq[i] || 0;
    if (aq[i] !== undefined) {
      scores[QUARTERS[i]] = [aRunning, hRunning];
    }
  }
  return scores;
}

// ═══════════════════════════════════════════════════════════
//  PHOTO UPLOAD + GRID OVERLAY
// ═══════════════════════════════════════════════════════════
function PhotoStep({ photo, onPhotoChange, onSkip }) {
  const cameraRef = useRef(null);
  const libraryRef = useRef(null);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onPhotoChange(reader.result);
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ padding: 20, textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 8 }}>📸</div>
      <h2 style={{ color: C.text, margin: "0 0 8px" }}>Upload Your Grid</h2>
      <p style={{ color: C.textDim, fontSize: 14, margin: "0 0 24px" }}>
        Take a photo of your Super Bowl squares grid, or upload one from your gallery
      </p>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleFile}
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFile}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button style={btnStyle(C.accent)} onClick={() => cameraRef.current?.click()}>
          {photo ? "Retake Photo" : "Take Photo"}
        </button>
        <button style={btnStyle(C.accentDark)} onClick={() => libraryRef.current?.click()}>
          {photo ? "Choose Different Photo" : "Choose From Library"}
        </button>
        {photo && (
          <img src={photo} alt="Grid" style={{
            width: "100%", borderRadius: 12, border: `2px solid ${C.border}`, marginTop: 8,
          }} />
        )}
        <button style={{ ...btnStyle("transparent"), color: C.textDim, border: `1px dashed ${C.border}` }}
          onClick={onSkip}>
          Skip — I'll enter squares manually
        </button>
      </div>
    </div>
  );
}

function GridAlignStep({
  photo,
  gridBounds,
  setGridBounds,
  onDetectGrid,
  gridOcrStatus,
  onDetectNumbers,
  ocrStatus,
  onRotate,
  onDone,
}) {
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const imgRef = useRef(null);

  const handlePointerDown = (e) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      origX: gridBounds.x, origY: gridBounds.y,
    };

    const move = (ev) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setGridBounds((g) => ({
        ...g,
        x: Math.max(0, dragRef.current.origX + dx),
        y: Math.max(0, dragRef.current.origY + dy),
      }));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const resize = (delta) => setGridBounds((g) => {
    const nextW = Math.max(A4.minWidth, Math.min(A4.maxWidth, g.w + delta));
    return { ...g, w: nextW, h: nextW * A4.ratio };
  });

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ color: C.text, margin: "0 0 4px" }}>Align the Grid</h3>
      <p style={{ color: C.textDim, fontSize: 13, margin: "0 0 12px" }}>
        Drag the grid overlay to match your photo. Use +/- to resize.
      </p>
      <div ref={containerRef} style={{
        position: "relative", overflow: "hidden", borderRadius: 12,
        border: `2px solid ${C.border}`, touchAction: "none",
      }}>
        <img ref={imgRef} src={photo} alt="Grid" style={{ width: "100%", display: "block" }} />
        <div
          onPointerDown={handlePointerDown}
          style={{
            position: "absolute", left: gridBounds.x, top: gridBounds.y,
            width: gridBounds.w, height: gridBounds.h,
            border: "2px solid rgba(59,130,246,0.8)", borderRadius: 4,
            background: "rgba(59,130,246,0.08)", cursor: "grab",
            display: "grid", gridTemplateColumns: "repeat(10, 1fr)",
            gridTemplateRows: "repeat(10, 1fr)",
          }}
        >
          {Array.from({ length: 100 }, (_, i) => (
            <div key={i} style={{
              border: "0.5px solid rgba(59,130,246,0.3)",
            }} />
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center", alignItems: "center" }}>
        <button style={btnStyle(C.border)} onClick={() => resize(-20)}>−</button>
        <span style={{ color: C.textDim, fontSize: 13, minWidth: 60, textAlign: "center" }}>
          {Math.round(gridBounds.w)}×{Math.round(gridBounds.h)}
        </span>
        <button style={btnStyle(C.border)} onClick={() => resize(20)}>+</button>
      </div>
      <button
        style={{ ...btnStyle(C.border), width: "100%", marginTop: 10 }}
        onClick={onRotate}
      >
        Rotate Photo 90°
      </button>
      <button
        style={{ ...btnStyle(C.border), width: "100%", marginTop: 10, opacity: gridOcrStatus.loading ? 0.6 : 1 }}
        onClick={() => {
          if (gridOcrStatus.loading || !imgRef.current) return;
          const rect = imgRef.current.getBoundingClientRect();
          onDetectGrid({ width: rect.width, height: rect.height });
        }}
      >
        {gridOcrStatus.loading ? "Detecting Grid..." : "Auto-detect Grid (beta)"}
      </button>
      {gridOcrStatus.error && (
        <div style={{ color: C.orange, fontSize: 12, marginTop: 6 }}>
          {gridOcrStatus.error}
        </div>
      )}
      {gridOcrStatus.lastSuccess && (
        <div style={{ color: C.green, fontSize: 12, marginTop: 6 }}>
          Grid detected. Review alignment before continuing.
        </div>
      )}
      <button
        style={{ ...btnStyle(C.accentDark), width: "100%", marginTop: 10, opacity: ocrStatus.loading ? 0.6 : 1 }}
        onClick={() => {
          if (ocrStatus.loading || !imgRef.current) return;
          const rect = imgRef.current.getBoundingClientRect();
          onDetectNumbers({ width: rect.width, height: rect.height });
        }}
      >
        {ocrStatus.loading ? "Detecting Numbers..." : "Auto-detect Axis Numbers"}
      </button>
      {ocrStatus.error && (
        <div style={{ color: C.orange, fontSize: 12, marginTop: 6 }}>
          {ocrStatus.error}
        </div>
      )}
      {ocrStatus.lastSuccess && (
        <div style={{ color: C.green, fontSize: 12, marginTop: 6 }}>
          Axis numbers detected. Review on the next step.
        </div>
      )}
      <button style={{ ...btnStyle(C.accent), width: "100%", marginTop: 12 }} onClick={onDone}>
        Grid Aligned — Select My Squares
      </button>
    </div>
  );
}

function SquareSelectStep({ photo, gridBounds, mySquares, setMySquares, onDone }) {
  const toggle = (r, c) => {
    setMySquares((prev) => {
      const next = prev.map((row) => [...row]);
      next[r][c] = !next[r][c];
      return next;
    });
  };

  const count = mySquares.flat().filter(Boolean).length;
  const cellSize = gridBounds.w / 10;

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ color: C.text, margin: "0 0 4px" }}>Select Your Squares</h3>
      <p style={{ color: C.textDim, fontSize: 13, margin: "0 0 12px" }}>
        Tap the squares that belong to you. Selected: <strong style={{ color: C.accent }}>{count}</strong>
      </p>
      <div style={{ position: "relative", overflow: "hidden", borderRadius: 12, border: `2px solid ${C.border}` }}>
        {photo && <img src={photo} alt="Grid" style={{ width: "100%", display: "block" }} />}
        <div style={{
          position: photo ? "absolute" : "relative",
          left: photo ? gridBounds.x : 0,
          top: photo ? gridBounds.y : 0,
          width: photo ? gridBounds.w : "100%",
          aspectRatio: photo ? undefined : `${1}/${A4.ratio}`,
          height: photo ? gridBounds.h : undefined,
          display: "grid",
          gridTemplateColumns: "repeat(10, 1fr)",
          gridTemplateRows: "repeat(10, 1fr)",
        }}>
          {Array.from({ length: 10 }, (_, r) =>
            Array.from({ length: 10 }, (_, c) => (
              <div
                key={`${r}-${c}`}
                onClick={() => toggle(r, c)}
                style={{
                  border: mySquares[r][c]
                    ? "2px solid rgba(59,130,246,0.9)"
                    : "0.5px solid rgba(148,163,184,0.3)",
                  background: mySquares[r][c]
                    ? "rgba(59,130,246,0.4)"
                    : "rgba(0,0,0,0.1)",
                  cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: 1, transition: "all 0.1s",
                }}
              >
                {mySquares[r][c] && (
                  <span style={{ color: "#fff", fontSize: Math.max(8, cellSize * 0.35), fontWeight: 800 }}>✓</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
      <button style={{ ...btnStyle(C.accent), width: "100%", marginTop: 12 }}
        onClick={onDone} disabled={count === 0}>
        Continue with {count} square{count !== 1 ? "s" : ""}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  POOL CONFIG STEP
// ═══════════════════════════════════════════════════════════
function ConfigStep({ config, setConfig, games, onFetchGames, onDone }) {
  const [dateInput, setDateInput] = useState("");

  return (
    <div style={{ padding: 20 }}>
      <h3 style={{ color: C.text, margin: "0 0 16px" }}>Pool Details</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>Pool Name</label>
          <input style={{ ...inputStyle, marginTop: 4 }} placeholder="e.g. Office Pool"
            value={config.name} onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))} />
        </div>

        <div>
          <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>Pool Type</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 6 }}>
            {POOL_TYPES.map((t) => (
              <button key={t.key} onClick={() => setConfig((c) => ({ ...c, type: t.key }))}
                style={{
                  padding: "10px 12px", borderRadius: 10, border: config.type === t.key
                    ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
                  background: config.type === t.key ? "rgba(59,130,246,0.15)" : C.card,
                  cursor: "pointer", textAlign: "left",
                }}>
                <div style={{ color: config.type === t.key ? C.accent : C.text, fontWeight: 600, fontSize: 13 }}>
                  {t.label}
                </div>
                <div style={{ color: C.textMuted, fontSize: 11, marginTop: 2 }}>{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>Buy-in Amount ($)</label>
          <input type="number" min="0" style={{ ...inputStyle, marginTop: 4 }} placeholder="25"
            value={config.buyIn === 0 ? 0 : (config.buyIn || "")}
            onChange={(e) => {
              const next = parseMoney(e.target.value);
              setConfig((c) => ({ ...c, buyIn: next }));
            }} />
        </div>

        <div>
          <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
            Link to NFL Game (for live scores)
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="date" style={{ ...inputStyle, flex: 1 }} value={dateInput}
              onChange={(e) => setDateInput(e.target.value)} />
            <button style={btnStyle(C.accent)}
              onClick={() => {
                const d = dateInput.replace(/-/g, "");
                onFetchGames(d);
              }}>
              Find
            </button>
          </div>
          {games === null && (
            <p style={{ color: C.orange, fontSize: 12, marginTop: 6 }}>
              Could not reach ESPN. You can still enter scores manually.
            </p>
          )}
          {games && games.length === 0 && (
            <p style={{ color: C.textMuted, fontSize: 12, marginTop: 6 }}>No games found for that date.</p>
          )}
          {games && games.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {games.map((g) => (
                <button key={g.id}
                  onClick={() => setConfig((c) => ({
                    ...c, gameId: g.id,
                    awayAbbr: g.awayAbbr, homeAbbr: g.homeAbbr,
                    awayFull: g.awayTeam, homeFull: g.homeTeam,
                    team1: g.awayAbbr, team2: g.homeAbbr,
                    team1Full: g.awayTeam, team2Full: g.homeTeam,
                    columnsTeam: "away",
                  }))}
                  style={{
                    padding: "10px 12px", borderRadius: 10, textAlign: "left", cursor: "pointer",
                    border: config.gameId === g.id ? `2px solid ${C.green}` : `1px solid ${C.border}`,
                    background: config.gameId === g.id ? "rgba(34,197,94,0.1)" : C.card,
                  }}>
                  <div style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>
                    {g.awayAbbr} @ {g.homeAbbr}
                  </div>
                  <div style={{ color: C.textDim, fontSize: 12 }}>
                    {g.status} {g.status === "In Progress" ? `· Q${g.period} ${g.clock}` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {config.gameId && config.awayAbbr && config.homeAbbr && (
          <div style={{ marginTop: 6 }}>
            <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600, display: "block", marginBottom: 6 }}>
              Choose columns vs rows
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={{
                  flex: 1, padding: "8px 10px", borderRadius: 10,
                  border: config.columnsTeam === "away" ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
                  background: config.columnsTeam === "away" ? "rgba(59,130,246,0.15)" : C.card,
                  cursor: "pointer", color: C.text, fontWeight: 600, fontSize: 12,
                }}
                onClick={() => setConfig((c) => ({
                  ...c,
                  columnsTeam: "away",
                  team1: c.awayAbbr, team2: c.homeAbbr,
                  team1Full: c.awayFull || c.awayAbbr,
                  team2Full: c.homeFull || c.homeAbbr,
                }))}
              >
                Columns: {config.awayAbbr} · Rows: {config.homeAbbr}
              </button>
              <button
                style={{
                  flex: 1, padding: "8px 10px", borderRadius: 10,
                  border: config.columnsTeam === "home" ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
                  background: config.columnsTeam === "home" ? "rgba(59,130,246,0.15)" : C.card,
                  cursor: "pointer", color: C.text, fontWeight: 600, fontSize: 12,
                }}
                onClick={() => setConfig((c) => ({
                  ...c,
                  columnsTeam: "home",
                  team1: c.homeAbbr, team2: c.awayAbbr,
                  team1Full: c.homeFull || c.homeAbbr,
                  team2Full: c.awayFull || c.awayAbbr,
                }))}
              >
                Columns: {config.homeAbbr} · Rows: {config.awayAbbr}
              </button>
            </div>
          </div>
        )}

        {!config.gameId && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>Team 1 (cols)</label>
              <input style={{ ...inputStyle, marginTop: 4 }} placeholder="e.g. KC"
                value={config.team1} onChange={(e) => setConfig((c) => ({ ...c, team1: e.target.value }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>Team 2 (rows)</label>
              <input style={{ ...inputStyle, marginTop: 4 }} placeholder="e.g. PHI"
                value={config.team2} onChange={(e) => setConfig((c) => ({ ...c, team2: e.target.value }))} />
            </div>
          </div>
        )}

        <div>
          <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>
            Column Numbers ({config.team1 || "Team 1"}) — enter digits left to right
          </label>
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            {config.colNumbers.map((n, i) => (
              <input key={i} type="number" min="0" max="9"
                style={{ ...inputStyle, width: 34, padding: "8px 4px", textAlign: "center", fontSize: 16, fontWeight: 700 }}
                value={n === null ? "" : n}
                onChange={(e) => {
                  const v = e.target.value === "" ? null : Math.min(9, Math.max(0, parseInt(e.target.value, 10)));
                  setConfig((c) => {
                    const nums = [...c.colNumbers];
                    nums[i] = isNaN(v) ? null : v;
                    return { ...c, colNumbers: nums };
                  });
                }}
              />
            ))}
          </div>
        </div>

        <div>
          <label style={{ color: C.textDim, fontSize: 12, fontWeight: 600 }}>
            Row Numbers ({config.team2 || "Team 2"}) — enter digits top to bottom
          </label>
          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            {config.rowNumbers.map((n, i) => (
              <input key={i} type="number" min="0" max="9"
                style={{ ...inputStyle, width: 34, padding: "8px 4px", textAlign: "center", fontSize: 16, fontWeight: 700 }}
                value={n === null ? "" : n}
                onChange={(e) => {
                  const v = e.target.value === "" ? null : Math.min(9, Math.max(0, parseInt(e.target.value, 10)));
                  setConfig((c) => {
                    const nums = [...c.rowNumbers];
                    nums[i] = isNaN(v) ? null : v;
                    return { ...c, rowNumbers: nums };
                  });
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <button style={{
        ...btnStyle(C.green), width: "100%", marginTop: 20,
        opacity: config.name.trim() && config.team1.trim() && config.team2.trim() ? 1 : 0.4,
      }}
        disabled={!config.name.trim() || !config.team1.trim() || !config.team2.trim()}
        onClick={onDone}>
        Create Pool
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  NEW POOL WIZARD
// ═══════════════════════════════════════════════════════════
function NewPoolWizard({ onCancel, onSave }) {
  const [step, setStep] = useState(1);
  const [photo, setPhoto] = useState(null);
  const [gridBounds, setGridBounds] = useState({ x: 20, y: 20, w: 250, h: 250 * A4.ratio });
  const [mySquares, setMySquares] = useState(() => Array.from({ length: 10 }, () => Array(10).fill(false)));
  const [config, setConfig] = useState({
    name: "", type: "quarters", buyIn: "",
    team1: "", team2: "", team1Full: "", team2Full: "",
    awayAbbr: "", homeAbbr: "", awayFull: "", homeFull: "",
    columnsTeam: "away",
    gameId: null,
    colNumbers: Array(10).fill(null),
    rowNumbers: Array(10).fill(null),
  });
  const [games, setGames] = useState(undefined);
  const [ocrStatus, setOcrStatus] = useState({ loading: false, error: "", lastSuccess: false });
  const [gridOcrStatus, setGridOcrStatus] = useState({ loading: false, error: "", lastSuccess: false });

  const handleFetchGames = async (dateStr) => {
    const result = await fetchGames(dateStr);
    setGames(result);
  };

  const handleSave = () => {
    onSave({
      id: uid(),
      name: config.name.trim(),
      type: config.type,
      buyIn: parseFloat(config.buyIn) || 0,
      team1: config.team1.trim() || "Team 1",
      team2: config.team2.trim() || "Team 2",
      team1Full: config.team1Full || config.team1.trim(),
      team2Full: config.team2Full || config.team2.trim(),
      gameId: config.gameId,
      colNumbers: config.colNumbers.some((n) => n !== null) ? config.colNumbers : null,
      rowNumbers: config.rowNumbers.some((n) => n !== null) ? config.rowNumbers : null,
      mySquares,
      photo,
      gridBounds,
      scores: { q1: [null, null], q2: [null, null], q3: [null, null], q4: [null, null] },
      scoreHistory: [],
      lastKnownScore: null,
    });
  };

  const stepLabels = ["Photo", "Align", "Select", "Config"];
  const totalSteps = photo ? 4 : 3;
  const handleRotatePhoto = async () => {
    if (!photo) return;
    const rotated = await rotateImageDataUrl(photo, "cw");
    setPhoto(rotated);
    setGridBounds({ x: 20, y: 20, w: 250, h: 250 * A4.ratio });
  };

  const handleDetectNumbers = async (displayRect) => {
    if (!photo) return;
    setOcrStatus({ loading: true, error: "", lastSuccess: false });
    try {
      const { colNumbers, rowNumbers } = await detectAxisNumbers(photo, gridBounds, displayRect);
      setConfig((c) => ({
        ...c,
        colNumbers: colNumbers.some((n) => n != null) ? colNumbers : c.colNumbers,
        rowNumbers: rowNumbers.some((n) => n != null) ? rowNumbers : c.rowNumbers,
      }));
      setOcrStatus({ loading: false, error: "", lastSuccess: true });
    } catch (err) {
      setOcrStatus({
        loading: false,
        error: err?.message || "Could not detect numbers. Try a clearer photo.",
        lastSuccess: false,
      });
    }
  };
  const handleDetectGrid = async (displayRect) => {
    if (!photo) return;
    setGridOcrStatus({ loading: true, error: "", lastSuccess: false });
    try {
      const next = await detectGridFromOCR(photo, displayRect);
      setGridBounds((g) => ({ ...g, ...next }));
      setGridOcrStatus({ loading: false, error: "", lastSuccess: true });
    } catch (err) {
      setGridOcrStatus({
        loading: false,
        error: err?.message || "Could not detect the grid. Try a clearer photo.",
        lastSuccess: false,
      });
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "14px 12px",
        borderBottom: `1px solid ${C.border}`, background: C.card,
      }}>
        <button onClick={onCancel} style={{
          background: "none", border: "none", color: C.textDim, cursor: "pointer", padding: 4,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style={{ color: C.text, fontWeight: 600, flex: 1 }}>New Pool</span>
        <span style={{ color: C.textDim, fontSize: 13 }}>Step {step}/{totalSteps}</span>
      </div>

      {/* Progress */}
      <div style={{ display: "flex", gap: 4, padding: "8px 16px" }}>
        {Array.from({ length: totalSteps }, (_, i) => (
          <div key={i} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: i < step ? C.accent : C.border,
          }} />
        ))}
      </div>

      {/* Steps */}
      {step === 1 && (
        <PhotoStep photo={photo} onPhotoChange={(p) => { setPhoto(p); setStep(2); }}
          onSkip={() => { setPhoto(null); setStep(2); }} />
      )}
      {step === 2 && photo && (
        <GridAlignStep photo={photo} gridBounds={gridBounds}
          setGridBounds={setGridBounds}
          onDetectGrid={handleDetectGrid}
          gridOcrStatus={gridOcrStatus}
          onDetectNumbers={handleDetectNumbers}
          ocrStatus={ocrStatus}
          onRotate={handleRotatePhoto}
          onDone={() => setStep(3)} />
      )}
      {step === (photo ? 3 : 2) && (
        <SquareSelectStep photo={photo} gridBounds={gridBounds}
          mySquares={mySquares} setMySquares={setMySquares}
          onDone={() => setStep(photo ? 4 : 3)} />
      )}
      {step === (photo ? 4 : 3) && (
        <ConfigStep config={config} setConfig={setConfig}
          games={games} onFetchGames={handleFetchGames} onDone={handleSave} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  LIVE SCOREBOARD
// ═══════════════════════════════════════════════════════════
function LiveScoreboard({ pool, game, onManualScore }) {
  if (!game && !pool.scores) return null;
  const manualRefs = useRef([]);
  const focusNext = (idx) => {
    const next = manualRefs.current[idx + 1];
    if (next) next.focus();
  };

  const displayScores = useMemo(() => {
    if (game) {
      const qs = getQuarterScores(game);
      return {
        current: [game.awayScore, game.homeScore],
        q1: qs.q1 || [null, null],
        q2: qs.q2 || [null, null],
        q3: qs.q3 || [null, null],
        q4: qs.q4 || [null, null],
        status: game.status,
        period: game.period,
        clock: game.clock,
      };
    }
    return {
      current: pool.scores.q4[0] != null ? pool.scores.q4 : pool.scores.q3[0] != null ? pool.scores.q3 :
        pool.scores.q2[0] != null ? pool.scores.q2 : pool.scores.q1,
      ...pool.scores,
      status: "Manual",
      period: 0,
      clock: "",
    };
  }, [game, pool.scores]);

  const statusColor = game?.status === "In Progress" ? C.green :
    game?.status === "Final" ? C.textDim : C.orange;

  return (
    <div style={{ padding: "12px 16px" }}>
      {/* Live Score Card */}
      <div style={{
        background: "linear-gradient(135deg, #1e3a5f, #1e293b)",
        borderRadius: 16, padding: 16, border: `1px solid ${C.border}`,
      }}>
        {game && (
          <div style={{ textAlign: "center", marginBottom: 10 }}>
            <span style={{
              background: game.status === "In Progress" ? "rgba(34,197,94,0.2)" : "rgba(100,116,139,0.2)",
              color: statusColor, fontSize: 12, fontWeight: 600,
              padding: "3px 12px", borderRadius: 8,
            }}>
              {game.status === "In Progress" ? `LIVE · Q${game.period} ${game.clock}` : game.status}
            </span>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>{pool.team1}</div>
            <div style={{ color: C.text, fontWeight: 800, fontSize: 36 }}>
              {displayScores.current?.[0] ?? "–"}
            </div>
          </div>
          <div style={{ color: C.textMuted, fontSize: 20, fontWeight: 300 }}>vs</div>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>{pool.team2}</div>
            <div style={{ color: C.text, fontWeight: 800, fontSize: 36 }}>
              {displayScores.current?.[1] ?? "–"}
            </div>
          </div>
        </div>

        {/* Quarter breakdown */}
        <div style={{
          display: "flex", justifyContent: "center", gap: 16, marginTop: 14,
          padding: "10px 0 0", borderTop: `1px solid ${C.border}`,
        }}>
          {QUARTERS.map((q) => {
            const s = displayScores[q];
            return (
              <div key={q} style={{ textAlign: "center" }}>
                <div style={{ color: C.textMuted, fontSize: 11, fontWeight: 600 }}>{Q_LABELS[q]}</div>
                <div style={{ color: C.text, fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                  {s?.[0] != null ? `${s[0]}-${s[1]}` : "–"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Manual score entry toggle */}
      {!game && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 8 }}>
            No live game linked. Enter scores manually:
          </p>
          {QUARTERS.map((q, qi) => (
            <div key={q} style={{
              display: "flex", gap: 8, alignItems: "center", marginBottom: 8,
            }}>
              <span style={{ color: C.textDim, fontSize: 13, fontWeight: 600, width: 55 }}>{Q_LABELS[q]}</span>
              <input
                ref={(el) => { manualRefs.current[qi * 2] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                style={{ ...inputStyle, width: 60, textAlign: "center", padding: "6px 4px" }}
                placeholder="–"
                value={pool.scores[q][0] ?? ""}
                onChange={(e) => {
                  const cleaned = (e.target.value || "").replace(/\D/g, "").slice(0, 2);
                  onManualScore(q, 0, cleaned);
                  if (cleaned.length >= 2) focusNext(qi * 2);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") focusNext(qi * 2);
                }}
              />
              <span style={{ color: C.textMuted }}>–</span>
              <input
                ref={(el) => { manualRefs.current[qi * 2 + 1] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                style={{ ...inputStyle, width: 60, textAlign: "center", padding: "6px 4px" }}
                placeholder="–"
                value={pool.scores[q][1] ?? ""}
                onChange={(e) => {
                  const cleaned = (e.target.value || "").replace(/\D/g, "").slice(0, 2);
                  onManualScore(q, 1, cleaned);
                  if (cleaned.length >= 2) focusNext(qi * 2 + 1);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") focusNext(qi * 2 + 1);
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  WIN DETECTION + DISPLAY
// ═══════════════════════════════════════════════════════════
function WinDisplay({ pool, game }) {
  const wins = useMemo(() => {
    const results = [];
    if (!pool.colNumbers || !pool.rowNumbers) return results;

    const scores = game ? (() => {
      const qs = getQuarterScores(game);
      return {
        q1: qs.q1, q2: qs.q2, q3: qs.q3, q4: qs.q4,
        current: [game.awayScore, game.homeScore],
      };
    })() : {
      q1: pool.scores.q1, q2: pool.scores.q2,
      q3: pool.scores.q3, q4: pool.scores.q4,
    };

    const checkQuarters = pool.type === "quarters" ? QUARTERS :
      pool.type === "half_final" ? ["q2", "q4"] : QUARTERS;

    checkQuarters.forEach((q) => {
      const s = scores[q];
      if (!s || s[0] == null || s[1] == null) return;
      const cell = getWinnerCell(pool.colNumbers, pool.rowNumbers, s[0], s[1]);
      if (!cell) return;
      const isMine = pool.mySquares[cell.row][cell.col];
      results.push({
        quarter: Q_LABELS[q],
        score: `${s[0]}-${s[1]}`,
        digits: `${s[0] % 10}, ${s[1] % 10}`,
        cell,
        isMine,
      });
    });

    // For "every_score" type, also check current live score
    if (pool.type === "every_score" && game) {
      const s = [game.awayScore, game.homeScore];
      const cell = getWinnerCell(pool.colNumbers, pool.rowNumbers, s[0], s[1]);
      const alreadyListed = results.some((r) => r.score === `${s[0]}-${s[1]}`);
      if (cell && !alreadyListed) {
        results.push({
          quarter: "Current",
          score: `${s[0]}-${s[1]}`,
          digits: `${s[0] % 10}, ${s[1] % 10}`,
          cell,
          isMine: pool.mySquares[cell.row][cell.col],
        });
      }
    }

    return results;
  }, [pool, game]);

  const myWinCount = wins.filter((w) => w.isMine).length;

  if (wins.length === 0 && pool.colNumbers) {
    return (
      <div style={{ padding: "12px 16px" }}>
        <div style={{
          background: C.card, borderRadius: 12, padding: 16,
          textAlign: "center", border: `1px solid ${C.border}`,
        }}>
          <div style={{ fontSize: 24, marginBottom: 4 }}>⏳</div>
          <div style={{ color: C.textDim, fontSize: 14 }}>
            No scores entered yet. Winners will appear here once the game starts.
          </div>
        </div>
      </div>
    );
  }

  if (!pool.colNumbers) {
    return (
      <div style={{ padding: "12px 16px" }}>
        <div style={{
          background: C.card, borderRadius: 12, padding: 16,
          textAlign: "center", border: `1px solid ${C.border}`,
        }}>
          <div style={{ color: C.textDim, fontSize: 14 }}>
            Enter axis numbers in settings to track winners.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 16px" }}>
      {myWinCount > 0 && (
        <div style={{
          background: "linear-gradient(135deg, rgba(234,179,8,0.2), rgba(234,179,8,0.05))",
          borderRadius: 14, padding: 16, marginBottom: 12,
          border: `2px solid ${C.gold}`, textAlign: "center",
        }}>
          <div style={{ fontSize: 32 }}>🏆</div>
          <div style={{ color: C.gold, fontWeight: 800, fontSize: 20, marginTop: 4 }}>
            YOU WON {myWinCount} TIME{myWinCount > 1 ? "S" : ""}!
          </div>
          {pool.buyIn > 0 && (
            <div style={{ color: C.textDim, fontSize: 14, marginTop: 4 }}>
              Pool value: ${pool.buyIn * 100} total
            </div>
          )}
        </div>
      )}

      {wins.map((w, i) => (
        <div key={i} style={{
          background: C.card, borderRadius: 12, padding: 14, marginBottom: 8,
          border: `1px solid ${w.isMine ? C.gold : C.border}`,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: w.isMine ? "rgba(234,179,8,0.2)" : "rgba(100,116,139,0.15)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18,
          }}>
            {w.isMine ? "🏆" : "📊"}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>
              {w.quarter}: {w.score}
            </div>
            <div style={{ color: C.textDim, fontSize: 12 }}>
              Digits: {w.digits} · {w.isMine ? (
                <span style={{ color: C.gold, fontWeight: 700 }}>YOUR SQUARE!</span>
              ) : "Not your square"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  POOL DETAIL VIEW
// ═══════════════════════════════════════════════════════════
function PoolDetail({ pool, onBack, onUpdate, game }) {
  const [tab, setTab] = useState("wins");

  const handleManualScore = (q, idx, val) => {
    const parsed = val === "" ? null : parseInt(val, 10);
    if (val !== "" && isNaN(parsed)) return;
    const next = { ...pool, scores: { ...pool.scores } };
    next.scores[q] = [...next.scores[q]];
    next.scores[q][idx] = parsed;
    onUpdate(next);
  };

  const toggleSquare = (r, c) => {
    const next = { ...pool, mySquares: pool.mySquares.map((row) => [...row]) };
    next.mySquares[r][c] = !next.mySquares[r][c];
    onUpdate(next);
  };

  const mineCount = pool.mySquares.flat().filter(Boolean).length;
  const typeLabel = POOL_TYPES.find((t) => t.key === pool.type)?.label || pool.type;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 80 }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "14px 12px",
        borderBottom: `1px solid ${C.border}`, background: C.card,
        position: "sticky", top: 0, zIndex: 10,
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", color: C.textDim, cursor: "pointer", padding: 4,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ color: C.text, fontWeight: 600, fontSize: 16 }}>{pool.name}</div>
          <div style={{ color: C.textDim, fontSize: 12 }}>
            {pool.team1} vs {pool.team2} · {typeLabel}
            {pool.buyIn > 0 && ` · $${pool.buyIn}`}
          </div>
        </div>
        <span style={{
          background: C.mine, color: C.accent, borderRadius: 8,
          padding: "4px 10px", fontSize: 12, fontWeight: 600,
        }}>
          {mineCount} squares
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}` }}>
        {[
          { key: "wins", label: "Wins" },
          { key: "scores", label: "Scores" },
          { key: "grid", label: "Grid" },
        ].map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flex: 1, padding: "12px 0", background: "none",
            border: "none", borderBottom: tab === t.key ? `2px solid ${C.accent}` : "2px solid transparent",
            color: tab === t.key ? C.accent : C.textDim,
            fontWeight: 600, fontSize: 14, cursor: "pointer",
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "wins" && <WinDisplay pool={pool} game={game} />}
      {tab === "scores" && (
        <LiveScoreboard pool={pool} game={game} onManualScore={handleManualScore} />
      )}
      {tab === "grid" && (
        <div style={{ padding: 12 }}>
          {pool.photo && (
            (() => {
              const gridW = pool.gridBounds?.w ?? pool.gridBounds?.size ?? 250;
              const gridH = pool.gridBounds?.h ?? (pool.gridBounds?.size ?? 250) * A4.ratio;
              return (
            <div style={{
              position: "relative", overflow: "hidden", borderRadius: 12,
              border: `2px solid ${C.border}`, marginBottom: 12,
            }}>
              <img src={pool.photo} alt="Grid" style={{ width: "100%", display: "block" }} />
              <div style={{
                position: "absolute",
                left: pool.gridBounds.x, top: pool.gridBounds.y,
                width: gridW, height: gridH,
                display: "grid", gridTemplateColumns: "repeat(10, 1fr)",
                gridTemplateRows: "repeat(10, 1fr)",
              }}>
                {Array.from({ length: 10 }, (_, r) =>
                  Array.from({ length: 10 }, (_, c) => (
                    <div key={`${r}-${c}`} onClick={() => toggleSquare(r, c)} style={{
                      border: pool.mySquares[r][c]
                        ? "2px solid rgba(59,130,246,0.9)"
                        : "0.5px solid rgba(148,163,184,0.2)",
                      background: pool.mySquares[r][c]
                        ? "rgba(59,130,246,0.4)" : "transparent",
                      cursor: "pointer",
                    }} />
                  ))
                )}
              </div>
            </div>
              );
            })()
          )}

          {/* Clean grid view */}
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 360 }}>
              <div style={{ textAlign: "center", color: C.accent, fontWeight: 700, fontSize: 13, marginLeft: 32 }}>
                {pool.team1}
              </div>
              <div style={{ display: "flex", marginLeft: 32 }}>
                {Array.from({ length: 10 }, (_, i) => (
                  <div key={i} style={{
                    flex: 1, textAlign: "center", fontWeight: 700, fontSize: 12, padding: "2px 0 4px",
                    color: pool.colNumbers?.[i] != null ? C.green : C.textMuted, minWidth: 32,
                  }}>
                    {pool.colNumbers?.[i] ?? "?"}
                  </div>
                ))}
              </div>
              {Array.from({ length: 10 }, (_, r) => (
                <div key={r} style={{ display: "flex" }}>
                  <div style={{
                    width: 32, display: "flex", alignItems: "center", justifyContent: "center",
                    color: pool.rowNumbers?.[r] != null ? C.green : C.textMuted,
                    fontWeight: 700, fontSize: 12,
                  }}>
                    {pool.rowNumbers?.[r] ?? "?"}
                  </div>
                  {Array.from({ length: 10 }, (_, c) => {
                    const isMine = pool.mySquares[r][c];
                    return (
                      <div key={c} onClick={() => toggleSquare(r, c)} style={{
                        flex: 1, minWidth: 32, height: 32,
                        border: `1px solid ${isMine ? C.mineBorder : C.border}`,
                        background: isMine ? C.mine : C.bg,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        cursor: "pointer", borderRadius: 2,
                      }}>
                        {isMine && <span style={{ color: C.accent, fontSize: 9, fontWeight: 800 }}>ME</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
              <div style={{
                color: C.accent, fontWeight: 700, fontSize: 13,
                writingMode: "vertical-rl", textOrientation: "mixed",
                position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)",
              }}>
              </div>
            </div>
          </div>
          <p style={{ color: C.textMuted, fontSize: 12, textAlign: "center", marginTop: 8 }}>
            Tap squares to mark/unmark as yours
          </p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  HOME SCREEN
// ═══════════════════════════════════════════════════════════
function HomeScreen({ pools, onSelect, onNewPool, onDelete }) {
  const totalSquares = pools.reduce((s, p) => s + p.mySquares.flat().filter(Boolean).length, 0);
  const totalInvested = pools.reduce((s, p) => s + (Number(p.buyIn) || 0), 0);

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <div style={{ textAlign: "center", padding: "20px 0 8px" }}>
        <div style={{ fontSize: 44, marginBottom: 4 }}>🏈</div>
        <h1 style={{ color: C.text, fontSize: 24, margin: "0 0 4px", fontWeight: 700 }}>
          SB Squares Tracker
        </h1>
        <p style={{ color: C.textDim, fontSize: 14, margin: 0 }}>
          {pools.length === 0 ? "Add your first pool to get started" :
            `${pools.length} pool${pools.length !== 1 ? "s" : ""} · ${totalSquares} squares · $${totalInvested} invested`}
        </p>
      </div>

      {pools.length > 0 && (
        <div style={{
          background: "linear-gradient(135deg, #1e3a5f, #312e81)",
          borderRadius: 16, padding: 18, marginTop: 16,
        }}>
          <div style={{ display: "flex", justifyContent: "space-around" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>Pools</div>
              <div style={{ color: "#fff", fontSize: 24, fontWeight: 700 }}>{pools.length}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>Squares</div>
              <div style={{ color: "#fff", fontSize: 24, fontWeight: 700 }}>{totalSquares}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: 600, textTransform: "uppercase" }}>Invested</div>
              <div style={{ color: "#fff", fontSize: 24, fontWeight: 700 }}>${totalInvested}</div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        {pools.map((pool) => {
          const mineCount = pool.mySquares.flat().filter(Boolean).length;
          const typeLabel = POOL_TYPES.find((t) => t.key === pool.type)?.label || "";
          return (
            <div key={pool.id} onClick={() => onSelect(pool.id)} style={{
              background: C.card, borderRadius: 14, padding: 16,
              cursor: "pointer", border: `1px solid ${C.border}`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ color: C.text, fontSize: 17, fontWeight: 600 }}>{pool.name}</div>
                  <div style={{ color: C.textDim, fontSize: 13, marginTop: 2 }}>
                    {pool.team1} vs {pool.team2}
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); onDelete(pool.id); }}
                  style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", padding: 4 }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <span style={{
                  background: C.mine, color: C.accent, borderRadius: 8,
                  padding: "3px 10px", fontSize: 12, fontWeight: 600,
                }}>{mineCount} squares</span>
                <span style={{
                  background: "rgba(100,116,139,0.15)", color: C.textDim, borderRadius: 8,
                  padding: "3px 10px", fontSize: 12, fontWeight: 500,
                }}>{typeLabel}</span>
                {pool.buyIn > 0 && (
                  <span style={{
                    background: "rgba(34,197,94,0.15)", color: C.green, borderRadius: 8,
                    padding: "3px 10px", fontSize: 12, fontWeight: 500,
                  }}>${pool.buyIn}</span>
                )}
                {pool.gameId && (
                  <span style={{
                    background: "rgba(249,115,22,0.15)", color: C.orange, borderRadius: 8,
                    padding: "3px 10px", fontSize: 12, fontWeight: 500,
                  }}>Live linked</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button onClick={onNewPool} style={{
        position: "fixed", bottom: 24, right: 24,
        width: 56, height: 56, borderRadius: 28,
        background: C.accent, border: "none", color: "#fff",
        boxShadow: "0 4px 20px rgba(59,130,246,0.4)",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [pools, setPools] = useState([]);
  const [view, setView] = useState("home"); // home | wizard | detail
  const [activePoolId, setActivePoolId] = useState(null);
  const [liveGames, setLiveGames] = useState({});
  const [hydrated, setHydrated] = useState(false);

  // Load pools from IndexedDB on first mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const saved = await idbGet(DB.poolsKey);
        if (alive && Array.isArray(saved)) setPools(saved);
      } catch {
        // Non-fatal: fall back to empty in-memory state
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Persist pools to IndexedDB after hydration
  useEffect(() => {
    if (!hydrated) return;
    idbSet(DB.poolsKey, pools).catch(() => {});
  }, [pools, hydrated]);

  // Poll ESPN for live scores every 30s
  useEffect(() => {
    const gameIds = [...new Set(pools.filter((p) => p.gameId).map((p) => p.gameId))];
    if (gameIds.length === 0) return;

    const poll = async () => {
      const games = await fetchGames();
      if (!games) return;
      const map = {};
      games.forEach((g) => { map[g.id] = g; });
      setLiveGames(map);

      // Auto-update scores for pools with live games
      setPools((prev) => prev.map((pool) => {
        if (!pool.gameId || !map[pool.gameId]) return pool;
        const game = map[pool.gameId];
        const qs = getQuarterScores(game);
        const newScores = { ...pool.scores };
        QUARTERS.forEach((q) => {
          if (qs[q]) newScores[q] = qs[q];
        });
        return { ...pool, scores: newScores };
      }));
    };

    poll();
    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, [pools.map((p) => p.gameId).join(",")]);

  const addPool = useCallback((pool) => {
    setPools((prev) => [...prev, pool]);
    setView("home");
  }, []);

  const deletePool = useCallback((id) => {
    setPools((prev) => prev.filter((p) => p.id !== id));
    if (activePoolId === id) {
      setActivePoolId(null);
      setView("home");
    }
  }, [activePoolId]);

  const updatePool = useCallback((updated) => {
    setPools((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  const activePool = pools.find((p) => p.id === activePoolId);
  const activeGame = activePool?.gameId ? liveGames[activePool.gameId] : null;

  return (
    <div style={{
      background: C.bg, minHeight: "100vh",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      maxWidth: 480, margin: "0 auto",
      display: "flex", flexDirection: "column",
    }}>
      <BrandHeader />
      <div style={{ flex: 1 }}>
        {view === "home" && (
          <HomeScreen pools={pools}
            onSelect={(id) => { setActivePoolId(id); setView("detail"); }}
            onNewPool={() => setView("wizard")}
            onDelete={deletePool}
          />
        )}
        {view === "wizard" && (
          <NewPoolWizard onCancel={() => setView("home")} onSave={addPool} />
        )}
        {view === "detail" && activePool && (
          <PoolDetail pool={activePool}
            onBack={() => { setActivePoolId(null); setView("home"); }}
            onUpdate={updatePool}
            game={activeGame}
          />
        )}
      </div>
      <BrandFooter />
    </div>
  );
}
