const express = require("express");
const { createCanvas, registerFont } = require("canvas");
const fs = require("fs");
const path = require("path");
// archiver is required inline in the download route
const multer = require("multer");
const { spawn } = require("child_process");

// --- Register fonts ---
const localFonts = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Fonts");
const fontDefs = [
  { file: "Alef-Bold.ttf", family: "Alef", weight: "bold" },
  { file: "Alef-Regular.ttf", family: "Alef", weight: "normal" },
  { file: "Rubik-Bold.ttf", family: "Rubik", weight: "bold" },
  { file: "Rubik-Regular.ttf", family: "Rubik", weight: "normal" },
  { file: "Heebo-Bold.ttf", family: "Heebo", weight: "bold" },
  { file: "Heebo-Regular.ttf", family: "Heebo", weight: "normal" },
];
for (const fd of fontDefs) {
  const fp = path.join(localFonts, fd.file);
  if (fs.existsSync(fp)) {
    registerFont(fp, { family: fd.family, weight: fd.weight });
  }
}
// System fallbacks always available: Arial, Tahoma, David
const AVAILABLE_FONTS = ["Alef", "Arial", "Tahoma", "Rubik", "Heebo", "David"];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OUTPUT_DIR = path.join(__dirname, "output");
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

function drawSubtitleText(ctx, text, config) {
  const fontFamily = AVAILABLE_FONTS.includes(config.fontFamily) ? config.fontFamily : "Alef";
  ctx.font = `bold ${config.fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.direction = "rtl";

  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > config.maxTextWidth && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);

  const lh = config.fontSize * 1.4;
  const startY = config.height - config.bottomMargin - lines.length * lh + lh;
  for (let i = 0; i < lines.length; i++) {
    const x = config.width / 2;
    const y = startY + i * lh;

    // Shadow
    if (config.shadow) {
      ctx.fillStyle = config.shadowColor || "rgba(0,0,0,0.7)";
      const blur = config.shadowBlur || 4;
      const off = config.shadowOffset || 2;
      ctx.shadowColor = config.shadowColor || "rgba(0,0,0,0.7)";
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = off;
      ctx.shadowOffsetY = off;
      ctx.fillText(lines[i], x, y);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }

    // Stroke
    if (config.stroke) {
      ctx.strokeStyle = config.strokeColor || "#000000";
      ctx.lineWidth = config.strokeWidth || 3;
      ctx.lineJoin = "round";
      ctx.strokeText(lines[i], x, y);
    }

    // Fill
    ctx.fillStyle = config.textColor;
    ctx.fillText(lines[i], x, y);
  }
}

function generateSubtitlePNG(text, config) {
  const canvas = createCanvas(config.width, config.height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, config.width, config.height);
  drawSubtitleText(ctx, text, config);
  return canvas.toBuffer("image/png");
}

function generatePreviewPNG(text, config) {
  const canvas = createCanvas(config.width, config.height);
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, config.width, config.height);
  grad.addColorStop(0, "#1a1a2e");
  grad.addColorStop(1, "#0f3460");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, config.width, config.height);
  drawSubtitleText(ctx, text, config);
  return canvas.toBuffer("image/png");
}

// --- Script cleanup ---
function cleanupScript(text) {
  let lines = text.split("\n");

  lines = lines.map(line => {
    let l = line.trim();
    // Remove nikud (Hebrew diacritics U+0591-U+05C7)
    l = l.replace(/[֑-ׇ]/g, "");
    // Remove stage directions: (text) [text] {text}
    l = l.replace(/\([^)]*\)/g, "");
    l = l.replace(/\[[^\]]*\]/g, "");
    l = l.replace(/\{[^}]*\}/g, "");
    // Remove character name prefixes like "שם:" or "שם -"
    l = l.replace(/^[֐-׿\w]+\s*[:]\s*/u, "");
    // Remove leading numbers / timestamps like "1." "00:01:23" "1)"
    l = l.replace(/^\d+[\.\)]\s*/, "");
    l = l.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*[-–—]?\s*/, "");
    // Remove excessive punctuation
    l = l.replace(/[!]{2,}/g, "!");
    l = l.replace(/[?]{2,}/g, "?");
    l = l.replace(/[.]{3,}/g, "...");
    l = l.replace(/[-–—]{2,}/g, " - ");
    // Clean whitespace
    l = l.replace(/\s+/g, " ").trim();
    return l;
  });

  // Remove empty lines
  lines = lines.filter(l => l.length > 0);

  // Break long lines into subtitle-friendly chunks (~42 chars)
  const MAX_CHARS = 42;
  const result = [];
  for (const line of lines) {
    if (line.length <= MAX_CHARS) {
      result.push(line);
      continue;
    }
    const words = line.split(" ");
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (test.length > MAX_CHARS && cur) {
        result.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) result.push(cur);
  }

  return result;
}

// --- Subtitle PNG APIs ---

app.post("/api/preview", (req, res) => {
  const { text, fontSize, bottomMargin, textColor, fontFamily, shadow, shadowColor, shadowBlur, shadowOffset, stroke, strokeColor, strokeWidth } = req.body;
  const config = {
    width: 1920, height: 1080,
    fontSize: fontSize || 58, bottomMargin: bottomMargin || 40,
    textColor: textColor || "#FFFFFF", maxTextWidth: 1700,
    fontFamily: fontFamily || "Alef",
    shadow: !!shadow, shadowColor: shadowColor || "rgba(0,0,0,0.7)", shadowBlur: shadowBlur || 4, shadowOffset: shadowOffset || 2,
    stroke: !!stroke, strokeColor: strokeColor || "#000000", strokeWidth: strokeWidth || 3,
  };
  res.set("Content-Type", "image/png");
  res.send(generatePreviewPNG(text || "טקסט לדוגמה", config));
});

app.post("/api/cleanup", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text" });
  const cleaned = cleanupScript(text);
  res.json({ lines: cleaned, count: cleaned.length });
});

app.get("/api/fonts", (req, res) => {
  res.json({ fonts: AVAILABLE_FONTS });
});

app.post("/api/generate", (req, res) => {
  const { lines, fontSize, bottomMargin, textColor, fontFamily, shadow, shadowColor, shadowBlur, shadowOffset, stroke, strokeColor, strokeWidth } = req.body;
  if (!lines || !lines.length) return res.status(400).json({ error: "No lines" });
  const config = {
    width: 1920, height: 1080,
    fontSize: fontSize || 58, bottomMargin: bottomMargin || 40,
    textColor: textColor || "#FFFFFF", maxTextWidth: 1700,
    fontFamily: fontFamily || "Alef",
    shadow: !!shadow, shadowColor: shadowColor || "rgba(0,0,0,0.7)", shadowBlur: shadowBlur || 4, shadowOffset: shadowOffset || 2,
    stroke: !!stroke, strokeColor: strokeColor || "#000000", strokeWidth: strokeWidth || 3,
  };
  const now = new Date();
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") + "_" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const batchDir = path.join(OUTPUT_DIR, ts);
  fs.mkdirSync(batchDir, { recursive: true });

  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const buf = generateSubtitlePNG(lines[i], config);
    const fn = `sub_${String(i + 1).padStart(3, "0")}.png`;
    fs.writeFileSync(path.join(batchDir, fn), buf);
    files.push(fn);
  }
  res.json({ files, count: files.length, batch: ts });
});

app.get("/api/download-all", (req, res) => {
  const batch = req.query.batch;
  if (!batch) return res.status(400).send("Missing batch");
  const batchDir = path.join(OUTPUT_DIR, batch);
  if (!fs.existsSync(batchDir)) return res.status(404).send("Batch not found");

  const { ZipArchive } = require("archiver");
  const archive = new ZipArchive({ zlib: { level: 9 } });
  res.set("Content-Type", "application/zip");
  res.set("Content-Disposition", `attachment; filename=subtitles_${batch}.zip`);
  archive.pipe(res);
  archive.directory(batchDir, false);
  archive.finalize();
});

app.get("/output/:batch/:filename", (req, res) => {
  const fp = path.join(OUTPUT_DIR, req.params.batch, req.params.filename);
  if (fs.existsSync(fp)) res.sendFile(fp);
  else res.status(404).send("Not found");
});

// --- Transcription API ---

app.post("/api/transcribe", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const inputPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const properPath = inputPath + ext;
  fs.renameSync(inputPath, properPath);

  const isolate = req.body.isolate === "true";
  const language = req.body.language || "he";

  const args = [
    path.join(__dirname, "transcribe.py"),
    properPath,
    "--language", language,
  ];
  if (isolate) args.push("--isolate");

  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  // Ensure ffmpeg/winget links are on PATH
  const wingetLinks = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links");
  if (env.PATH && !env.PATH.includes(wingetLinks)) env.PATH = wingetLinks + ";" + env.PATH;
  if (env.Path && !env.Path.includes(wingetLinks)) env.Path = wingetLinks + ";" + env.Path;

  const proc = spawn("py", args, { cwd: __dirname, env });

  let lastData = "";
  const updates = [];

  proc.stdout.on("data", (chunk) => {
    const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        updates.push(parsed);
        lastData = line;
      } catch {}
    }
  });

  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  proc.on("close", (code) => {
    // Cleanup uploaded file
    try { fs.unlinkSync(properPath); } catch {}

    if (code !== 0) {
      return res.status(500).json({ error: "Transcription failed", details: stderr.slice(-500) });
    }

    try {
      const result = JSON.parse(lastData);
      // Save SRT file
      const srtPath = path.join(OUTPUT_DIR, "subtitles.srt");
      fs.writeFileSync(srtPath, result.srt, "utf-8");
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: "Failed to parse output", details: stderr.slice(-500) });
    }
  });
});

app.get("/api/download-srt", (req, res) => {
  const srtPath = path.join(OUTPUT_DIR, "subtitles.srt");
  if (fs.existsSync(srtPath)) {
    res.download(srtPath, "subtitles.srt");
  } else {
    res.status(404).send("No SRT file");
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`SubMaker running at http://localhost:${PORT}`);
});
