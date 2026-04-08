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
// افتراضي خفيف مناسب لخطط الرام المحدودة (Render مجاني). للجودة الأعلى محلياً: OLLAMA_EMBED_MODEL=nomic-embed-text
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "all-minilm";
// all-minilm نافذة ~512 توكن؛ الأحرف العربية/الكثيفة قد تستهلك توكنات أكثر من اللاتينية — الافتراضي محافظ.
// مع nomic-embed-text أو غيره من سياق أعرض: OLLAMA_EMBED_MAX_CHARS=1200 مثلاً
const OLLAMA_EMBED_MAX_CHARS = Math.max(64, Number(process.env.OLLAMA_EMBED_MAX_CHARS) || 200);
// على Render: تهدئة بين طلبات التضمين تقلل أخطاء 502 من البوابة عند الملفات الضخمة
const OLLAMA_EMBED_DELAY_MS = Math.max(0, Number(process.env.OLLAMA_EMBED_DELAY_MS) || 250);
const OLLAMA_EMBED_TIMEOUT_MS = Math.max(10_000, Number(process.env.OLLAMA_EMBED_TIMEOUT_MS) || 120_000);
const OLLAMA_EMBED_RETRIES = Math.max(1, Math.min(8, Number(process.env.OLLAMA_EMBED_RETRIES) || 5));
const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatOllamaHttpError(status, body) {
  const t = (body || "").trim();
  if (
    status === 502 ||
    /<!DOCTYPE/i.test(t) ||
    /Bad Gateway/i.test(t) ||
    /502/i.test(t.slice(0, 80))
  ) {
    return (
      `البوابة / خدمة Ollama أعادت 502 (غير متاحة مؤقتاً أو مزدحمة). مع ملفات كبيرة قلّل الحمل: ` +
      `OLLAMA_EMBED_DELAY_MS (مثلاً 400)، أو قسّم الملف، أو ارفع خطة Ollama على Render.`
    );
  }
  const short = t.length > 400 ? `${t.slice(0, 400)}…` : t;
  return `HTTP ${status}${short ? `: ${short}` : ""}`;
}

function isOllamaContextOverflowMessage(s) {
  return /context length|exceeds the context/i.test(s || "");
}

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

function embedModelBase(name) {
  return (name || "").trim().replace(/:latest$/i, "");
}
function sameEmbedModel(a, b) {
  return embedModelBase(a) === embedModelBase(b);
}

function averageEmbeddings(vectors) {
  if (!vectors.length) return null;
  if (vectors.length === 1) return vectors[0];
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  const n = vectors.length;
  for (let i = 0; i < dim; i++) sum[i] /= n;
  const na = norm(sum);
  if (!na) return sum;
  for (let i = 0; i < dim; i++) sum[i] /= na;
  return sum;
}

