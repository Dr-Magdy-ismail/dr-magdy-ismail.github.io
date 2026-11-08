"""
بيظبط ملفات أندرويد اللي `flutter create` بيعملها (زي دوايا بالظبط):
اسم التطبيق بالعربي، صلاحية النت، فتح الواتساب/الاتصال، ومفتاح توقيع ثابت.
بيشتغل أوتوماتيك جوه GitHub Actions — مش محتاج تشغّله بإيدك.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
manifest = root / "android/app/src/main/AndroidManifest.xml"
gradle = root / "android/app/build.gradle.kts"


def fail(msg):
    print("patch_android: " + msg)
    sys.exit(1)


# ───────────── AndroidManifest.xml ─────────────
m = manifest.read_text(encoding="utf-8")

if "android.permission.INTERNET" not in m:
    m = m.replace(
        "<application",
        '<uses-permission android:name="android.permission.INTERNET"/>\n    <application',
        1,
    )

# اسم التطبيق تحت الأيقونة
m, n = re.subn(r'android:label="[^"]*"', 'android:label="د. مجدي"', m, count=1)
if n != 1:
    fail("android:label not found")

# بيانات المريضة على الموبايل بس — من غير نسخ احتياطي سحابي
if "android:allowBackup" not in m:
    m = m.replace(
        "<application",
        '<application\n        android:allowBackup="false"\n        android:fullBackupContent="false"',
        1,
    )

# أندرويد 11+: لازم نعلن عن التطبيقات اللي هنفتحها (واتساب/المتصفح/الاتصال)
INTENTS = """
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
        <intent>
            <action android:name="android.intent.action.DIAL" />
            <data android:scheme="tel" />
        </intent>
        <intent>
            <action android:name="android.media.action.IMAGE_CAPTURE" />
        </intent>
"""
if 'android:scheme="tel"' not in m:
    if "</queries>" in m:
        m = re.sub(r"[ \t]*</queries>", INTENTS.lstrip("\n") + "    </queries>", m, count=1)
    else:
        m = m.replace("</manifest>", "    <queries>" + INTENTS + "    </queries>\n</manifest>", 1)

manifest.write_text(m, encoding="utf-8")

# ───────────── build.gradle.kts ─────────────
g = gradle.read_text(encoding="utf-8")

# كل نسخة لازم تتوقّع بنفس المفتاح، وإلا التحديث ما يتثبّتش فوق القديم.
SIGNING = '''
    signingConfigs {
        create("drmagdy") {
            storeFile = rootProject.file("../tool/drmagdy.keystore")
            storePassword = "android"
            keyAlias = "drmagdy"
            keyPassword = "android"
        }
    }
'''
# المفتاح بييجي من GitHub Secrets (KEYSTORE_B64). لو مش موجود: توقيع مؤقت (للتجربة بس).
has_key = (root / "tool/drmagdy.keystore").exists()
if not has_key:
    print("patch_android: no tool/drmagdy.keystore — using a temporary debug key (updates won't install over this build)")
if has_key and 'create("drmagdy")' not in g:
    g, n = re.subn(r"(\n\s*buildTypes\s*\{)", SIGNING.rstrip("\n") + r"\1", g, count=1)
    if n != 1:
        fail("buildTypes block not found")
if has_key:
    g = re.sub(
        r'signingConfig\s*=\s*signingConfigs\.getByName\("debug"\)',
        'signingConfig = signingConfigs.getByName("drmagdy")',
        g,
    )
    if 'getByName("drmagdy")' not in g:
        fail("release signingConfig not found")

# أقل نسخة أندرويد مدعومة: 7.0
g = re.sub(r"minSdk\s*=\s*flutter\.minSdkVersion", "minSdk = 24", g)

gradle.write_text(g, encoding="utf-8")
print("patch_android: done")
