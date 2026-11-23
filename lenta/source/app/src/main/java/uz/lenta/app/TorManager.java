package uz.lenta.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import net.freehaven.tor.control.TorControlConnection;

import org.torproject.jni.TorService;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.InputStream;
import java.io.StringReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import IPtProxy.Controller;
import IPtProxy.IPtProxy;
import IPtProxy.OnTransportEvents;

/**
 * Ilova ichidagi Tor.
 *
 * Ko'priklar guruhlarga (bosqichlarga) bo'linadi: sizning ko'priklaringiz, oxirgi ishlagan, webtunnel,
 * snowflake, obfs4, meek. Har bosqichga vaqt beriladi; ulanish foizi o'smay qolsa ("osilib qolgan"
 * ko'prik — Rossiyada tez-tez bo'ladi), Tor qayta ishga tushirilmasdan keyingi bosqichga o'tkaziladi.
 * Ko'priklar ro'yxati saytdan ham yangilanadi — yangi APK chiqarmasdan.
 */
class TorManager {
    interface Listener {
        void onProgress(int pct, String tag, String stage, int stageNo, int stageCount);
        void onReady(int socksPort);
        void onError(String msg);
    }

    static final String REMOTE = "https://abdulaziz0196.github.io/tashlanov.ru/lenta/bridges.txt";
    private static final Pattern P_PROGRESS = Pattern.compile("PROGRESS=(\\d+)");
    private static final Pattern P_TAG = Pattern.compile("TAG=(\\S+)");
    private static final String[] TRANSPORTS = {IPtProxy.Webtunnel, IPtProxy.Snowflake, IPtProxy.Obfs4, IPtProxy.MeekLite};

    static final class Stage {
        final String key, name;
        final List<String> lines = new ArrayList<>();
        final int stallSec;
        Stage(String key, String name, int stallSec) { this.key = key; this.name = name; this.stallSec = stallSec; }
    }

    private final Context ctx;
    private final Listener l;
    private final SharedPreferences sp;
    private final Handler h = new Handler(Looper.getMainLooper());
    private Controller pt;
    private TorService svc;
    private final List<String> started = new ArrayList<>();
    private List<Stage> stages = new ArrayList<>();
    private int stageIdx;
    private boolean running, ready, bound, switching;
    private int port, lastPct = -1, rounds;
    private long lastChange, lastFlow, lastRead = -1, stageStart, rateAt;
    private double rate; // bayt/soniya, silliqlangan
    private String lastTag = "starting";

    TorManager(Context c, Listener l) {
        this.ctx = c.getApplicationContext();
        this.l = l;
        this.sp = ctx.getSharedPreferences("cfg", Context.MODE_PRIVATE);
    }

    boolean isReady() { return ready; }
    int port() { return port; }

    // ------------------------------------------------------------ ishga tushirish
    void start() {
        if (running) {
            if (ready) l.onReady(port);
            else report();
            return;
        }
        running = true;
        ready = false;
        lastPct = -1;
        new Thread(() -> {
            try {
                stages = buildStages(readAllBridges());
                startTransports();
                if (started.isEmpty()) throw new IllegalStateException("ko'prik transportlari ishga tushmadi");
                stages = filterStarted(stages);
                if (stages.isEmpty()) throw new IllegalStateException("ishlatsa bo'ladigan ko'prik yo'q");
                stageIdx = 0;
                writeTorrc(stages.get(0));
                h.post(this::bind);
            } catch (Throwable e) {
                running = false;
                h.post(() -> l.onError("Tor ishga tushmadi: " + e.getMessage()));
            }
            refreshRemote();
        }).start();
    }

    /** Foydalanuvchi "Boshqa ko'prik" bosdi yoki o'z ko'prigini qo'shdi. */
    void nextStage() {
        if (!running) { start(); return; }
        if (ready || svc == null) return;
        switchTo((stageIdx + 1) % stages.size());
    }