async function ollamaEmbedOnePiece(prompt, model) {
  let lastErr;
  for (let attempt = 1; attempt <= OLLAMA_EMBED_RETRIES; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), OLLAMA_EMBED_TIMEOUT_MS);
    try {
      const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt }),
        signal: ac.signal
      });
      clearTimeout(to);
      if (!r.ok) {
        const errText = await r.text();
        const msg = formatOllamaHttpError(r.status, errText);
        lastErr = new Error("Ollama embeddings error: " + msg);
        const contextOverflow = isOllamaContextOverflowMessage(errText);
        // تجاوز السياق لن يُصلَح بإعادة المحاولة بنفس النص
        const retryable =
          !contextOverflow && (r.status === 429 || r.status >= 500);
        if (!retryable || attempt === OLLAMA_EMBED_RETRIES) throw lastErr;
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        console.warn(
          "[ollamaEmbedOnePiece] retry %s/%s status=%s wait=%sms",
          attempt,
          OLLAMA_EMBED_RETRIES,
          r.status,
          wait
        );
        await sleep(wait);
        continue;
      }
      let data;
      try {
        data = await r.json();
      } catch (parseErr) {
        lastErr = new Error("Ollama embeddings error: استجابة غير JSON من الخادم.");
        throw lastErr;
      }
      if (!data?.embedding?.length) {
        throw new Error("Ollama embeddings error: لا يوجد متجه في الاستجابة.");
      }
      if (OLLAMA_EMBED_DELAY_MS > 0) await sleep(OLLAMA_EMBED_DELAY_MS);
      return data.embedding;
    } catch (e) {
      clearTimeout(to);
      const msg = e?.message || "";
      if (isOllamaContextOverflowMessage(msg)) throw e;
      if (e instanceof SyntaxError) {
        throw new Error("Ollama embeddings error: استجابة غير JSON من الخادم.");
      }
      if (msg.includes("استجابة غير JSON") || msg.includes("لا يوجد متجه")) {
        throw e;
      }
      if (e?.name === "AbortError") {
        lastErr = new Error(
          "Ollama embeddings error: انتهت مهلة الطلب. جرّب رفع OLLAMA_EMBED_TIMEOUT_MS أو تقليل حجم الملف."
        );
      } else {
        lastErr = e;
      }
      if (attempt === OLLAMA_EMBED_RETRIES) throw lastErr;
      const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn("[ollamaEmbedOnePiece] retry after error attempt=%s: %s", attempt, lastErr.message);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** تقسيم تدريجي عند رد Ollama بتجاوز طول السياق (توكنات أكثر من نافذة النموذج). */
async function ollamaEmbedWithContextFallback(text, model, minChars = 48) {
  const s = (text || "").trim();
  if (!s) {
    throw new Error("فشل التضمين: مقطع نصي فارغ.");
  }
  if (s.length <= minChars) {
    return ollamaEmbedOnePiece(s, model);
  }
  try {
    return await ollamaEmbedOnePiece(s, model);
  } catch (e) {
    const msg = e?.message || "";
    if (!isOllamaContextOverflowMessage(msg)) throw e;
    if (s.length <= minChars + 1) throw e;
    const mid = Math.floor(s.length / 2);
    if (mid < 1) throw e;
    const a = await ollamaEmbedWithContextFallback(s.slice(0, mid), model, minChars);
    const b = await ollamaEmbedWithContextFallback(s.slice(mid), model, minChars);
    return averageEmbeddings([a, b]);
  }
}

async function ollamaEmbedSingleText(text, model = OLLAMA_EMBED_MODEL) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    throw new Error("فشل التضمين: مقطع نصي فارغ.");
  }
  const max = OLLAMA_EMBED_MAX_CHARS;
  if (trimmed.length <= max) {
    return ollamaEmbedWithContextFallback(trimmed, model);
  }
  const pieces = [];
  for (let i = 0; i < trimmed.length; i += max) {
    pieces.push(trimmed.slice(i, i + max));
  }
  const vectors = [];
  for (const p of pieces) {
    vectors.push(await ollamaEmbedWithContextFallback(p, model));
  }
  return averageEmbeddings(vectors);
}

async function ollamaEmbed(texts, model = OLLAMA_EMBED_MODEL) {
  const out = [];
  for (const t of texts) {
    console.log("[ollamaEmbed] model=%s chars=%s", model, (t || "").length);
    out.push(await ollamaEmbedSingleText(t, model));
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
    createdAt: idx?.createdAt || null,
    indexModel: idx?.model ?? null,
    ollamaUrl: OLLAMA_URL,
    ollamaEmbedModel: OLLAMA_EMBED_MODEL,
    ollamaEmbedDelayMs: OLLAMA_EMBED_DELAY_MS,
    ollamaEmbedMaxChars: OLLAMA_EMBED_MAX_CHARS
  });
});

app.get("/api/files", (req, res) => {
  const idx = loadIndex();
  if (!idx) return res.json({ ok: true, files: [] });
  res.json({ ok: true, files: idx.files || [] });
});

app.post("/api/reset-index", (req, res) => {
  try {
    if (fs.existsSync(INDEX_PATH)) fs.unlinkSync(INDEX_PATH);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    if (
      existingIndex?.model &&
      !sameEmbedModel(existingIndex.model, OLLAMA_EMBED_MODEL)
    ) {
      return res.status(400).json({
        error:
          `الفهرس مبني بنموذج «${existingIndex.model}» والخادم مضبوط على «${OLLAMA_EMBED_MODEL}». من صفحة الإدارة اضغط «مسح الفهرس» ثم أعد البناء، أو غيّر OLLAMA_EMBED_MODEL ليطابق الفهرس.`
      });
    }
    const maxChunkId = existingIndex?.chunks?.length
      ? Math.max(...existingIndex.chunks.map(c => c.id), -1) + 1
      : 0;

    const allNewChunks = newChunks.map((c, i) => ({
      id: maxChunkId + i,
      fileId,
      text: c,
      embedding: null
    }));

    const embeddings = await ollamaEmbed(allNewChunks.map(c => c.text), OLLAMA_EMBED_MODEL);
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
