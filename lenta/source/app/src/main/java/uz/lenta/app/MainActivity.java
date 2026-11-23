package uz.lenta.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.content.res.ColorStateList;
import android.view.Gravity;
import android.util.TypedValue;

import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.Authenticator;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.PasswordAuthentication;
import java.net.Proxy;
import java.net.URL;
import java.util.Collections;
import java.util.concurrent.Executor;

/**
 * Ikki oyna: "home" — ilovaning o'z sahifasi (sozlamalar, mavzu), "ig" — instagram.com sayti.
 * Barcha ig trafigi foydalanuvchi kiritgan proksi orqali o'tadi (ProxyController).
 * JS ko'prigi faqat home oynasida, instagram sahifalariga berilmaydi.
 */
public class MainActivity extends Activity {
    static final String IG = "https://www.instagram.com/";
    static final String HOME = "file:///android_asset/start.html";
    static final int PICK = 7;

    SharedPreferences sp;
    WebView home, ig;
    boolean igLoaded;
    String loadedProxy = null;
    int authTries;
    ValueCallback<Uri[]> fileCb;
    ScriptHandler themeScript;
    final Handler ui = new Handler(Looper.getMainLooper());
    final Executor uiExec = ui::post;
    TorManager tor;
    ProxyEngine px;
    int autoRetries;
    boolean hadError;
    // Instagram yuklanayotganda ko'rinadigan oyna (qora ekran o'rniga) va "osilib qolish" nazorati
    LinearLayout loader;
    TextView loaderTitle, loaderTxt;
    ProgressBar topBar;
    boolean committed;
    static final long LOAD_LIMIT_MS = 25000;
    final Runnable watchdog = this::onLoadTooSlow;
    boolean pendingOpen;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        sp = getSharedPreferences("cfg", MODE_PRIVATE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        ig = new WebView(this);
        setupIg();
        home = new WebView(this);
        setupHome();

        ViewGroup.LayoutParams mp = new ViewGroup.LayoutParams(-1, -1);
        root.addView(ig, mp);
        loader = buildLoader();
        loader.setVisibility(View.GONE);
        root.addView(loader, mp);
        topBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        topBar.setMax(100);
        topBar.setProgressTintList(ColorStateList.valueOf(0xFFF7A70B));
        topBar.setVisibility(View.GONE);
        root.addView(topBar, new FrameLayout.LayoutParams(-1, dp(4), Gravity.TOP));
        root.addView(home, mp);
        ig.setVisibility(View.GONE);
        setContentView(root);
        tor = new TorManager(this, new TorManager.Listener() {
            @Override public void onProgress(int pct, String tag, String stage, int no, int count) {
                home("onTor(" + pct + "," + JSONObject.quote(tag) + "," + JSONObject.quote(stage) + "," + no + "," + count + ")");
            }
            @Override public void onReady(int port) {
                home("onTorReady()");
                if (pendingOpen) { pendingOpen = false; applyAndOpen(); }
            }
            @Override public void onError(String msg) { home("onTorWarn(" + JSONObject.quote(msg) + ")"); }
        });
        px = new ProxyEngine(this, new ProxyEngine.Listener() {
            @Override public void onSearch(int tested, int total, int found) { home("onPx(" + tested + "," + total + "," + found + ")"); }
            @Override public void onReady(int port) {
                home("onPxReady()");
                if (pendingOpen) { pendingOpen = false; applyAndOpen(); }
            }
            @Override public void onSwitch(String host) { home("onPxSwitch(" + JSONObject.quote(host) + ")"); }
            @Override public void onError(String msg) {
                if (pendingOpen) { pendingOpen = false; home("onErr(" + JSONObject.quote(msg) + ")"); }
                else home("onTorWarn(" + JSONObject.quote(msg) + ")");
            }
        });
        // eski versiyalardan: yangi "avto" rejimiga o'tkazamiz
        if (!sp.getBoolean("mode_v4", false)) sp.edit().putString("mode", "auto").putBoolean("mode_v4", true).apply();
        startEngine();
        home.loadUrl(HOME);
    }

