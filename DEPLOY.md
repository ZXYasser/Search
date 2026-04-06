# نشر المشروع على الإنترنت (مع Ollama فقط)

**Vercel لا يشغّل Ollama.** للمشروع الحالي الأنسب هو **Railway** أو Docker على VPS.

---

## الطريقة الموصى بها: Railway

### ما الذي ستبنيه؟

مشروع واحد في Railway يحتوي **خدمتين**:

| الخدمة | الوظيفة |
|--------|---------|
| **web** (أو أي اسم) | تطبيق Node.js من هذا المستودع (`Dockerfile`) |
| **ollama** | خادم Ollama من الصورة الرسمية `ollama/ollama` |

التطبيق يتصل بـ Ollama عبر الشبكة الداخلية باستخدام المتغير **`OLLAMA_URL`**.

---

### الخطوات (بالترتيب)

#### 1) تجهيز الكود على GitHub

ادفع المشروع إلى مستودع عام أو خاص على GitHub.

#### 2) إنشاء مشروع في Railway

1. ادخل إلى [railway.app](https://railway.app) وسجّل الدخول.
2. **New Project** → **Deploy from GitHub repo** → اختر المستودع.
3. Railway سيكتشف `Dockerfile` و`railway.toml` ويبني الصورة.

#### 3) إضافة خدمة Ollama

1. داخل نفس المشروع: **+ New** → **Empty Service** أو **Database** ليس مطلوباً.
2. الأفضل: **+ New** → **Template** وابحث عن **Ollama** إن وُجد، أو:
3. **+ New** → **Docker Image** → الصورة: `ollama/ollama:latest`
4. سمّ الخدمة **`ollama`** (مهم لسهولة العنوان الداخلي).

#### 4) ربط التطبيق بـ Ollama (متغيرات البيئة)

1. افتح خدمة **التطبيق** (الويب)، لا خدمة Ollama.
2. اذهب إلى **Variables** (المتغيرات).
3. أضف:

   | الاسم | القيمة |
   |--------|--------|
   | `OLLAMA_URL` | `http://ollama.railway.internal:11434` |

   إذا غيّرت **اسم خدمة** Ollama (مثلاً `Ollama-1`)، استبدل الجزء الأول:

   `http://اسم-الخدمة-كما-في-Railway.railway.internal:11434`

4. احفظ — سيعيد Railway تشغيل الخدمة.

> **ملاحظة:** إذا لم يعمل العنوان أعلاه، من إعدادات خدمة Ollama انسخ **Private Networking** أو **Internal URL** إن وُجد، مع المنفذ **11434**.

#### 5) المنفذ (PORT)

Railway يحقن `PORT` تلقائياً — الكود يقرأه. لا حاجة لضبطه يدوياً عادةً.

#### 6) تحميل نموذج التضمين (مرة لكل بيئة جديدة)

1. افتح خدمة **Ollama** في Railway.
2. **Deployments** → اختر آخر نشر → **View Logs** أو استخدم **Shell** إن توفر.
3. أو من الجهاز المحلي بعد تفعيل CLI:

   ```bash
   railway shell
   # ثم داخل بيئة ollama إن أمكن:
   ollama pull nomic-embed-text
   ```

   الطريقة الأكثر موثوقية: في Railway اذهب لخدمة Ollama → **Settings** → **Public Networking** مؤقتاً أو استخدم **Railway CLI** مع `railway run` داخل الحاوية.

   **بديل عملي:** بعد تشغيل Ollama، من لوحة Railway افتح **Terminal** للخدمة `ollama` ونفّذ:

   ```bash
   ollama pull nomic-embed-text
   ```

#### 7) الحصول على الرابط العام

1. في خدمة **التطبيق** (الويب): **Settings** → **Networking** → **Generate Domain**.
2. افتح الرابط (مثل `https://xxx.up.railway.app`).

---

### استمرارية الفهرس (`data/`)

بدون إعداد إضافي، مجلد `data` قد يُفقد عند إعادة النشر. لإبقاء الفهرس:

1. في خدمة التطبيق: **Settings** → **Volumes**.
2. أضف Volume واربطه بمسار الحاوية: **`/app/data`**.

---

### ملخص متغيرات التطبيق على Railway

| المتغير | مطلوب؟ | القيمة |
|---------|--------|--------|
| `OLLAMA_URL` | نعم | `http://ollama.railway.internal:11434` (حسب اسم خدمة Ollama) |
| `PORT` | لا | يحقنه Railway |
| `PYTHON_CMD` | لا | الافتراضي `python3` داخل Docker |

---

### استكشاف الأخطاء

| المشكلة | الحل |
|---------|------|
| خطأ اتصال بـ Ollama | تأكد أن خدمة Ollama تعمل (Running) وأن `OLLAMA_URL` صحيح. |
| انتهاء الوقت عند بناء الفهرس | في Railway زد **Timeout** للخدمة أو قلّل حجم الملف أولاً. |
| لا يعمل PPTX | الصورة تتضمن Python؛ راجع سجلات التطبيق. |

---

## Docker Compose (VPS)

مناسب إذا تفضّل سيرفرك الخاص:

```bash
docker compose up -d --build
docker compose exec ollama ollama pull nomic-embed-text
```

---

## Render (بديل)

أنشئ Web Service من `Dockerfile` + خدمة Ollama منفصلة، وعيّن `OLLAMA_URL` لعنوان Ollama الداخلي أو العام.

---

## تشغيل محلي

```bash
ollama pull nomic-embed-text
npm run dev
```

`OLLAMA_URL` الافتراضي: `http://127.0.0.1:11434`
