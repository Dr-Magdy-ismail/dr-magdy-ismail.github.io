// تطبيق أندرويد «د. مجدي — رحلة الحمل».
// التطبيق نفسه مكتوب HTML في فولدر web/ (نفس نسخة الويب). الملف ده بس بيعرضه جوه WebView،
// وبيعمل الحاجات اللي المتصفح ما يقدرش يعملها جوه تطبيق:
//   • كلام الخدمة (قراءة الروشتة + البوت) من الأندرويد نفسه
//   • فتح الاتصال والواتساب والتقويم في تطبيقاتهم
//   • مشاركة تقرير الـ PDF والنسخة الاحتياطية (واتساب…)
//   • الكاميرا / المعرض لصورة الروشتة، وزرار الرجوع
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

/// العنوان اللي الصفحة بتتحمّل عليه. بيانات المريضة (localStorage) مربوطة بيه —
/// ما تغيّروش بعد النشر، وإلا البيانات القديمة مش هتبان.
const kBase = 'https://app.drmagdy.invalid/';
const kPlum = Color(0xFF2F76B8); // الأزرق الأساسي
// نفس تدرّج الهيدر في التطبيق (أزرق سماوي ← بمبي)
const kGrad = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: [Color(0xFF4A9AE0), Color(0xFF7DB8EC), Color(0xFFF28DB5)],
  stops: [0, .45, 1],
);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.light,
    systemNavigationBarColor: Colors.white,
    systemNavigationBarIconBrightness: Brightness.dark,
  ));
  runApp(const DrMagdyApp());
}

class DrMagdyApp extends StatelessWidget {
  const DrMagdyApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'د. مجدي',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: kPlum, useMaterial3: true),
        builder: (context, child) => Directionality(textDirection: TextDirection.rtl, child: child!),
        home: const AppScreen(),
      );
}

class AppScreen extends StatefulWidget {
  const AppScreen({super.key});

  @override
  State<AppScreen> createState() => _AppScreenState();
}