    /** O'z ko'priklari o'zgardi — ro'yxatni qayta tuzib, ulardan boshlaymiz. */
    void reloadBridges() {
        new Thread(() -> {
            List<Stage> st = filterStarted(buildStages(readAllBridges()));
            h.post(() -> {
                if (st.isEmpty()) return;
                stages = st;
                if (running && !ready && svc != null) switchTo(0);
            });
        }).start();
    }

    // ------------------------------------------------------------ ko'priklar
    private String readAllBridges() {
        StringBuilder b = new StringBuilder();
        b.append(sp.getString("bridges_custom", "")).append('\n');
        b.append(readFile(new File(ctx.getFilesDir(), "bridges_remote.txt"))).append('\n');
        b.append(readAsset("bridges.txt"));
        return b.toString();
    }

    private List<Stage> buildStages(String all) {
        LinkedHashMap<String, Stage> g = new LinkedHashMap<>();
        Stage custom = new Stage("custom", "Sizning ko'priklaringiz", 45);
        String customText = sp.getString("bridges_custom", "");
        LinkedHashSet<String> customSet = new LinkedHashSet<>(parse(customText));
        custom.lines.addAll(customSet);
        if (!custom.lines.isEmpty()) g.put("custom", custom);

        String last = sp.getString("last_good", "");
        String[] order = {IPtProxy.Webtunnel, IPtProxy.Snowflake, IPtProxy.Obfs4, IPtProxy.MeekLite};
        if (!last.isEmpty() && !last.equals("custom")) g.put(last, newStage(last));
        for (String t : order) if (!g.containsKey(t)) g.put(t, newStage(t));

        LinkedHashSet<String> seen = new LinkedHashSet<>(customSet);
        for (String line : parse(all)) {
            if (!seen.add(fingerprintKey(line))) continue;
            Stage s = g.get(transportOf(line));
            if (s != null) s.lines.add(line);
        }
        List<Stage> out = new ArrayList<>();
        for (Stage s : g.values()) if (!s.lines.isEmpty()) out.add(s);
        return out;
    }

    private static Stage newStage(String t) {
        switch (t) {
            case "webtunnel": return new Stage(t, "WebTunnel", 35);
            case "snowflake": return new Stage(t, "Snowflake", 60);
            case "obfs4": return new Stage(t, "obfs4", 30);
            case "meek_lite": return new Stage(t, "Meek (zaxira)", 90);
            default: return new Stage(t, t, 40);
        }
    }

    private List<Stage> filterStarted(List<Stage> in) {
        List<Stage> out = new ArrayList<>();
        for (Stage s : in) {
            Stage c = new Stage(s.key, s.name, s.stallSec);
            for (String line : s.lines) if (started.contains(transportOf(line))) c.lines.add(line);
            if (!c.lines.isEmpty()) out.add(c);
        }
        return out;
    }