    // ---------------- home (ilova sahifasi) ----------------
    void setupHome() {
        home.setBackgroundColor(Color.BLACK);
        home.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = home.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        home.addJavascriptInterface(new Bridge(), "Native");
        home.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (u.toString().startsWith("file:///android_asset/")) return false;
                openExternal(u);
                return true;
            }
        });
    }

    class Bridge {
        @JavascriptInterface
        public String config() {
            JSONObject o = new JSONObject();
            try {
                o.put("proxy", sp.getString("proxy", ""));
                o.put("user", sp.getString("user", ""));
                o.put("pass", sp.getString("pass", ""));
                o.put("theme", sp.getString("theme", "gold"));
                o.put("zoom", sp.getInt("zoom", 100));
                o.put("auto", sp.getBoolean("auto", true));
                o.put("mode", mode());
                o.put("eco", sp.getBoolean("eco", true));
                o.put("torReady", tor != null && tor.isReady());
                o.put("bridges", sp.getString("bridges_custom", ""));
                o.put("proxyOk", WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE));
            } catch (Exception ignored) { }
            return o.toString();
        }

        @JavascriptInterface
        public void save(String json) {
            try {
                JSONObject o = new JSONObject(json);
                sp.edit()
                        .putString("proxy", o.optString("proxy", "").trim())
                        .putString("user", o.optString("user", ""))
                        .putString("pass", o.optString("pass", ""))
                        .putString("theme", o.optString("theme", "gold"))
                        .putInt("zoom", Math.max(80, Math.min(140, o.optInt("zoom", 100))))
                        .putBoolean("auto", o.optBoolean("auto", true))
                        .putString("mode", o.optString("mode", "auto"))
                        .putBoolean("eco", o.optBoolean("eco", true))
                        .apply();
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void test(final String proxy, final String user, final String pass) {
            new Thread(() -> {
                String direct = probe(Proxy.NO_PROXY, null, null);
                String via = proxy.trim().isEmpty() ? "none" : probeProxy(proxy.trim(), user, pass);
                home("onTest(" + JSONObject.quote(direct) + "," + JSONObject.quote(via) + ")");
            }).start();
        }

        @JavascriptInterface
        public void open() { ui.post(MainActivity.this::applyAndOpen); }

        @JavascriptInterface
        public int setBridges(String text) {
            int n = TorManager.parse(text).size();
            sp.edit().putString("bridges_custom", text == null ? "" : text.trim()).apply();
            ui.post(() -> tor.reloadBridges());
            return n;
        }

        @JavascriptInterface
        public void cancel() { ui.post(() -> pendingOpen = false); }

        @JavascriptInterface
        public void nextBridge() { ui.post(() -> tor.nextStage()); }

        @JavascriptInterface
        public void connect() { ui.post(MainActivity.this::startEngine); }
    }

    // ---------------- proksi ----------------
    static String normalize(String p) {
        p = p.trim();
        if (!p.contains("://")) return "http://" + p;
        String scheme = p.substring(0, p.indexOf("://")).toLowerCase();
        String rest = p.substring(p.indexOf("://") + 3);
        if (scheme.equals("socks")) scheme = "socks5";
        return scheme + "://" + rest;
    }

    String mode() {
        String m = sp.getString("mode", "auto");
        return m.equals("proxy") || m.equals("direct") || m.equals("tor") ? m : "auto";
    }

    void startEngine() {
        String m = mode();
        if (m.equals("auto")) px.start();
        else if (m.equals("tor")) tor.start();
    }

    void applyAndOpen() {
        String m = mode();
        boolean can = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE);
        if (m.equals("auto")) {
            if (!can) { home("onErr(" + JSONObject.quote("Telefoningizdagi Android System WebView eskirgan. Play Market'dan yangilang.") + ")"); return; }
            if (!px.isReady()) { pendingOpen = true; px.start(); home("onWait()"); return; }
            final int port = px.port();
            try {
                ProxyConfig cfg = new ProxyConfig.Builder().addProxyRule("http://127.0.0.1:" + port).build();
                ProxyController.getInstance().setProxyOverride(cfg, uiExec, () -> showIg("auto:" + port));
            } catch (Exception e) { home("onErr(" + JSONObject.quote("Proksi o'rnatilmadi: " + e.getMessage()) + ")"); }
            return;
        }
        if (m.equals("tor")) {
            if (!can) { home("onErr(" + JSONObject.quote("Telefoningizdagi Android System WebView eskirgan. Play Market'dan yangilang.") + ")"); return; }
            if (!tor.isReady()) { pendingOpen = true; tor.start(); home("onWait()"); return; }
            final int port = tor.port();
            try {
                ProxyConfig cfg = new ProxyConfig.Builder().addProxyRule("socks5://127.0.0.1:" + port).build();
                ProxyController.getInstance().setProxyOverride(cfg, uiExec, () -> showIg("tor:" + port));
            } catch (Exception e) { home("onErr(" + JSONObject.quote("Tor proksisi o'rnatilmadi: " + e.getMessage()) + ")"); }
            return;
        }
        if (m.equals("direct")) {
            if (can) ProxyController.getInstance().clearProxyOverride(uiExec, () -> showIg("direct"));
            else showIg("direct");
            return;
        }
        final String proxy = sp.getString("proxy", "").trim();
        try {
            if (proxy.isEmpty()) {
                if (can) ProxyController.getInstance().clearProxyOverride(uiExec, () -> showIg(""));
                else showIg("");
            } else {
                if (!can) { home("onErr(" + JSONObject.quote("Telefoningizdagi Android System WebView eskirgan. Play Market'dan yangilang.") + ")"); return; }
                ProxyConfig cfg = new ProxyConfig.Builder().addProxyRule(normalize(proxy)).build();
                ProxyController.getInstance().setProxyOverride(cfg, uiExec, () -> showIg(proxy));
            }
        } catch (Exception e) {
            home("onErr(" + JSONObject.quote("Proksi manzili noto'g'ri: " + e.getMessage()) + ")");
        }
    }

    void showIg(String proxy) {
        ig.getSettings().setTextZoom(sp.getInt("zoom", 100));
        ig.getSettings().setMediaPlaybackRequiresUserGesture(sp.getBoolean("eco", true));
        installTheme();
        boolean reload = !igLoaded || !proxy.equals(loadedProxy);
        loadedProxy = proxy;
        authTries = 0;
        if (reload) {
            committed = false;
            autoRetries = 0;
            showLoader("Instagram yuklanmoqda…", proxyInfo());
            ig.loadUrl(IG);
            igLoaded = true;
            ui.removeCallbacks(watchdog);
            ui.postDelayed(watchdog, LOAD_LIMIT_MS);
        } else ig.evaluateJavascript(themeJs(), null);
        ig.setVisibility(View.VISIBLE);
        ig.setAlpha(0f);
        ig.animate().alpha(1f).setDuration(350).start();
        home.animate().alpha(0f).setDuration(300).withEndAction(() -> home.setVisibility(View.GONE)).start();
    }

    void showHome() {
        home.setVisibility(View.VISIBLE);
        home.setAlpha(0f);
        home.animate().alpha(1f).setDuration(300).start();
        home("onBack()");
    }

    String probeProxy(String p, String user, String pass) {
        try {
            String n = normalize(p);
            String scheme = n.substring(0, n.indexOf("://"));
            String hp = n.substring(n.indexOf("://") + 3);
            if (hp.endsWith("/")) hp = hp.substring(0, hp.length() - 1);
            if (scheme.equals("https")) return "skip";
            int colon = hp.lastIndexOf(':');
            String host = colon > 0 ? hp.substring(0, colon) : hp;
            int port = colon > 0 ? Integer.parseInt(hp.substring(colon + 1)) : (scheme.startsWith("socks") ? 1080 : 80);
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            Proxy.Type t = scheme.startsWith("socks") ? Proxy.Type.SOCKS : Proxy.Type.HTTP;
            return probe(new Proxy(t, InetSocketAddress.createUnresolved(host, port)), user, pass);
        } catch (Exception e) {
            return "err:Manzil noto'g'ri";
        }
    }

    static String probe(Proxy px, final String user, final String pass) {
        HttpURLConnection c = null;
        try {
            if (user != null && !user.isEmpty()) {
                Authenticator.setDefault(new Authenticator() {
                    @Override
                    protected PasswordAuthentication getPasswordAuthentication() {
                        if (getRequestorType() == RequestorType.PROXY)
                            return new PasswordAuthentication(user, pass.toCharArray());
                        return null;
                    }
                });
            }
            long t0 = System.currentTimeMillis();
            c = (HttpURLConnection) new URL(IG).openConnection(px);
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) Mobile");
            int code = c.getResponseCode();
            if (code == 407) return "err:Proksi login/paroli noto'g'ri";
            return "ok:" + (System.currentTimeMillis() - t0);
        } catch (java.net.SocketTimeoutException e) {
            return "err:Javob yo'q (vaqt tugadi)";
        } catch (Exception e) {
            String m = e.getMessage();
            return "err:" + (m == null ? e.getClass().getSimpleName() : m);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ---------------- instagram oynasi ----------------
    void setupIg() {
        ig.setBackgroundColor(Color.BLACK);
        WebSettings s = ig.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        // WebView belgisini olib tashlaymiz, aks holda sayt "ilovani yuklab oling" deb qayta-qayta so'raydi
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\S+ ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(ig, true);

        ig.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String h = u.getHost() == null ? "" : u.getHost();
                String sch = u.getScheme() == null ? "" : u.getScheme();
                if (sch.equals("https") && (h.endsWith("instagram.com") || h.endsWith("facebook.com") || h.endsWith("fbcdn.net") || h.endsWith("cdninstagram.com")))
                    return false;
                openExternal(u);
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                topBar.setProgress(5);
                topBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageCommitVisible(WebView v, String url) {
                // sahifa ko'rina boshladi — yuklanish oynasini yopamiz
                committed = true;
                ui.removeCallbacks(watchdog);
                hideLoader();
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                topBar.setVisibility(View.GONE);
                authTries = 0;
                if (!hadError) autoRetries = 0;
                hadError = false;
                v.evaluateJavascript(themeJs(), null);
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView v, HttpAuthHandler hh, String host, String realm) {
                String u = sp.getString("user", "");
                if (!u.isEmpty() && authTries++ < 3) hh.proceed(u, sp.getString("pass", ""));
                else { hh.cancel(); toHomeWithErr("Proksi login/paroli qabul qilinmadi"); }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                hadError = true;
                // avto rejim: boshqa proksiga o'tib, sahifani qayta yuklaymiz (Telegram'dagi kabi)
                if (mode().equals("auto") && autoRetries < 5) {
                    autoRetries++;
                    px.rotate();
                    committed = false;
                    showLoader("Boshqa proksiga o'tilmoqda… (" + autoRetries + "/5)", proxyInfo());
                    ui.removeCallbacks(watchdog);
                    ui.postDelayed(watchdog, LOAD_LIMIT_MS);
                    ui.postDelayed(() -> v.loadUrl(IG), 400);
                    return;
                }
                toHomeWithErr("Ulanib bo'lmadi: " + e.getDescription());
            }
        });

        ig.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                topBar.setProgress(Math.max(5, p));
                if (p >= 100) topBar.setVisibility(View.GONE);
                if (!committed && loader.getVisibility() == View.VISIBLE)
                    loaderTxt.setText(proxyInfo() + (p > 10 ? "\nYuklandi: " + p + "%" : ""));
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), PICK); }
                catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
    }

    // ---------------- yuklanish oynasi ----------------
    int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    LinearLayout buildLoader() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setBackgroundColor(Color.BLACK);
        l.setPadding(dp(32), dp(32), dp(32), dp(32));
        l.setClickable(true);
        ProgressBar spin = new ProgressBar(this);
        spin.setIndeterminateTintList(ColorStateList.valueOf(0xFFF7A70B));
        l.addView(spin, new LinearLayout.LayoutParams(dp(56), dp(56)));
        loaderTitle = new TextView(this);
        loaderTitle.setTextColor(0xFFF5F5F5);
        loaderTitle.setTextSize(19);
        loaderTitle.setGravity(Gravity.CENTER);
        loaderTitle.setPadding(0, dp(20), 0, dp(8));
        l.addView(loaderTitle);
        loaderTxt = new TextView(this);
        loaderTxt.setTextColor(0xFF8E8E96);
        loaderTxt.setTextSize(14);
        loaderTxt.setGravity(Gravity.CENTER);
        loaderTxt.setPadding(0, 0, 0, dp(24));
        l.addView(loaderTxt);
        Button next = new Button(this);
        next.setText("Boshqa proksi");
        next.setAllCaps(false);
        next.setTextColor(0xFF141005);
        next.setBackgroundTintList(ColorStateList.valueOf(0xFFF7A70B));
        next.setOnClickListener(v -> switchProxyAndReload());
        l.addView(next, new LinearLayout.LayoutParams(dp(220), dp(52)));
        Button back = new Button(this);
        back.setText("Orqaga");
        back.setAllCaps(false);
        back.setTextColor(0xFFD4D4D8);
        back.setBackgroundTintList(ColorStateList.valueOf(0xFF1B1B20));
        back.setOnClickListener(v -> { ui.removeCallbacks(watchdog); hideLoader(); igLoaded = false; ig.stopLoading(); showHome(); });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(dp(220), dp(52));
        bp.topMargin = dp(10);
        l.addView(back, bp);
        return l;
    }

    String proxyInfo() {
        String m = mode();
        if (m.equals("auto")) { String h = px.current(); return h.isEmpty() ? "Proksi qidirilmoqda" : "Proksi: " + h; }
        if (m.equals("tor")) return "Tor orqali";
        if (m.equals("proxy")) return "O'z proksingiz orqali";
        return "To'g'ridan-to'g'ri";
    }

    void showLoader(String title, String txt) {
        loaderTitle.setText(title);
        loaderTxt.setText(txt);
        loader.setVisibility(View.VISIBLE);
        loader.bringToFront();
        topBar.bringToFront();
        if (home.getVisibility() == View.VISIBLE) home.bringToFront();
    }

    void hideLoader() { loader.setVisibility(View.GONE); }

    void switchProxyAndReload() {
        if (mode().equals("auto")) px.rotate();
        committed = false;
        showLoader("Boshqa proksiga o'tilmoqda…", proxyInfo());
        ig.stopLoading();
        ui.removeCallbacks(watchdog);
        ui.postDelayed(watchdog, LOAD_LIMIT_MS);
        ui.postDelayed(() -> ig.loadUrl(IG), 300);
    }

    /** Sahifa belgilangan vaqtda ko'rinmadi (sekin yoki "osilgan" proksi) — boshqasiga o'tamiz. */
    void onLoadTooSlow() {
        if (committed || ig.getVisibility() != View.VISIBLE) return;
        if (mode().equals("auto") && autoRetries < 5) {
            autoRetries++;
            switchProxyAndReload();
            loaderTitle.setText("Proksi sekin — boshqasiga o'tilmoqda (" + autoRetries + "/5)");
            return;
        }
        toHomeWithErr("Instagram ochilmadi: proksilar juda sekin. Biroz kutib qayta urinib ko'ring yoki Wi-Fi/mobil internetni almashtiring.");
    }

    void toHomeWithErr(String msg) {
        ui.removeCallbacks(watchdog);
        hideLoader();
        topBar.setVisibility(View.GONE);
        igLoaded = false;
        ig.stopLoading();
        ig.setVisibility(View.GONE);
        home.setVisibility(View.VISIBLE);
        home.setAlpha(1f);
        home("onErr(" + JSONObject.quote(msg) + ")");
    }

    void installTheme() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        if (themeScript != null) themeScript.remove();
        themeScript = WebViewCompat.addDocumentStartJavaScript(ig, themeJs(), Collections.singleton("https://www.instagram.com"));
    }

    String themeCode;
    String themeJs() {
        if (themeCode == null) themeCode = asset("theme.js");
        JSONObject c = new JSONObject();
        try { c.put("theme", sp.getString("theme", "gold")); } catch (Exception ignored) { }
        return themeCode.replace("__CFG__", c.toString());
    }

    String asset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return b.toString("UTF-8");
        } catch (Exception e) { return ""; }
    }

    // ---------------- umumiy ----------------
    void home(final String js) { ui.post(() -> home.evaluateJavascript(js, null)); }

    void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == PICK && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        if (loader.getVisibility() == View.VISIBLE) {
            ui.removeCallbacks(watchdog);
            hideLoader();
            igLoaded = false;
            ig.stopLoading();
            showHome();
            return;
        }
        if (ig.getVisibility() == View.VISIBLE && home.getVisibility() != View.VISIBLE) {
            if (ig.canGoBack()) ig.goBack();
            else showHome();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (tor != null) tor.stop();
        if (px != null) px.stop();
        super.onDestroy();
    }

    @Override
    protected void onPause() { super.onPause(); CookieManager.getInstance().flush(); }
}
