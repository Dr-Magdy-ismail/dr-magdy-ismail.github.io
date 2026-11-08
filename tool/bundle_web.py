"""
بيجهّز نسخة التطبيق اللي جوه الـ APK من فولدر web/:
ملف واحد assets/app/app.html فيه faq.js واللوجو جواه
(لأن الصفحة بتتحمّل من غير سيرفر، فمفيش ملفات جنبها).
بيشتغل أوتوماتيك جوه GitHub Actions — مش محتاج تشغّله بإيدك.
"""
import base64
import os
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
web = root / "web"
out = root / "assets/app/app.html"


def fail(msg):
    print("bundle_web: " + msg)
    sys.exit(1)


html = (web / "index.html").read_text(encoding="utf-8")

# ملفات الويب بس (تثبيت من المتصفح) — مالهاش لازمة جوه التطبيق
html, n = re.subn(r'\s*<link rel="(manifest|icon|apple-touch-icon)"[^>]*>', "", html)
if n < 3:
    fail("manifest/icon links not found")

faq = (web / "faq.js").read_text(encoding="utf-8")
if '<script src="faq.js"></script>' not in html:
    fail("faq.js script tag not found")
html = html.replace('<script src="faq.js"></script>', "<script>\n" + faq.replace("</script", "<\\/script") + "\n</script>")

img = "data:image/png;base64," + base64.b64encode((web / "logo.png").read_bytes()).decode()
count = html.count("logo.png")
if count < 3:
    fail("logo.png references not found")
html = html.replace("logo.png", img)

# توكن الخدمة (نفس APP_TOKEN بتاع دوايا) — بييجي من GitHub Secrets، مش محفوظ في الكود
token = os.environ.get("APP_TOKEN", "").strip()
if token:
    if not re.fullmatch(r"[A-Za-z0-9_\-.]+", token):
        fail("APP_TOKEN has unexpected characters")
    html, n = re.subn(r'token:\s*""', 'token: "' + token + '"', html, count=1)
    if n != 1:
        fail("CLINIC.token placeholder not found")
    print("bundle_web: APP_TOKEN added")
else:
    print("bundle_web: no APP_TOKEN — prescription reading will say the service is off")

if "window.DrMagdy" not in html:
    fail("native bridge missing in index.html")

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"bundle_web: {out.relative_to(root)} ({len(html) // 1024} KB, logo.png x{count})")
