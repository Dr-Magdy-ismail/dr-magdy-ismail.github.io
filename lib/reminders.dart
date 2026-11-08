// تنبيهات مواعيد الأدوية — بترن حتى والتطبيق مقفول (نفس طريقة دوايا).
// الصفحة (web/index.html) بتحسب مواعيد الجرعات للأيام الجاية وتبعتها هنا،
// وإحنا بنمسح القديم ونحجز الجديد في منبّه الأندرويد.
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Color;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_timezone/flutter_timezone.dart';
import 'package:timezone/data/latest.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

class Reminders {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static const _icon = 'ic_stat_drmagdy';
  static const _channelId = 'drmagdy_doses_v1';
  static const _maxAlarms = 300; // أندرويد بيسمح بحوالي 500 لكل تطبيق
  static bool _ready = false;

  static AndroidFlutterLocalNotificationsPlugin? get _android =>
      _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();

  static Future<void> init() async {
    if (_ready) return;
    tzdata.initializeTimeZones();
    var name = 'Africa/Cairo';
    try {
      name = (await FlutterTimezone.getLocalTimezone()).identifier;
    } catch (e) {
      debugPrint('timezone lookup failed: ${e.runtimeType}');
    }
    try {
      tz.setLocalLocation(tz.getLocation(name));
    } catch (_) {
      tz.setLocalLocation(tz.getLocation('Africa/Cairo'));
    }
    await _plugin.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings(_icon)),
    );
    _ready = true;
  }

  /// بيطلب إذن الإشعارات (وإذن المنبّه الدقيق لو محتاج) — بيرجّع الحالة
  static Future<Map<String, Object>> requestPermission() async {
    await init();
    final a = _android;
    if (a == null) return {'notif': false, 'exact': false};
    final notif = await a.requestNotificationsPermission() ?? false;
    var exact = await a.canScheduleExactNotifications() ?? true;
    if (!exact) {
      await a.requestExactAlarmsPermission();
      exact = await a.canScheduleExactNotifications() ?? false;
    }
    return {'notif': notif, 'exact': exact};
  }

  static Future<Map<String, Object>> status() async {
    await init();
    final a = _android;
    return {
      'notif': await a?.areNotificationsEnabled() ?? false,
      'exact': await a?.canScheduleExactNotifications() ?? false,
    };
  }

  /// items: [{at: "2026-11-09T09:00", title, body}] بالتوقيت المحلي
  static Future<int> schedule(List<dynamic> items) async {
    await init();
    await _plugin.cancelAll();
    final a = _android;
    if (!(await a?.areNotificationsEnabled() ?? true)) return 0;
    final exact = await a?.canScheduleExactNotifications() ?? false;

    const details = NotificationDetails(
      android: AndroidNotificationDetails(
        _channelId,
        'مواعيد الأدوية',
        channelDescription: 'تنبيه بميعاد كل جرعة',
        importance: Importance.high,
        priority: Priority.high,
        icon: _icon,
        color: Color(0xFF2F76B8),
      ),
    );

    final now = DateTime.now();
    var id = 1, count = 0;
    for (final raw in items) {
      if (count >= _maxAlarms) break;
      if (raw is! Map) continue;
      final at = DateTime.tryParse('${raw['at']}');
      if (at == null || !at.isAfter(now)) continue;
      final when = tz.TZDateTime(tz.local, at.year, at.month, at.day, at.hour, at.minute);
      final title = '${raw['title'] ?? 'ميعاد الدوا'}';
      final body = '${raw['body'] ?? ''}';
      try {
        await _plugin.zonedSchedule(
          id: id,
          scheduledDate: when,
          notificationDetails: details,
          androidScheduleMode: exact ? AndroidScheduleMode.exactAllowWhileIdle : AndroidScheduleMode.inexactAllowWhileIdle,
          title: title,
          body: body,
          payload: '',
        );
      } catch (e) {
        // لو صلاحية المنبّه الدقيق اتسحبت: نحجز بالطريقة العادية
        try {
          await _plugin.zonedSchedule(
            id: id,
            scheduledDate: when,
            notificationDetails: details,
            androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
            title: title,
            body: body,
            payload: '',
          );
        } catch (e2) {
          debugPrint('schedule failed: ${e2.runtimeType}');
          continue;
        }
      }
      id++;
      count++;
    }
    return count;
  }
}