class _AppScreenState extends State<AppScreen> {
  late final WebViewController _web;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF5F9FF))
      ..addJavaScriptChannel('DrMagdy', onMessageReceived: (m) => _onMessage(m.message))
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (req) {
          final u = req.url;
          if (u.startsWith(kBase) || u.startsWith('about:') || u.startsWith('data:') || u.startsWith('blob:')) {
            return NavigationDecision.navigate;
          }
          _openExternal(u);
          return NavigationDecision.prevent;
        },
        onPageFinished: (_) {
          if (mounted) setState(() => _loading = false);
        },
      ));
    _setupAndroid();
    _load();
  }

  Future<void> _setupAndroid() async {
    final p = _web.platform;
    if (p is AndroidWebViewController) {
      await p.setTextZoom(100); // التصميم معمول بخط كبير أصلًا
      await p.setOnShowFileSelector(_pickFiles);
    }
  }

  Future<void> _load() async {
    final html = await rootBundle.loadString('assets/app/app.html');
    await _web.loadHtmlString(html, baseUrl: kBase);
  }

  // ---------- رسايل من الصفحة ----------
  Future<void> _onMessage(String raw) async {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final id = msg['id'];
    Object? res;
    try {
      switch (msg['type']) {
        case 'post':
          res = await _post(msg);
        case 'get':
          res = await _get(msg);
        case 'open':
          await _openExternal('${msg['url']}');
          res = true;
        case 'share':
          await _share(msg);
          res = true;
      }
    } catch (e) {
      res = {'status': 0, 'body': '', 'error': e is TimeoutException ? 'timeout' : '$e'};
    }
    if (id != null) {
      await _web.runJavaScript('window.__nativeReply(${jsonEncode(id)}, ${jsonEncode(res)});');
    }
  }

  Future<Map<String, Object>> _post(Map<String, dynamic> msg) async {
    final headers = <String, String>{'content-type': 'application/json'};
    (msg['headers'] as Map? ?? {}).forEach((k, v) => headers['$k'] = '$v');
    final ms = (msg['timeout'] as num?)?.toInt() ?? 60000;
    final r = await http
        .post(Uri.parse('${msg['url']}'), headers: headers, body: '${msg['body'] ?? ''}')
        .timeout(Duration(milliseconds: ms));
    return {'status': r.statusCode, 'body': utf8.decode(r.bodyBytes, allowMalformed: true)};
  }

  /// قراءة ملفات المحتوى من جوجل (بيانات العيادة والأسئلة…) — من docs.google.com بس
  Future<Map<String, Object>> _get(Map<String, dynamic> msg) async {
    final uri = Uri.parse('${msg['url']}');
    if (uri.scheme != 'https' || uri.host != 'docs.google.com') {
      return {'status': 0, 'body': '', 'error': 'host not allowed'};
    }
    final ms = (msg['timeout'] as num?)?.toInt() ?? 15000;
    final r = await http.get(uri).timeout(Duration(milliseconds: ms));
    return {'status': r.statusCode, 'body': utf8.decode(r.bodyBytes, allowMalformed: true)};
  }

  Future<void> _share(Map<String, dynamic> msg) async {
    final dir = await getTemporaryDirectory();
    final name = '${msg['name'] ?? 'file'}'.split(RegExp(r'[\\/]')).last;
    final f = File('${dir.path}/$name');
    await f.writeAsBytes(base64Decode('${msg['b64']}'));
    await SharePlus.instance.share(ShareParams(
      files: [XFile(f.path, mimeType: msg['mime'] as String?)],
      text: msg['text'] as String?,
    ));
  }

  Future<void> _openExternal(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // مفيش تطبيق يفتح اللينك ده — نتجاهله
    }
  }

  // ---------- اختيار صورة الروشتة / ملف النسخة الاحتياطية ----------
  Future<List<String>> _pickFiles(FileSelectorParams params) async {
    final wantsImage = params.acceptTypes.any((t) => t.startsWith('image'));
    if (wantsImage) {
      final source = await showModalBottomSheet<ImageSource>(
        context: context,
        showDragHandle: true,
        builder: (c) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('صوّري بالكاميرا'),
              onTap: () => Navigator.pop(c, ImageSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('اختاري من الصور'),
              onTap: () => Navigator.pop(c, ImageSource.gallery),
            ),
            const SizedBox(height: 8),
          ]),
        ),
      );
      if (source == null) return [];
      final x = await ImagePicker().pickImage(source: source, maxWidth: 2400, maxHeight: 2400, imageQuality: 90);
      return x == null ? [] : [Uri.file(x.path).toString()];
    }
    final files = await FilePicker.pickFiles(type: FileType.any);
    if (files.isEmpty) return [];
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/picked-${DateTime.now().millisecondsSinceEpoch}.json');
    await f.writeAsBytes(await files.first.readAsBytes());
    return [Uri.file(f.path).toString()];
  }

  // ---------- زرار الرجوع ----------
  Future<void> _onBack() async {
    Object? handled;
    try {
      handled = await _web.runJavaScriptReturningResult('window.onNativeBack ? window.onNativeBack() : false');
    } catch (_) {}
    if (handled == true || '$handled' == 'true') return;
    await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack();
      },
      child: Scaffold(
        backgroundColor: Colors.white,
        body: Column(children: [
          // ورا شريط الساعة: نفس تدرّج الهيدر
          Container(height: pad.top, decoration: const BoxDecoration(gradient: kGrad)),
          Expanded(
            child: Stack(children: [
              WebViewWidget(controller: _web),
              if (_loading)
                const DecoratedBox(
                  decoration: BoxDecoration(gradient: kGrad),
                  child: Center(child: CircularProgressIndicator(color: Colors.white)),
                ),
            ]),
          ),
          Container(height: pad.bottom, color: Colors.white),
        ]),
      ),
    );
  }
}
