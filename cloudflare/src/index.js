// خدمة قراءة الروشتة / علبة الدوا — Cloudflare Worker (الخطة المجانية).
// مفتاح Gemini محفوظ كـ secret في Cloudflare، ومش موجود جوه التطبيق خالص.
//
// الإعدادات (Workers → dawaya-reader → Settings → Variables and Secrets):
//   GEMINI_API_KEY  (secret)  مفتاح Gemini من https://aistudio.google.com/apikey
//   APP_TOKEN       (secret)  نفس القيمة اللي في lib/config.dart (appToken)
//   GEMINI_MODEL    (var)     الموديل الأساسي
//   GEMINI_FALLBACK_MODELS (var) موديلات احتياطي لو الأساسي عليه ضغط (مفصولة بفاصلة)
//   RATE_LIMITER    (ratelimit binding) حد أقصى للطلبات لكل IP
//   ALLOWED_ORIGINS (var)     مواقع الويب المسموح لها (مفصولة بفاصلة) أو * للكل
//
// نفس العقد اللي التطبيق متوقعه:
//   POST /api/read-prescription  header: x-app-token
//   body: { image: base64, mimeType, kind: "prescription" | "box" }
//   200 → { medicines: [...] }   غير كده → { error: "رسالة بالعربي" }
//
//   POST /api/faq-match (لبوت تطبيق د. مجدي) — شوف التفاصيل عند handleFaq تحت.

// أقصى حجم للصورة: ~6 ميجا (base64 بيكبّر الحجم 4/3)
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_BODY_CHARS = MAX_BASE64_CHARS + 4096;

const FIELDS = ['name', 'strength', 'dose', 'timesPerDay', 'durationDays', 'foodRelation'];

const PROMPT = `You are a careful transcription assistant for a medication-reminder app used in Egypt.
The image is a {KIND}. Doctors may write in English, Arabic, or a mix, often by hand.

Your ONLY job is to transcribe what is written. NEVER suggest, correct, add, or infer a medicine,
dose, frequency or duration that is not written. If something is not written, leave it empty/null.

Return ONLY JSON in exactly this shape:
{
  "medicines": [
    {
      "name": "brand or generic name exactly as written",
      "strength": "e.g. 500 mg, 1 g, 5 mg/ml — or empty",
      "dose": "amount per intake as written, e.g. 1 tab, قرص, 5 ml, 2 puffs — or empty",
      "timesPerDay": number or null,
      "durationDays": number or null,
      "foodRelation": "before" | "after" | "with" | "any",
      "notes": "any other instruction as written (e.g. at bedtime, عند اللزوم) — or empty",
      "uncertain": ["names of fields you are not fully sure about"]
    }
  ]
}

Rules:
- timesPerDay: convert only explicit frequencies: "1x2", "x2", "bid", "b.i.d", "مرتين", "كل 12 ساعة" = 2;
  "1x3", "tid", "t.i.d", "3 مرات", "كل 8 ساعات" = 3; "qid", "4 مرات", "كل 6 ساعات" = 4;
  "od", "once daily", "مرة يومياً", "qd" = 1. If not written, null.
- durationDays: "for 7 days", "x 7 days", "لمدة أسبوع" = 7, "أسبوعين" = 14, "شهر" = 30. If not written, null.
- foodRelation: "a.c"/"قبل الأكل" = before, "p.c"/"بعد الأكل" = after, "مع الأكل" = with, otherwise any.
- "uncertain" must list every field whose text is hard to read, ambiguous, or that you derived rather than read directly.
  Allowed values: ${FIELDS.join(', ')}.
- If the image has no medicines or is unreadable, return {"medicines": []}.
- Do not include patient names, doctor names or any other personal information.`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// ===== CORS — علشان تطبيقات الويب (زي تطبيق د. مجدي) تقدر تكلّم الخدمة =====
// ALLOWED_ORIGINS (var): روابط المواقع المسموح لها مفصولة بفاصلة، أو * للكل.
function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  if (!ok) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-app-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim()).slice(0, 200);
const num = (v) => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 && n < 400 ? Math.round(n) : null;
};

