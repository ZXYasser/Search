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

## النشر على Vercel

⚠️ **ملاحظة مهمة**: هذا المشروع يعتمد على:
- **Ollama** (يعمل محلياً على المنفذ 11434)
- **تخزين ملفي** (data/index.json)
- **Python** لاستخراج نص PPTX

على **Vercel**:
- لا يتوفر Ollama — تحتاج لتوفير API تضمين سحابي (مثل OpenAI)
- التخزين مؤقت — تحتاج قاعدة بيانات أو Vercel Blob
- Python غير متوفر افتراضياً في الدوال

**للتشغيل الكامل**: انشر على [Railway](https://railway.app) أو [Render](https://render.com) أو خادم VPS — هذه تدعم عمليات طويلة وتخزين دائم.

**للنشر على Vercel** (واجهة فقط أو مع backend معدّل):

```bash
# تثبيت Vercel CLI
npm i -g vercel

# النشر
vercel
```

---

## هيكل المشروع

```
├── server.js          # خادم Express والـ API
├── api/index.js       # نقطة دخول Vercel
├── public/
│   ├── index.html     # صفحة البحث (العملاء)
│   ├── admin.html     # صفحة الإدارة
│   ├── styles.css     # الأنماط المشتركة
│   └── extract_pptx_text.py  # استخراج نص PPTX
├── data/
│   ├── index.json     # الفهرس
│   └── uploads/       # ملفات مؤقتة
├── requirements.txt   # تبعيات Python
└── vercel.json       # إعدادات Vercel
```

## الترخيص

ISC
