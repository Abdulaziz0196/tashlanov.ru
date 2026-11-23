# Lenta — Android ilova manba kodi

instagram.com saytini ichiga o'rnatilgan Tor (snowflake, webtunnel, obfs4 ko'priklari) orqali ochuvchi WebView ilova.

## Yig'ish

1. Android SDK (platform 34, build-tools 34) va JDK 17+ o'rnating, `local.properties` ga `sdk.dir=...` yozing.
2. Kutubxonalarni `app/libs/` ga yuklab qo'ying (Maven Central):
   - `info/guardianproject/tor-android/0.4.8.21/tor-android-0.4.8.21.aar`
   - `com/netzarchitekten/IPtProxy/5.9.0/IPtProxy-5.9.0.aar` → `app/libs/IPtProxy-5.9.0.aar`
3. Imzo kaliti `lenta.keystore` ni loyiha ildiziga qo'ying, parolini `LENTA_KS_PASS` muhit o'zgaruvchisiga yozing (kalit repoga yuklanmaydi — yangilanishlar shu kalit bilan imzolanishi shart).
4. `gradle assembleRelease`

Ko'priklar ro'yxati: `app/src/main/assets/bridges.txt` (Tor loyihasining Rossiya uchun tavsiyasi, bridges.torproject.org/moat).