function clean(result) {
  const list = Array.isArray(result?.medicines) ? result.medicines : [];
  return list
    .map((m) => ({
      name: str(m?.name),
      strength: str(m?.strength),
      dose: str(m?.dose),
      timesPerDay: num(m?.timesPerDay),
      durationDays: num(m?.durationDays),
      foodRelation: ['before', 'after', 'with', 'any'].includes(m?.foodRelation) ? m.foodRelation : 'any',
      notes: str(m?.notes),
      uncertain: Array.isArray(m?.uncertain) ? m.uncertain.filter((f) => FIELDS.includes(f)) : [],
    }))
    .filter((m) => m.name)
    .slice(0, 20);
}


const HEALTH_HTML = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>دوايا</title>
<style>body{font-family:system-ui,sans-serif;background:#f6faf9;color:#0a3f3e;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:24px;padding:32px 40px;box-shadow:0 8px 30px #0a676622;text-align:center}
h1{margin:0 0 8px;color:#0e7c7b}</style></head>
<body><div class="c"><h1>💊 دوايا</h1><p>خدمة قراءة الروشتات شغالة</p></div></body></html>`;

// مقارنة ثابتة الوقت للتوكن
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function askGemini({ parts, model, key, withThinking }) {
  const generationConfig = { responseMimeType: 'application/json' };
  if (withThinking && model.startsWith('gemini-3')) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    },
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, model };
}

/// بيجرّب الموديل الأساسي، ولو عليه ضغط (429/5xx) بيجرّب الاحتياطي
async function readWithFallback(args, models) {
  let last;
  for (const model of models) {
    let r = await askGemini({ ...args, model, withThinking: true });
    if (!r.ok && r.status === 400) {
      // بعض الموديلات ما بتقبلش إعداد التفكير — نجرّب من غيره
      r = await askGemini({ ...args, model, withThinking: false });
    }
    if (r.ok) return r;
    last = r;
    if (!(r.status === 429 || r.status >= 500 || r.status === 404)) break;
  }
  return last;
}

/// الموديلات بالترتيب: الأساسي وبعده الاحتياطي
function modelList(env) {
  const primary = env.GEMINI_MODEL || 'gemini-3.6-flash';
  const fallbacks = String(env.GEMINI_FALLBACK_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== primary);
  return [primary, ...fallbacks];
}

/// نص الرد من Gemini (من غير أجزاء التفكير ولا ```json)
function replyText(data) {
  return (data?.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
    .trim();
}

/// التحقق من التوكن + حد الطلبات — بيرجّع Response لو مرفوض، أو null لو تمام
async function guard(request, env, bucket) {
  const appToken = env.APP_TOKEN;
  if (!appToken || !safeEqual(request.headers.get('x-app-token') ?? '', appToken)) {
    return json({ error: 'غير مصرح' }, 401);
  }
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: `${bucket}:${ip}` });
    if (!success) return json({ error: 'طلبات كتير ورا بعض، استنى دقيقة وجرّب تاني' }, 429);
  }
  if (!env.GEMINI_API_KEY) return json({ error: 'مفتاح Gemini مش متظبط في Cloudflare' }, 500);
  return null;
}

async function handleRead(request, env) {
  const denied = await guard(request, env, 'read');
  if (denied) return denied;
  const key = env.GEMINI_API_KEY;

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_CHARS) return json({ error: 'الصورة كبيرة قوي (أقصى حاجة 6 ميجا)' }, 413);

  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ error: 'طلب غير صحيح' }, 400);
  }
  if (raw.length > MAX_BODY_CHARS) return json({ error: 'الصورة كبيرة قوي (أقصى حاجة 6 ميجا)' }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'طلب غير صحيح' }, 400);
  }
  const image = typeof body?.image === 'string' ? body.image : '';
  const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(body?.mimeType)
    ? body.mimeType
    : 'image/jpeg';
  if (!image) return json({ error: 'الصورة فاضية' }, 400);
  if (image.length > MAX_BASE64_CHARS) return json({ error: 'الصورة كبيرة قوي (أقصى حاجة 6 ميجا)' }, 413);

  try {
    const parts = [
      { text: PROMPT.replace('{KIND}', body.kind === 'box' ? 'photo of a medicine box/package' : 'medical prescription (روشتة)') },
      { inline_data: { mime_type: mimeType, data: image } },
    ];
    const r = await readWithFallback({ parts, key }, modelList(env));
    if (!r?.ok) {
      console.error('Gemini error', r?.model, r?.status, JSON.stringify(r?.data ?? {}).slice(0, 500));
      const msg = r?.status === 429 || r?.status === 503
        ? 'الخدمة عليها ضغط، جرّب كمان دقيقة'
        : 'خدمة القراءة مش متاحة دلوقتي';
      return json({ error: msg }, 502);
    }
    const text = replyText(r.data);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ medicines: [] });
    }
    return json({ medicines: clean(parsed) });
  } catch (e) {
    console.error(e);
    return json({ error: 'حصلت مشكلة في القراءة، جرّب تاني' }, 500);
  }
}

