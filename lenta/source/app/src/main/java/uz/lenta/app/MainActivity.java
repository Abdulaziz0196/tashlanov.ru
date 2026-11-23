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
        if (reload) { ig.loadUrl(IG); igLoaded = true; }
        else ig.evaluateJavascript(themeJs(), null);
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
            public void onPageFinished(WebView v, String url) {
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
                    home("onPxSwitch(" + JSONObject.quote(px.current()) + ")");
                    ui.postDelayed(v::reload, 400);
                    return;
                }
                toHomeWithErr("Ulanib bo'lmadi: " + e.getDescription());
            }
        });

        ig.setWebChromeClient(new WebChromeClient() {
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

    void toHomeWithErr(String msg) {
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
