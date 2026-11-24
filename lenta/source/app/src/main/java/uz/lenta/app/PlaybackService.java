package uz.lenta.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * YouTube fonda (ilovadan chiqilganda, ekran o'chganda) ijro etilayotganda ishlaydigan xizmat.
 * Android ilovani o'chirib qo'ymasligi uchun bildirishnoma ko'rsatadi; ichida Pauza/Davom va To'xtatish tugmalari.
 */
public class PlaybackService extends Service {
    static final String CH = "playback";
    static final String ACTION_TOGGLE = "uz.lenta.app.TOGGLE";
    static final String ACTION_STOP = "uz.lenta.app.STOP";
    static final int ID = 7;

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;
    private boolean paused;

    static void start(Context c) {
        try {
            Intent i = new Intent(c, PlaybackService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception ignored) { } // ba'zi telefonlar fon xizmatini cheklaydi — ijro baribir davom etishi mumkin
    }

    static void stop(Context c) {
        try { c.stopService(new Intent(c, PlaybackService.class)); } catch (Exception ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(a)) {
            MainActivity.mediaCommand("window.__lentaStop&&window.__lentaStop()");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(a)) {
            paused = !paused;
            MainActivity.mediaCommand("window.__lentaToggle&&window.__lentaToggle()");
        }
        Notification n = build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    private Notification build() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "Fonda ijro", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int fl = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT), fl);
        PendingIntent toggle = PendingIntent.getService(this, 1, new Intent(this, PlaybackService.class).setAction(ACTION_TOGGLE), fl);
        PendingIntent stop = PendingIntent.getService(this, 2, new Intent(this, PlaybackService.class).setAction(ACTION_STOP), fl);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(paused ? "YouTube — pauza" : "YouTube fonda ijro etilmoqda")
                .setContentText("Lenta • ochish uchun bosing")
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, paused ? "Davom" : "Pauza", toggle).build())
                .addAction(new Notification.Action.Builder(null, "To'xtatish", stop).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void acquireLocks() {
        try {
            if (wake == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lenta:playback");
                wake.setReferenceCounted(false);
            }
            if (!wake.isHeld()) wake.acquire(6 * 60 * 60 * 1000L); // ko'pi bilan 6 soat
            if (wifi == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "lenta:playback");
                wifi.setReferenceCounted(false);
            }
            if (!wifi.isHeld()) wifi.acquire();
        } catch (Exception ignored) { }
    }

    @Override
    public void onDestroy() {
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignored) { }
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