// ===== بوت «اسألي د. مجدي» =====
//   POST /api/faq-match  header: x-app-token
//   body: { question: "سؤال المريضة", options: [{ id, q }] }
//   200 → { id: "رقم سؤال من options" | null, emergency: true|false }
// Gemini بيختار بس رقم السؤال المناسب — الإجابة نفسها دايمًا من faq.js المكتوب في التطبيق.
const MAX_FAQ_BODY = 64 * 1024;
const FAQ_PROMPT = `You match a pregnant patient's question (Egyptian Arabic, may be misspelled) to a fixed FAQ list
for an obstetrics clinic. You NEVER write answers or medical advice. You only pick an id.

FAQ list (id: question):
{OPTIONS}

Patient question:
"""{QUESTION}"""

Return ONLY JSON: {"id": "<one id from the list>" or null, "emergency": true or false}
- id: the single FAQ entry whose question has the same meaning as the patient's question.
  If none clearly matches, or the patient asks about her own specific case, return null.
- emergency: true if the text describes a possible emergency: vaginal bleeding, water/fluid leaking,
  severe headache or blurred vision, reduced or absent fetal movement, convulsions/seizures,
  fainting, severe abdominal pain, very high fever, thoughts of self-harm. Otherwise false.`;

async function handleFaq(request, env) {
  const denied = await guard(request, env, 'faq');
  if (denied) return denied;

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_FAQ_BODY) return json({ error: 'الطلب كبير قوي' }, 413);
  let raw;
  try {
    raw = await request.text();
  } catch {
    return json({ error: 'طلب غير صحيح' }, 400);
  }
  if (raw.length > MAX_FAQ_BODY) return json({ error: 'الطلب كبير قوي' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'طلب غير صحيح' }, 400);
  }

  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 500) : '';
  const options = (Array.isArray(body?.options) ? body.options : [])
    .slice(0, 200)
    .map((o) => ({
      id: String(o?.id ?? '').replace(/[^\w-]/g, '').slice(0, 40),
      q: String(o?.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }))
    .filter((o) => o.id && o.q);
  if (!question || !options.length) return json({ error: 'السؤال فاضي' }, 400);
  const ids = new Set(options.map((o) => o.id));

  try {
    const text = FAQ_PROMPT
      .replace('{OPTIONS}', options.map((o) => `${o.id}: ${o.q}`).join('\n'))
      .replace('{QUESTION}', question.replace(/"""/g, '"'));
    const r = await readWithFallback({ parts: [{ text }], key: env.GEMINI_API_KEY }, modelList(env));
    if (!r?.ok) {
      console.error('Gemini faq error', r?.model, r?.status, JSON.stringify(r?.data ?? {}).slice(0, 500));
      return json({ error: 'الخدمة مش متاحة دلوقتي' }, 502);
    }
    let parsed = {};
    try {
      parsed = JSON.parse(replyText(r.data));
    } catch {
      /* رد مش مفهوم → نعتبره مفيش تطابق */
    }
    const id = typeof parsed?.id === 'string' && ids.has(parsed.id) ? parsed.id : null;
    return json({ id, emergency: parsed?.emergency === true });
  } catch (e) {
    console.error(e);
    return json({ error: 'حصلت مشكلة، جرّب تاني' }, 500);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = { '/api/read-prescription': handleRead, '/api/faq-match': handleFaq }[pathname];
    if (route) {
      const cors = corsHeaders(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') {
        const res = json({ error: 'POST only' }, 405);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return res;
      }
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(HEALTH_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return json({ error: 'مش موجود' }, 404);
  },
};
