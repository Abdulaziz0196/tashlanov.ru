package uz.lenta.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.torproject.jni.TorService;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import IPtProxy.Controller;
import IPtProxy.IPtProxy;
import IPtProxy.OnTransportEvents;

/**
 * Ilova ichidagi Tor: ko'prik transportlari (snowflake, webtunnel, obfs4) IPtProxy orqali,
 * Tor esa tor-android orqali ishlaydi. Tayyor bo'lgach SOCKS5 portini qaytaradi.
 */
class TorManager {
    interface Listener {
        void onProgress(int pct, String tag);
        void onReady(int socksPort);
        void onError(String msg);
    }

    private static final Pattern P_PROGRESS = Pattern.compile("PROGRESS=(\\d+)");
    private static final Pattern P_TAG = Pattern.compile("TAG=(\\S+)");
    private static final long STALL_MS = 150_000;

    private final Context ctx;
    private final Listener l;
    private final Handler h = new Handler(Looper.getMainLooper());
    private Controller pt;
    private TorService svc;
    private boolean running, ready, bound;
    private int port, lastPct = -1;
    private long lastChange;

    TorManager(Context c, Listener l) { this.ctx = c.getApplicationContext(); this.l = l; }

    boolean isReady() { return ready; }
    int port() { return port; }

    void start() {
        if (running) { if (ready) l.onReady(port); return; }
        running = true;
        ready = false;
        lastPct = -1;
        new Thread(() -> {
            try {
                List<String> ok = startTransports();
                if (ok.isEmpty()) throw new IllegalStateException("Ko'prik transportlari ishga tushmadi");
                writeTorrc(ok);
                h.post(this::bind);
            } catch (Throwable e) {
                running = false;
                h.post(() -> l.onError("Tor ishga tushmadi: " + e.getMessage()));
            }
        }).start();
    }

    private List<String> startTransports() {
        if (pt == null) {
            File st = new File(ctx.getFilesDir(), "pt");
            //noinspection ResultOfMethodCallIgnored
            st.mkdirs();
            pt = IPtProxy.newController(st.getAbsolutePath(), false, false, "ERROR", new OnTransportEvents() {
                @Override public void connected(String t) { }
                @Override public void error(String t, Exception e) { }
                @Override public void stopped(String t, Exception e) { }
            });
            // Rossiya uchun Tor loyihasi tavsiya qilgan snowflake sozlamalari
            pt.setSnowflakeBrokerUrl("https://1098762253.rsc.cdn77.org/");
            pt.setSnowflakeFrontDomains("cdn.zk.mk,img.icons8.com,cdn.kde.org");
            pt.setSnowflakeIceServers("stun:stun.antisip.com:3478,stun:stun.epygi.com:3478,stun:stun.uls.co.za:3478,stun:stun.telnyx.com:3478,stun:stun.hot-chilli.net:3478,stun:stun.fitauto.ru:3478,stun:stun.m-online.net:3478");
            pt.setSnowflakeMaxPeers(3);
        }
        List<String> ok = new ArrayList<>();
        for (String t : new String[]{IPtProxy.Webtunnel, IPtProxy.Snowflake, IPtProxy.Obfs4}) {
            try {
                if (pt.port(t) <= 0) pt.start(t, "");
                if (pt.port(t) > 0) ok.add(t);
            } catch (Exception ignored) { }
        }
        return ok;
    }

    private void writeTorrc(List<String> transports) throws Exception {
        StringBuilder b = new StringBuilder();
        b.append("UseBridges 1\n");
        for (String t : transports)
            b.append("ClientTransportPlugin ").append(t).append(" socks5 127.0.0.1:").append(pt.port(t)).append('\n');
        try (BufferedReader r = new BufferedReader(new InputStreamReader(ctx.getAssets().open("bridges.txt"), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String t = line.split(" ", 2)[0];
                if (transports.contains(t)) b.append("Bridge ").append(line).append('\n');
            }
        }
        // Tezlik va barqarorlik
        b.append("AvoidDiskWrites 1\n");
        b.append("ReducedConnectionPadding 1\n");
        b.append("DormantCanceledByStartup 1\n");
        b.append("ClientUseIPv6 1\n");
        // Katta va tez chiqish tugunlari bo'lgan davlatlar (majburiy emas)
        b.append("ExitNodes {de},{nl},{fr},{se},{ch},{fi},{at},{gb},{us}\n");
        b.append("StrictNodes 0\n");
        // Instagram uchun bir xil chiqish IP — "shubhali kirish" kamroq bo'ladi
        b.append("TrackHostExits .instagram.com,.cdninstagram.com,.fbcdn.net,.facebook.com\n");
        b.append("TrackHostExitsExpire 3600\n");
        b.append("MaxCircuitDirtiness 1800\n");
        File f = TorService.getTorrc(ctx);
        //noinspection ResultOfMethodCallIgnored
        f.getParentFile().mkdirs();
        try (FileWriter w = new FileWriter(f, false)) { w.write(b.toString()); }
    }

    private final ServiceConnection conn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName n, IBinder b) {
            svc = ((TorService.LocalBinder) b).getService();
            lastChange = System.currentTimeMillis();
            h.post(poll);
        }

        @Override
        public void onServiceDisconnected(ComponentName n) {
            svc = null;
            if (running) { running = false; ready = false; l.onError("Tor to'xtab qoldi"); }
        }
    };

    private void bind() {
        bound = ctx.bindService(new Intent(ctx, TorService.class), conn, Context.BIND_AUTO_CREATE);
        if (!bound) { running = false; l.onError("Tor xizmatini ochib bo'lmadi"); }
    }

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (!running || svc == null) return;
            final TorService s = svc;
            new Thread(() -> {
                String info = s.getInfo("status/bootstrap-phase");
                h.post(() -> handle(info));
            }).start();
        }
    };

    private void handle(String info) {
        if (!running) return;
        int pct = lastPct;
        String tag = "starting";
        if (info != null) {
            Matcher m = P_PROGRESS.matcher(info);
            if (m.find()) pct = Integer.parseInt(m.group(1));
            Matcher t = P_TAG.matcher(info);
            if (t.find()) tag = t.group(1);
        }
        long now = System.currentTimeMillis();
        if (pct != lastPct) { lastPct = pct; lastChange = now; l.onProgress(Math.max(pct, 0), tag); }
        if (pct >= 100) {
            port = svc.getSocksPort() > 0 ? svc.getSocksPort() : 9050;
            ready = true;
            l.onReady(port);
            return;
        }
        if (now - lastChange > STALL_MS) {
            // to'xtatmaymiz: Tor ko'pincha o'zi tiklanadi. Faqat ogohlantiramiz.
            lastChange = now;
            l.onError("Ulanish uzoq davom etyapti (" + Math.max(pct, 0) + "%). Internetni tekshiring yoki Wi-Fi/mobil internetni almashtirib ko'ring.");
        }
        h.postDelayed(poll, 700);
    }

    void stop() {
        running = false;
        ready = false;
        h.removeCallbacks(poll);
        if (bound) { try { ctx.unbindService(conn); } catch (Exception ignored) { } bound = false; }
        svc = null;
        if (pt != null) {
            for (String t : new String[]{IPtProxy.Webtunnel, IPtProxy.Snowflake, IPtProxy.Obfs4}) {
                try { pt.stop(t); } catch (Exception ignored) { }
            }
        }
    }
}
