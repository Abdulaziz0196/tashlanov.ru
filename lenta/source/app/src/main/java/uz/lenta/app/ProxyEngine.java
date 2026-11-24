package uz.lenta.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Ommaviy bepul proksilar bilan ishlovchi "avto" rejim (Telegram'dagi kabi).
 *
 * 1. Ro'yxat yuklanadi: avval oxirgi ishlaganlar, keyin saytdagi tekshirilgan ro'yxat, kerak bo'lsa ochiq manbalar.
 * 2. Proksilar telefonning o'z internetidan parallel tekshiriladi: Instagram bilan haqiqiy TLS ulanishi va javob.
 * 3. WebView ichki (127.0.0.1) proksiga ulanadi. Ichki proksi har bir ulanishni eng tez ishlayotgan tashqi
 *    proksi orqali o'tkazadi; u ishlamay qolsa — keyingisiga o'zi o'tadi.
 * 4. Bloklovchi tizim (DPI) sayt nomini ko'rmasligi uchun: nom DNS-over-HTTPS orqali IP'ga aylantiriladi va
 *    TLS'ning birinchi paketi (ichida sayt nomi bor) bir necha TCP bo'lakka bo'lib yuboriladi.
 */
class ProxyEngine {
    interface Listener {
        void onSearch(int tested, int total, int found);
        void onReady(int localPort);
        void onSwitch(String info);
        void onError(String msg);
        /** YouTube uchun to'g'ridan-to'g'ri yo'l tekshirildi (proksisiz, to'liq tezlikda). */
        default void onDirect(boolean ok) { }
    }

    static final String SITE_LIST = "https://abdulaziz0196.github.io/tashlanov.ru/lenta/proxies.txt";
    static final int HTTP = 0, SOCKS4 = 4, SOCKS5 = 5, DIRECT = -1;

    /** Manba: manzil, sxemasiz qatorlar turi, navbat (1 — yangi/tekshirilgan, avval sinaladi), nechta olinadi. */
    static final class Src {
        final String url; final int type, tier, take;
        Src(String url, int type, int tier, int take) { this.url = url; this.type = type; this.tier = tier; this.take = take; }
    }

    static final Src[] SOURCES = {
            // rasmiy xizmatlar (API) — yaqinda tekshirilgan proksilar
            new Src("https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=text", SOCKS5, 1, 400),
            new Src("https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&proxy_format=protocolipport&format=text", SOCKS4, 1, 300),
            new Src("https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text", HTTP, 1, 300),
            new Src("https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5", SOCKS5, 1, 400),
            new Src("https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks4", SOCKS4, 1, 300),
            new Src("https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps", HTTP, 1, 300),
            // norasmiy ro'yxatlar (GitHub) — tekshirilganlari birinchi navbatda
            new Src("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", SOCKS5, 1, 300),
            new Src("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", SOCKS4, 1, 300),
            new Src("https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", SOCKS5, 1, 300),
            new Src("https://raw.githubusercontent.com/elliottophellia/proxylist/master/results/socks5/global/socks5_checked.txt", SOCKS5, 1, 200),
            new Src("https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt", SOCKS5, 2, 300),
            new Src("https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt", SOCKS4, 2, 200),
            new Src("https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", HTTP, 2, 200),
            new Src("https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", HTTP, 2, 300),
            new Src("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", SOCKS5, 2, 250),
            new Src("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", SOCKS4, 2, 200),
            new Src("https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", SOCKS5, 2, 250),
            new Src("https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/socks5_proxies.txt", SOCKS5, 2, 200),
            new Src("https://raw.githubusercontent.com/r00tee/Proxy-List/main/Socks5.txt", SOCKS5, 2, 250),
            new Src("https://raw.githubusercontent.com/dpangestuw/Free-Proxy/main/socks5_proxies.txt", SOCKS5, 2, 250),
            new Src("https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/socks5.txt", SOCKS5, 2, 100),
            new Src("https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt", SOCKS5, 2, 100),
            new Src("https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", SOCKS5, 2, 100),
            new Src("https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt", SOCKS4, 2, 150),
            new Src("https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/socks5.txt", SOCKS5, 2, 200),
            new Src("https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt", SOCKS5, 2, 200),
    };
    static final String TEST_HOST = "www.instagram.com";
    private static final int TEST_TIMEOUT = 7000;
    private static final int PARALLEL = 80;
    private static final int WANT = 12;
    private static final Pattern P_PROXY = Pattern.compile("(?:(socks5h?|socks4a?|socks|http|https)://)?(\\d{1,3}(?:\\.\\d{1,3}){3}):(\\d{2,5})");
    // GeoNode JSON: {"ip":"1.2.3.4", ... "port":"1080", ... "protocols":["socks5"]}
    private static final Pattern P_JSON = Pattern.compile("\"ip\"\\s*:\\s*\"(\\d{1,3}(?:\\.\\d{1,3}){3})\"[^{}]*?\"port\"\\s*:\\s*\"?(\\d{2,5})\"?[^{}]*?\"protocols\"\\s*:\\s*\\[\\s*\"(\\w+)\"");
    private static final Pattern P_IP = Pattern.compile("\"data\"\\s*:\\s*\"(\\d{1,3}(?:\\.\\d{1,3}){3})\"");

    static final class Up {
        final int type;
        final String host;
        final int port;
        volatile long ms = Long.MAX_VALUE;
        final AtomicInteger fails = new AtomicInteger();

        Up(int type, String host, int port) { this.type = type; this.host = host; this.port = port; }
        String key() { return type == DIRECT ? "direct://" : (type == SOCKS5 ? "socks5://" : type == SOCKS4 ? "socks4://" : "http://") + host + ":" + port; }
    }

    private final Context ctx;
    private final Listener l;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final CopyOnWriteArrayList<Up> good = new CopyOnWriteArrayList<>();
    private final ConcurrentLinkedQueue<Up> pending = new ConcurrentLinkedQueue<>();
    private final Set<String> seen = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final Map<String, String> dns = new ConcurrentHashMap<>();
    private final Map<String, Up> byKey = new ConcurrentHashMap<>();
    private volatile Up primary;
    /** Oxirgi ishlagan ("yopishqoq") proksi — Instagram uchun IP o'zgarmasligi muhim, aks holda "shubhali kirish". */
    private volatile String stickyKey;
    private volatile boolean stickyTesting;
    private volatile boolean running, ready, searching, readyScheduled;
    private ServerSocket server;
    private int localPort;
    private final AtomicInteger tested = new AtomicInteger();
    private volatile int total;
    private long lastReport;

    ProxyEngine(Context c, Listener l) { this.ctx = c.getApplicationContext(); this.l = l; }

    boolean isReady() { return ready; }
    int port() { return localPort; }
    String current() { Up p = primary; return p == null ? "" : p.host; }

    // ------------------------------------------------------------ boshqaruv
    void start() {
        if (running) {
            if (ready) l.onReady(localPort);
            else report(true);
            return;
        }
        running = true;
        io.execute(() -> {
            try {
                openServer();
                io.execute(this::prewarmDns);
                io.execute(this::checkDirect);
                search();
            } catch (Throwable e) {
                running = false;
                h.post(() -> l.onError("Proksi tizimi ishga tushmadi: " + e.getMessage()));
            }
        });
    }

    // ------------------------------------------------------------ YouTube: to'g'ridan-to'g'ri yo'l
    final Up DIRECT_UP = new Up(DIRECT, "", 0);
    /** null — hali tekshirilmagan, true — proksisiz ishlaydi, false — proksi kerak. */
    private volatile Boolean directYt;
    private volatile int directFails;

    static boolean isGoogleHost(String h) {
        h = h.toLowerCase();
        String[] d = {"youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "ggpht.com", "youtube-nocookie.com",
                "google.com", "gstatic.com", "googleapis.com", "googleusercontent.com"};
        for (String x : d) if (h.equals(x) || h.endsWith("." + x)) return true;
        return false;
    }

    /** YouTube'ga proksisiz ulanib bo'ladimi (sayt nomi bo'laklab yuborilganda)? */
    private void checkDirect() {
        boolean ok = false;
        for (int i = 0; i < 2 && running && !ok; i++) ok = test(DIRECT_UP, "www.youtube.com") > 0;
        directYt = ok;
        final boolean r = ok;
        h.post(() -> l.onDirect(r));
    }

    /** YouTube'ni ochish mumkinmi: to'g'ridan-to'g'ri yo'l ishlasa — proksi kutilmaydi. */
    boolean youtubeReady() { return ready || (localPort > 0 && Boolean.TRUE.equals(directYt)); }
    boolean directChecked() { return directYt != null; }
    boolean directOk() { return Boolean.TRUE.equals(directYt); }

    private static final long HEALTH_MS = 45000;
    private int healthFails;

    /**
     * Har 45 soniyada asosiy proksini tekshiradi. Ikki marta ketma-ket javob bermasa — foydalanuvchi
     * xatoni ko'rmasidan oldin zaxiradagisiga o'tamiz (ulanish "uzilib qolmasin").
     */
    private final Runnable health = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            final Up p = primary;
            if (p == null) { h.postDelayed(this, HEALTH_MS); return; }
            io.execute(() -> {
                long ms = test(p);
                h.post(() -> {
                    if (ms > 0) { p.ms = ms; healthFails = 0; }
                    else if (++healthFails >= 2) { healthFails = 0; p.fails.set(99); drop(p); }
                    h.postDelayed(health, HEALTH_MS);
                });
            });
        }
    };

    /** Instagram'ning asosiy manzillarini oldindan IP'ga aylantirib qo'yamiz — birinchi ochilish tezroq. */
    private void prewarmDns() {
        String[] hosts = {"www.instagram.com", "static.cdninstagram.com", "i.instagram.com", "graph.instagram.com",
                "scontent.cdninstagram.com", "www.facebook.com", "connect.facebook.net"};
        for (String host : hosts) { if (!running) return; resolve(host); }
    }

    /** Sahifa ochilmadi — hozirgi proksini tashlab, keyingisiga o'tamiz. */
    void rotate() {
        Up p = primary;
        if (p != null) { p.fails.set(99); drop(p); }
    }

    void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        io.shutdownNow();
    }

    // ------------------------------------------------------------ qidiruv
    private void search() {
        if (searching || !running) return;
        searching = true;
        try {
            if (pending.isEmpty()) loadCandidates();
            total = tested.get() + pending.size();
            report(true);
            if (stickyKey != null && !ready) { stickyTesting = true; io.execute(this::trySticky); }
            ExecutorService tp = Executors.newFixedThreadPool(PARALLEL);
            for (int i = 0; i < PARALLEL; i++) {
                tp.execute(() -> {
                    Up u;
                    while (running && good.size() < WANT && (u = pending.poll()) != null) {
                        long ms = test(u);
                        tested.incrementAndGet();
                        if (ms > 0) { u.ms = ms; addGood(u); }
                        report(false);
                    }
                });
            }
            tp.shutdown();
            tp.awaitTermination(10, TimeUnit.MINUTES);
        } catch (InterruptedException ignored) {
        } finally {
            searching = false;
        }
        saveGood();
        report(true);
        if (running && good.isEmpty())
            h.post(() -> l.onError("Ishlaydigan proksi topilmadi. Internetni tekshiring, Wi-Fi/mobil internetni almashtirib qayta oching yoki Tor rejimini sinab ko'ring."));
    }

    /** Oxirgi ishlagan proksini birinchi bo'lib (2 marta) tekshiradi; ishlasa — darhol o'shani ishlatamiz. */
    private void trySticky() {
        try {
            String k = stickyKey;
            if (k == null || ready) return;
            Up u = byKey.get(k);
            if (u == null || !pending.remove(u)) return;
            for (int i = 0; i < 2 && running; i++) {
                long ms = test(u);
                tested.incrementAndGet();
                if (ms > 0) {
                    u.ms = ms;
                    primary = u; // boshqalari tezroq bo'lsa ham — oldingi IP saqlanadi
                    if (!good.contains(u)) addGood(u);
                    return;
                }
            }
        } finally {
            stickyTesting = false;
        }
    }

    private void loadCandidates() {
        List<Up> list = new ArrayList<>();
        // 1) oldin ishlaganlar — eng birinchi; birinchi qatordagisi "yopishqoq" proksi
        List<Up> cached = parse(readFile(cacheFile()), SOCKS5);
        if (!cached.isEmpty() && stickyKey == null) stickyKey = cached.get(0).key();
        list.addAll(cached);
        // 2) saytdagi tekshirilgan ro'yxat (har bir necha soatda yangilanadi)
        List<Up> site = parse(fetch(SITE_LIST + "?t=" + (System.currentTimeMillis() / 900000)), SOCKS5);
        list.addAll(site);
        // 3) sayt ochilmasa yoki ro'yxat kichik bo'lsa — ochiq manbalardan
        if (site.size() < 40) {
            // barcha manbalar parallel yuklanadi; 1-navbatdagilar (yangi/tekshirilgan) avval sinaladi
            final List<List<Up>> parts = Collections.synchronizedList(new ArrayList<>());
            for (int i = 0; i < SOURCES.length; i++) parts.add(new ArrayList<>());
            ExecutorService dl = Executors.newFixedThreadPool(8);
            for (int i = 0; i < SOURCES.length; i++) {
                final int k = i;
                dl.execute(() -> {
                    Src src = SOURCES[k];
                    List<Up> part = parse(fetch(src.url), src.type);
                    Collections.shuffle(part);
                    parts.set(k, new ArrayList<>(part.subList(0, Math.min(part.size(), src.take))));
                });
            }
            dl.shutdown();
            try { dl.awaitTermination(25, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            for (int tier = 1; tier <= 2; tier++) {
                List<Up> t = new ArrayList<>();
                for (int i = 0; i < SOURCES.length; i++) if (SOURCES[i].tier == tier) t.addAll(parts.get(i));
                Collections.shuffle(t);
                list.addAll(t);
            }
        }
        for (Up u : list) if (seen.add(u.key())) { pending.add(u); byKey.put(u.key(), u); }
    }

    private static int typeOf(String scheme, int def) {
        if (scheme == null || scheme.isEmpty()) return def;
        scheme = scheme.toLowerCase();
        if (scheme.startsWith("socks4")) return SOCKS4;
        if (scheme.startsWith("socks")) return SOCKS5;
        return HTTP;
    }

    private static List<Up> parse(String text, int defaultType) {
        List<Up> out = new ArrayList<>();
        if (text == null) return out;
        if (text.trim().startsWith("{")) {
            Matcher j = P_JSON.matcher(text);
            while (j.find()) {
                try { out.add(new Up(typeOf(j.group(3), defaultType), j.group(1), Integer.parseInt(j.group(2)))); } catch (Exception ignored) { }
            }
            return out;
        }
        Matcher m = P_PROXY.matcher(text);
        while (m.find()) {
            String scheme = m.group(1) == null ? "" : m.group(1);
            int port;
            try { port = Integer.parseInt(m.group(3)); } catch (Exception e) { continue; }
            if (port <= 0 || port > 65535) continue;
            // sxemasiz qatorlar (ip:port) — manba turiga qarab
            out.add(new Up(typeOf(scheme, defaultType), m.group(2), port));
        }
        return out;
    }

    private void addGood(Up u) {
        good.add(u);
        sortGood();
        // asosiy proksi faqat bo'sh bo'lsa tanlanadi — tezrog'i topilsa ham IP'ni almashtirmaymiz
        if (ready && primary == null) primary = u;
        if (!ready && !readyScheduled) {
            readyScheduled = true;
            // birinchisi topildi: oldingi proksi tekshiruvi tugashini va yana bir lahzani kutib, tanlaymiz
            h.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (stickyTesting) { h.postDelayed(this, 700); return; }
                    if (primary == null && !good.isEmpty()) primary = good.get(0);
                    ready = true;
                    saveGood();
                    l.onReady(localPort);
                    h.postDelayed(health, HEALTH_MS);
                }
            }, 1500);
        }
    }

    private void sortGood() {
        List<Up> c = new ArrayList<>(good);
        Collections.sort(c, (a, b) -> Long.compare(a.ms, b.ms));
        good.clear();
        good.addAll(c);
    }

    private void drop(Up u) {
        good.remove(u);
        if (primary == u) {
            primary = good.isEmpty() ? null : good.get(0);
            saveGood();
            final Up p = primary;
            h.post(() -> l.onSwitch(p == null ? "" : p.host));
        }
        if (good.size() < 4 && running && !searching) io.execute(this::search);
    }

    private void report(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastReport < 300) return;
        lastReport = now;
        final int t = tested.get(), tot = Math.max(total, t), f = good.size();
        h.post(() -> l.onSearch(t, tot, f));
    }

    /** Proksini haqiqiy yo'l bilan tekshiradi: ichki proksi → tashqi proksi → Instagram (TLS + HTTP javob). */
    private long test(Up u) { return test(u, TEST_HOST); }

    private long test(Up u, String TEST_HOST) {
        long t0 = System.currentTimeMillis();
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress("127.0.0.1", localPort), 2000);
            s.setSoTimeout(TEST_TIMEOUT);
            OutputStream o = s.getOutputStream();
            o.write(("CONNECT " + TEST_HOST + ":443 HTTP/1.1\r\nHost: " + TEST_HOST + ":443\r\nX-Lenta-Up: " + u.key() + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            o.flush();
            String head = readHead(s.getInputStream());
            if (head == null || !head.startsWith("HTTP/1.1 200")) return -1;
            SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(s, TEST_HOST, 443, true);
            ssl.setSoTimeout(TEST_TIMEOUT);
            ssl.startHandshake();
            // soxta sertifikat bilan "ishlayotgan" proksilarni rad etamiz
            if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(TEST_HOST, ssl.getSession())) return -1;
            OutputStream so = ssl.getOutputStream();
            so.write(("HEAD / HTTP/1.1\r\nHost: " + TEST_HOST + "\r\nUser-Agent: Mozilla/5.0 (Linux; Android 14) Mobile\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            so.flush();
            String resp = readHead(ssl.getInputStream());
            if (resp == null || !resp.startsWith("HTTP/1.")) return -1;
            return Math.max(1, System.currentTimeMillis() - t0);
        } catch (Exception e) {
            return -1;
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    // ------------------------------------------------------------ ichki proksi
    private void openServer() throws IOException {
        server = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        localPort = server.getLocalPort();
        io.execute(() -> {
            while (running) {
                try {
                    final Socket c = server.accept();
                    io.execute(() -> handleClient(c));
                } catch (Exception e) {
                    if (!running) return;
                }
            }
        });
    }

    private void handleClient(Socket c) {
        Socket up = null;
        try {
            c.setTcpNoDelay(true);
            c.setSoTimeout(15000);
            String head = readHead(c.getInputStream());
            if (head == null) { c.close(); return; }
            String first = head.split("\r\n", 2)[0];
            String[] parts = first.split(" ");
            if (parts.length < 2 || !parts[0].equalsIgnoreCase("CONNECT")) {
                write(c, "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
                c.close();
                return;
            }
            String hp = parts[1];
            int colon = hp.lastIndexOf(':');
            String host = colon > 0 ? hp.substring(0, colon) : hp;
            int port = colon > 0 ? Integer.parseInt(hp.substring(colon + 1)) : 443;
            // xavfsizlik: faqat veb-portlar (443/80) — ichki proksidan boshqa maqsadda foydalanib bo'lmaydi
            if (port != 443 && port != 80) {
                write(c, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                c.close();
                return;
            }
            String forced = null;
            for (String line : head.split("\r\n")) if (line.regionMatches(true, 0, "X-Lenta-Up:", 0, 11)) forced = line.substring(11).trim();

            List<Up> order = new ArrayList<>();
            if (forced != null) {
                Up f = forced.equals(DIRECT_UP.key()) ? DIRECT_UP : byKey.get(forced);
                if (f != null) order.add(f);
            } else {
                // YouTube/Google: avval to'g'ridan-to'g'ri (sayt nomi yashirilgan holda) — to'liq tezlik, proksisiz
                if (isGoogleHost(host) && !Boolean.FALSE.equals(directYt)) order.add(DIRECT_UP);
                Up p = primary;
                if (p != null) order.add(p);
                for (Up g : good) if (g != p && order.size() < 4) order.add(g);
            }
            for (Up u : order) {
                try {
                    up = tunnel(u, host, port, forced != null ? TEST_TIMEOUT : (u == DIRECT_UP ? 5000 : 8000));
                    if (u == DIRECT_UP) { directFails = 0; break; }
                    u.fails.set(0);
                    // asosiy proksi bir marta xato qilsa — faqat shu ulanish uchun zaxiradan foydalanamiz;
                    // asosiysini faqat u butunlay ishlamay qolganda (ro'yxatdan chiqqanda) almashtiramiz
                    Up p = primary;
                    if (forced == null && u != p && (p == null || !good.contains(p))) {
                        primary = u;
                        saveGood();
                        h.post(() -> l.onSwitch(u.host));
                    }
                    break;
                } catch (Exception e) {
                    if (u == DIRECT_UP) { if (forced == null && ++directFails >= 4) directYt = false; continue; }
                    if (forced == null && u.fails.incrementAndGet() >= (u == primary ? 4 : 2)) drop(u);
                }
            }
            if (up == null) {
                write(c, "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
                c.close();
                return;
            }
            write(c, "HTTP/1.1 200 Connection established\r\n\r\n");
            c.setSoTimeout(0);
            up.setSoTimeout(0);
            final Socket fu = up;
            io.execute(() -> pipe(fu, c, null));
            pipe(c, up, host);
        } catch (Exception e) {
            closeQuietly(c);
            closeQuietly(up);
        }
    }

    /** Tashqi proksi orqali host:port ga tunnel ochadi (SOCKS5 yoki HTTP CONNECT). */
    private Socket tunnel(Up u, String host, int port, int timeout) throws IOException {
        Socket s = new Socket();
        try {
            s.setTcpNoDelay(true);
            if (u.type == DIRECT) {
                String ip = resolve(host);
                s.connect(new InetSocketAddress(ip != null ? ip : host, port), Math.min(timeout, 5000));
                s.setSoTimeout(timeout);
                return s;
            }
            s.connect(new InetSocketAddress(u.host, u.port), Math.min(timeout, 5000));
            s.setSoTimeout(timeout);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            String ip = resolve(host);
            if (u.type == SOCKS4) {
                // SOCKS4 (IP bo'lmasa — SOCKS4a: nom proksi tomonda aniqlanadi)
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                b.write(4);
                b.write(1);
                b.write((port >> 8) & 0xff);
                b.write(port & 0xff);
                if (ip != null) for (String p : ip.split("\\.")) b.write(Integer.parseInt(p));
                else b.write(new byte[]{0, 0, 0, 1});
                b.write(0);
                if (ip == null) { b.write(host.getBytes(StandardCharsets.US_ASCII)); b.write(0); }
                out.write(b.toByteArray());
                out.flush();
                byte[] rep = readN(in, 8);
                if (rep[1] != 0x5A) throw new IOException("socks4 connect " + rep[1]);
            } else if (u.type == SOCKS5) {
                out.write(new byte[]{5, 1, 0});
                out.flush();
                byte[] r = readN(in, 2);
                if (r[0] != 5 || r[1] != 0) throw new IOException("socks auth");
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                b.write(new byte[]{5, 1, 0});
                if (ip != null) {
                    b.write(1);
                    for (String p : ip.split("\\.")) b.write(Integer.parseInt(p));
                } else {
                    byte[] hb = host.getBytes(StandardCharsets.US_ASCII);
                    b.write(3);
                    b.write(hb.length);
                    b.write(hb);
                }
                b.write((port >> 8) & 0xff);
                b.write(port & 0xff);
                out.write(b.toByteArray());
                out.flush();
                byte[] rep = readN(in, 4);
                if (rep[1] != 0) throw new IOException("socks connect " + rep[1]);
                int skip = rep[3] == 1 ? 4 : rep[3] == 4 ? 16 : (readN(in, 1)[0] & 0xff);
                readN(in, skip + 2);
            } else {
                String target = (ip != null ? ip : host) + ":" + port;
                out.write(("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.flush();
                String head = readHead(in);
                if (head == null || !head.matches("(?s)HTTP/1\\.[01] 200.*")) throw new IOException("http connect");
            }
            return s;
        } catch (IOException e) {
            closeQuietly(s);
            throw e;
        }
    }

    /** Ma'lumotni uzatadi. host berilsa — birinchi TLS paketini bo'laklab yuboradi (sayt nomi DPI'ga ko'rinmasin). */
    private static void pipe(Socket from, Socket to, String host) {
        byte[] buf = new byte[32768];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n = in.read(buf);
            if (n > 0) {
                if (host != null && n > 6 && buf[0] == 0x16) writeSplit(out, buf, n, host);
                else out.write(buf, 0, n);
                out.flush();
            }
            while (n > 0 && (n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (Exception ignored) {
        } finally {
            // bir tomon tugasa — ikkala ulanishni yopamiz
            closeQuietly(from);
            closeQuietly(to);
        }
    }

    private static void writeSplit(OutputStream out, byte[] buf, int n, String host) throws IOException, InterruptedException {
        int idx = indexOf(buf, n, host.getBytes(StandardCharsets.US_ASCII));
        int cut = idx > 0 ? idx + Math.max(1, host.length() / 2) : Math.min(n - 1, 40);
        out.write(buf, 0, 1);
        out.flush();
        Thread.sleep(3);
        out.write(buf, 1, cut - 1);
        out.flush();
        Thread.sleep(3);
        out.write(buf, cut, n - cut);
    }

    private static int indexOf(byte[] a, int n, byte[] b) {
        outer:
        for (int i = 0; i + b.length <= n; i++) {
            for (int j = 0; j < b.length; j++) if (a[i + j] != b[j]) continue outer;
            return i;
        }
        return -1;
    }

    // ------------------------------------------------------------ DNS-over-HTTPS
    private String resolve(String host) {
        if (host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return host;
        String c = dns.get(host);
        if (c != null) return c.isEmpty() ? null : c;
        String ip = null;
        String[] urls = {
                "https://dns.google/resolve?type=A&name=" + host,
                "https://cloudflare-dns.com/dns-query?type=A&name=" + host,
                "https://doh.opendns.com/dns-query?type=A&name=" + host,
        };
        for (String u : urls) {
            String body = fetchDoh(u);
            if (body == null) continue;
            Matcher m = P_IP.matcher(body);
            if (m.find()) { ip = m.group(1); break; }
        }
        dns.put(host, ip == null ? "" : ip);
        return ip;
    }

    private static String fetchDoh(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection(java.net.Proxy.NO_PROXY);
            c.setConnectTimeout(3500);
            c.setReadTimeout(3500);
            c.setRequestProperty("Accept", "application/dns-json");
            if (c.getResponseCode() != 200) return null;
            return readAll(c.getInputStream(), 65536);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------ fayllar va tarmoq
    private File cacheFile() { return new File(ctx.getFilesDir(), "proxies_good.txt"); }

    private void saveGood() {
        StringBuilder b = new StringBuilder();
        Up p = primary;
        if (p != null) b.append(p.key()).append('\n');
        for (Up u : good) if (u != p) b.append(u.key()).append('\n');
        if (b.length() == 0) return;
        try (FileOutputStream o = new FileOutputStream(cacheFile())) { o.write(b.toString().getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) { }
    }

    private static String fetch(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection(java.net.Proxy.NO_PROXY);
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            if (c.getResponseCode() != 200) return null;
            return readAll(c.getInputStream(), 4 << 20);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readFile(File f) {
        if (!f.exists()) return "";
        try (InputStream in = new FileInputStream(f)) { return readAll(in, 1 << 20); } catch (Exception e) { return ""; }
    }

    private static String readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0 && b.size() < max) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int st = 0, c;
        while ((c = in.read()) >= 0) {
            b.write(c);
            if (b.size() > 16384) return null;
            st = (c == '\r' && (st == 0 || st == 2)) ? st + 1 : (c == '\n' && (st == 1 || st == 3)) ? st + 1 : 0;
            if (st == 4) return b.toString("ISO-8859-1");
        }
        return null;
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] r = new byte[n];
        int off = 0;
        while (off < n) {
            int k = in.read(r, off, n - off);
            if (k < 0) throw new IOException("eof");
            off += k;
        }
        return r;
    }

    private static void write(Socket s, String text) throws IOException {
        OutputStream o = s.getOutputStream();
        o.write(text.getBytes(StandardCharsets.US_ASCII));
        o.flush();
    }

    private static void closeQuietly(Socket s) {
        if (s != null) try { s.close(); } catch (IOException ignored) { }
    }
}
