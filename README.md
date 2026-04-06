# 🔍 بحث ذكي — Smart Search

بحث دلالي داخل المستندات باستخدام Ollama و nomic-embed-text.

## المميزات

- **رفع ملفات** PPTX, TXT, MD
- **بحث دلالي** بدلاً من البحث النصي فقط
- **واجهة حديثة** متجاوبة مع الهواتف
- **نسخ النتائج** بضغطة زر
- **بحث داخل مستند محدد** أو كل المستندات

## التشغيل المحلي

### المتطلبات

1. **Node.js** (الإصدار 18+)
2. **Ollama** — [تحميل](https://ollama.ai)
3. **Python** (للملفات PPTX فقط)

### التثبيت

```bash
# تثبيت تبعيات Node
npm install

# تثبيت نموذج التضمين
ollama pull nomic-embed-text

# تثبيت تبعيات Python (للـ PPTX)
pip install -r requirements.txt
```

### التشغيل

```bash
npm run dev
```

ثم افتح: http://localhost:3000

---

## النشر على الإنترنت (مع Ollama)

**الموصى به: [Railway](https://railway.app)** — خدمتان: التطبيق (من `Dockerfile`) + Ollama.  
الدليل خطوة بخطوة: **[DEPLOY.md](./DEPLOY.md)**

بدائل: Docker على VPS (`docker-compose.yml`) أو Render.

**Vercel** لا يشغّل Ollama على خوادمه، لذا غير مناسب لهذا المشروع كما هو.

### متغيرات البيئة (عند النشر)

| المتغير | مثال |
|---------|------|
| `OLLAMA_URL` | `http://ollama:11434` (داخل Docker) أو عنوان خادم Ollama |
| `PORT` | يضبطه المستضيف (Railway/Render) تلقائياً غالباً |

محلياً: `OLLAMA_URL` الافتراضي `http://127.0.0.1:11434`

---

## هيكل المشروع

```
├── server.js           # خادم Express والـ API
├── Dockerfile          # صورة Docker للتطبيق
├── docker-compose.yml  # تطبيق + Ollama معاً
├── DEPLOY.md           # دليل النشر (Railway أولاً)
├── railway.toml        # إعداد بناء Railway من Dockerfile
├── public/
│   ├── index.html
│   ├── admin.html
│   ├── styles.css
│   └── extract_pptx_text.py
├── data/               # الفهرس (محلياً أو volume في Docker)
├── requirements.txt
└── vercel.json         # اختياري (نشر تجريبي)
```

## الترخيص

ISC
