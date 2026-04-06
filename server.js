import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fileUpload from "express-fileupload";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));

const PORT = Number(process.env.PORT) || 3000;
const IS_VERCEL = !!process.env.VERCEL;
const DATA_DIR = IS_VERCEL ? "/tmp/search-data" : path.join(process.cwd(), "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (e) {
  console.warn("Could not create data dir:", e.message);
}

app.get("/favicon.ico", (_, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, "public")));

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");

// --------- helpers ----------
function chunkText(text, chunkSize = 900, overlap = 150) {
  const clean = text.replace(/\r/g, "").trim();
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    const end = Math.min(i + chunkSize, clean.length);
    const chunk = clean.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === clean.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

async function ollamaEmbed(texts, model = OLLAMA_EMBED_MODEL) {
  const out = [];
  for (const t of texts) {
    const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: t })
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error("Ollama embeddings error: " + err);
    }
    const data = await r.json();
    out.push(data.embedding);
  }
  return out;
}

async function extractPptxText(filePath) {
  return new Promise((resolve, reject) => {
    const extPath = path.join(UPLOADS_DIR, `extracted_${Date.now()}.txt`);
    const py = spawn(PYTHON_CMD, [
      path.join(__dirname, "public", "extract_pptx_text.py"),
      filePath,
      extPath
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    py.stderr.on("data", d => { err += d.toString(); });
    py.on("close", code => {
      if (code === 0 && fs.existsSync(extPath)) {
        const text = fs.readFileSync(extPath, "utf-8");
        try { fs.unlinkSync(extPath); } catch (_) {}
        resolve(text);
      } else {
        reject(new Error(err || `Python exit code: ${code}`));
      }
    });
  });
}

function saveIndex(obj) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(obj, null, 2), "utf-8");
}

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return null;
  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf-8");
    const idx = JSON.parse(raw);
    if (idx.chunks && idx.chunks.length > 0 && idx.chunks[0].fileId === undefined) {
      idx.files = [{ id: "default", title: "مستند", chunkCount: idx.chunks.length }];
      idx.chunks.forEach((c) => { c.fileId = "default"; });
      saveIndex(idx);
    }
    return idx;
  } catch (e) {
    console.error("loadIndex:", e.message);
    return null;
  }
}

// --------- routes ----------
app.get("/api/status", (req, res) => {
  const idx = loadIndex();
  res.json({
    ok: true,
    hasIndex: !!idx,
    chunks: idx?.chunks?.length || 0,
    files: idx?.files || [],
    createdAt: idx?.createdAt || null
  });
});

app.get("/api/files", (req, res) => {
  const idx = loadIndex();
  if (!idx) return res.json({ ok: true, files: [] });
  res.json({ ok: true, files: idx.files || [] });
});

app.post("/api/index", async (req, res) => {
  try {
    const chunkSize = Number(req.body?.chunkSize) || 900;
    const overlap = Number(req.body?.overlap) || 150;
    const documentName = (req.body?.documentName || "").trim();

    if (!documentName) {
      return res.status(400).json({ error: "أدخل اسم المستند." });
    }

    const textParts = [];
    if (req.files?.files) {
      const files = Array.isArray(req.files.files) ? req.files.files : [req.files.files];
      for (const f of files) {
        const safeName = path.basename(f.name || "file");
        const ext = path.extname(safeName).toLowerCase();
        const tempPath = path.join(UPLOADS_DIR, `upload_${Date.now()}_${safeName}`);
        await f.mv(tempPath);
        let text = "";
        if (ext === ".pptx" || ext === ".ppt") {
          text = await extractPptxText(tempPath);
        } else if (ext === ".txt" || ext === ".md") {
          text = fs.readFileSync(tempPath, "utf-8");
        }
        try { fs.unlinkSync(tempPath); } catch (_) {}
        if (text.trim().length >= 20) {
          textParts.push(text.trim());
        }
      }
    }
    if (req.body?.text && typeof req.body.text === "string" && req.body.text.trim().length >= 50) {
      textParts.push(req.body.text.trim());
    }

    if (textParts.length === 0) {
      return res.status(400).json({ error: "ارفع ملفات (PPTX, TXT) أو الصق نصًا." });
    }

    const fullText = textParts.join("\n\n");
    const newChunks = chunkText(fullText, chunkSize, overlap);

    const fileId = `f${Date.now()}`;
    const existingIndex = loadIndex();
    const maxChunkId = existingIndex?.chunks?.length
      ? Math.max(...existingIndex.chunks.map(c => c.id), -1) + 1
      : 0;

    const allNewChunks = newChunks.map((c, i) => ({
      id: maxChunkId + i,
      fileId,
      text: c,
      embedding: null
    }));

    const embedModel = existingIndex?.model || OLLAMA_EMBED_MODEL;
    const embeddings = await ollamaEmbed(allNewChunks.map(c => c.text), embedModel);
    allNewChunks.forEach((c, i) => { c.embedding = embeddings[i]; });

    const newFile = { id: fileId, title: documentName, chunkCount: newChunks.length };

    const indexObj = existingIndex
      ? {
          ...existingIndex,
          updatedAt: new Date().toISOString(),
          chunkSize,
          overlap,
          files: [...(existingIndex.files || []), newFile],
          chunks: [...(existingIndex.chunks || []), ...allNewChunks]
        }
      : {
          createdAt: new Date().toISOString(),
          model: OLLAMA_EMBED_MODEL,
          chunkSize,
          overlap,
          files: [newFile],
          chunks: allNewChunks
        };

    saveIndex(indexObj);
    res.json({
      ok: true,
      chunks: allNewChunks.length,
      documentName,
      totalFiles: indexObj.files.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    const { query, topK, fileId } = req.body || {};
    const q = (query || "").trim();
    if (!q) return res.status(400).json({ error: "اكتب عبارة بحث." });

    const idx = loadIndex();
    if (!idx) return res.status(400).json({ error: "لا يوجد فهرس." });

    let chunks = idx.chunks;
    if (fileId) {
      chunks = chunks.filter(ch => ch.fileId === fileId);
    }

    const keywordMatches = chunks.filter(ch => ch.text.includes(q));

    if (keywordMatches.length === 0) {
      return res.json({
        ok: true,
        results: [],
        message: "لا توجد نتائج تحتوي على الكلمة حرفيًا."
      });
    }

    const embedModel = idx.model || OLLAMA_EMBED_MODEL;
    const [qVec] = await ollamaEmbed([q], embedModel);

    const scored = keywordMatches.map(ch => ({
      id: ch.id,
      text: ch.text,
      score: cosine(qVec, ch.embedding)
    }));

    scored.sort((a, b) => b.score - a.score);

    const k = Math.max(1, Math.min(Number(topK) || 5, 20));

    res.json({ ok: true, results: scored.slice(0, k) });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// تشغيل محلي (عدم التشغيل على Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`✅ Web: http://localhost:${PORT}`);
    console.log(`✅ Admin: http://localhost:${PORT}/admin.html`);
    console.log(`✅ Ollama: ${OLLAMA_URL} (embed: ${OLLAMA_EMBED_MODEL})`);
  });
}

export default app;