    static List<String> parse(String text) {
        List<String> out = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new StringReader(text == null ? "" : text))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.startsWith("Bridge ")) line = line.substring(7).trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String t = transportOf(line);
                if (t.equals("webtunnel") || t.equals("snowflake") || t.equals("obfs4") || t.equals("meek_lite"))
                    out.add(line);
            }
        } catch (Exception ignored) { }
        return out;
    }

    static String transportOf(String line) { return line.split("\\s+", 2)[0].toLowerCase(); }

    private static String fingerprintKey(String line) {
        String[] p = line.split("\\s+");
        // snowflake qatorlari bir xil barmoq izi bilan turli sozlamalarda keladi — ularni to'liq solishtiramiz
        return p[0].equals("snowflake") || p.length < 3 ? line : p[0] + " " + p[2];
    }

    /** Saytdagi ko'priklar ro'yxatini yuklab, keyingi safar uchun saqlaydi. */
    private void refreshRemote() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(REMOTE + "?t=" + (System.currentTimeMillis() / 600000)).openConnection();
            c.setConnectTimeout(7000);
            c.setReadTimeout(7000);
            if (c.getResponseCode() != 200) return;
            String body = readStream(c.getInputStream());
            if (parse(body).isEmpty()) return;
            File f = new File(ctx.getFilesDir(), "bridges_remote.txt");
            String old = readFile(f);
            if (body.equals(old)) return;
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(body.getBytes("UTF-8")); }
            // yangi ko'priklar kelsa — hozirgi ulanish tugamagan bo'lsa ro'yxatga qo'shamiz
            List<Stage> st = filterStarted(buildStages(readAllBridges()));
            h.post(() -> {
                if (ready || !running || st.isEmpty()) return;
                String cur = stages.isEmpty() ? "" : stages.get(stageIdx).key;
                stages = st;
                int i = 0;
                for (int k = 0; k < st.size(); k++) if (st.get(k).key.equals(cur)) i = k;
                stageIdx = i;
            });
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------ transportlar va torrc
    private void startTransports() {
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
        started.clear();
        for (String t : TRANSPORTS) {
            try {
                if (pt.port(t) <= 0) pt.start(t, "");
                if (pt.port(t) > 0) started.add(t);
            } catch (Exception ignored) { }
        }
    }

    private void writeTorrc(Stage first) throws Exception {
        StringBuilder b = new StringBuilder();
        b.append("UseBridges 1\n");
        for (String t : started)
            b.append("ClientTransportPlugin ").append(t).append(" socks5 127.0.0.1:").append(pt.port(t)).append('\n');
        for (String line : first.lines) b.append("Bridge ").append(line).append('\n');
        b.append("ReducedConnectionPadding 1\n");
        b.append("DormantCanceledByStartup 1\n");
        b.append("ClientUseIPv6 1\n");
        b.append("ExitNodes {de},{nl},{fr},{se},{ch},{fi},{at},{gb},{us}\n");
        b.append("StrictNodes 0\n");
        // Instagram uchun bir xil chiqish IP — "shubhali kirish" kamroq
        b.append("TrackHostExits .instagram.com,.cdninstagram.com,.fbcdn.net,.facebook.com\n");
        b.append("TrackHostExitsExpire 3600\n");
        b.append("MaxCircuitDirtiness 1800\n");
        File f = TorService.getTorrc(ctx);
        //noinspection ResultOfMethodCallIgnored
        f.getParentFile().mkdirs();
        try (FileWriter w = new FileWriter(f, false)) { w.write(b.toString()); }
    }

    // ------------------------------------------------------------ Tor xizmati
    private final ServiceConnection conn = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName n, IBinder b) {
            svc = ((TorService.LocalBinder) b).getService();
            lastChange = System.currentTimeMillis();
            lastFlow = lastChange;
            report();
            h.post(poll);
        }

        @Override
        public void onServiceDisconnected(ComponentName n) {
            svc = null;
            if (running) { running = false; ready = false; l.onError("Tor to'xtab qoldi. Ilovani yopib, qayta oching."); }
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
                long read = -1;
                try { read = Long.parseLong(s.getInfo("traffic/read").trim()); } catch (Exception ignored) { }
                final long r = read;
                h.post(() -> handle(info, r));
            }).start();
        }
    };

    private void handle(String info, long read) {
        if (!running) return;
        long tn = System.currentTimeMillis();
        if (read >= 0) {
            if (lastRead >= 0 && rateAt > 0 && tn > rateAt) {
                double inst = (read - lastRead) * 1000.0 / (tn - rateAt);
                rate = rate * 0.6 + Math.max(0, inst) * 0.4;
            }
            // ko'prikdan ma'lumot kelib turibdimi? (sekin bo'lsa ham ishlayotgan ko'prikni uzmaymiz)
            if (lastRead >= 0 && read - lastRead > 3000) lastFlow = tn;
            lastRead = read;
            rateAt = tn;
        }
        int pct = lastPct;
        if (info != null) {
            Matcher m = P_PROGRESS.matcher(info);
            if (m.find()) pct = Integer.parseInt(m.group(1));
            Matcher t = P_TAG.matcher(info);
            if (t.find()) lastTag = t.group(1);
        }
        long now = System.currentTimeMillis();
        if (pct > lastPct) { lastPct = pct; lastChange = now; lastFlow = now; }
        report();
        if (pct >= 100) {
            port = svc.getSocksPort() > 0 ? svc.getSocksPort() : 9050;
            ready = true;
            if (!stages.isEmpty()) sp.edit().putString("last_good", stages.get(stageIdx).key).apply();
            l.onReady(port);
            return;
        }
        Stage cur = stages.isEmpty() ? null : stages.get(stageIdx);
        boolean noProgress = now - lastChange > cur_stall(cur) * 1000L;
        // 25% dan o'tgan ko'prik ishlashi isbotlangan: ma'lumot kelib tursa, 4 daqiqagacha kutamiz
        boolean noFlow = now - lastFlow > (lastPct >= 25 ? 30_000L : cur_stall(cur) * 1000L);
        boolean tooLong = now - lastChange > 240_000L;
        if (cur != null && !switching && noProgress && (noFlow || tooLong) && stages.size() > 1) {
            int next = (stageIdx + 1) % stages.size();
            if (next == 0) {
                rounds++;
                if (rounds == 1) l.onError("Hamma ko'priklar sinab ko'rildi — qaytadan aylanyapmiz. Wi-Fi va mobil internetni almashtirib ko'ring yoki @GetBridgesBot dan yangi ko'prik qo'shing.");
            }
            switchTo(next);
        }
        h.postDelayed(poll, 600);
    }

    private void switchTo(int idx) {
        if (svc == null || stages.isEmpty()) return;
        final TorService s = svc;
        final Stage st = stages.get(idx);
        stageIdx = idx;
        switching = true;
        lastChange = System.currentTimeMillis();
        lastFlow = lastChange;
        stageStart = lastChange;
        report();
        new Thread(() -> {
            try {
                TorControlConnection c = s.getTorControlConnection();
                if (c != null) {
                    List<String> conf = new ArrayList<>();
                    conf.add("UseBridges 1");
                    for (String line : st.lines) conf.add("Bridge " + line);
                    c.setConf(conf);
                    dropGuards(c);
                }
            } catch (Exception ignored) {
            } finally {
                h.post(() -> { switching = false; lastChange = System.currentTimeMillis(); });
            }
        }).start();
    }

    private static int cur_stall(Stage s) { return s == null ? 40 : s.stallSec; }

    /** Eski (osilib qolgan) ko'prik bilan aloqani tashlab, yangisini tanlashga majburlaydi. */
    private static void dropGuards(TorControlConnection c) {
        try {
            java.lang.reflect.Method m = TorControlConnection.class.getDeclaredMethod("sendAndWaitForResponse", String.class, String.class);
            m.setAccessible(true);
            m.invoke(c, "DROPGUARDS\r\n", null);
        } catch (Throwable ignored) { }
    }

    private void report() {
        Stage cur = stages.isEmpty() ? null : stages.get(Math.min(stageIdx, stages.size() - 1));
        String name = cur == null ? "" : cur.name;
        if (rate >= 512) name += " · " + (rate >= 1048576 ? String.format(java.util.Locale.US, "%.1f MB/s", rate / 1048576) : Math.round(rate / 1024) + " KB/s");
        l.onProgress(Math.max(lastPct, 0), lastTag, name, stageIdx + 1, stages.size());
    }

    void stop() {
        running = false;
        ready = false;
        h.removeCallbacks(poll);
        if (bound) { try { ctx.unbindService(conn); } catch (Exception ignored) { } bound = false; }
        svc = null;
        if (pt != null) for (String t : TRANSPORTS) { try { pt.stop(t); } catch (Exception ignored) { } }
    }

    // ------------------------------------------------------------ yordamchi
    private String readAsset(String name) {
        try (InputStream in = ctx.getAssets().open(name)) { return readStream(in); } catch (Exception e) { return ""; }
    }

    private static String readFile(File f) {
        if (!f.exists()) return "";
        try (InputStream in = new FileInputStream(f)) { return readStream(in); } catch (Exception e) { return ""; }
    }

    private static String readStream(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }
}
