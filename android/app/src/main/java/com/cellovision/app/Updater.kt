package com.cellovision.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Automatic updates, from the owner's signed release list on cellosig.com (release.json, signed on the
 * owner's PC: cellocloud/server/tools/sign-release.mjs). An update is installed only if the list's
 * signature checks out with the key built in here AND the download matches its fingerprint (and Android
 * only accepts an APK signed with this app's own key). Never while you're watching: it waits until the
 * app leaves the screen. The first time, Android asks you to tap Update.
 */
object Updater {
    // The same public key as cellosig.com's service worker and every other app's updater.
    private const val RELEASE_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEP9FLBRIG9RyIl+JFTBhVlyFz3QPoIvpVhU1iDmnfudQa+FhQ/9xj5F3741yOZUbZggvrxO7hrBkE+UPJUhrhAQ=="
    private const val SITE = "https://cellosig.com"
    private const val NAME = "cellovisionAndroid"

    data class Release(val versionCode: Int, val versionName: String, val size: Long, val sha256: String, val path: String)

    @Volatile private var ready: File? = null
    @Volatile var status: String = ""

    fun enabled(ctx: Context) = ctx.getSharedPreferences("updates", Context.MODE_PRIVATE).getBoolean("auto", true)
    fun setEnabled(ctx: Context, on: Boolean) = ctx.getSharedPreferences("updates", Context.MODE_PRIVATE).edit().putBoolean("auto", on).apply()
    private fun versionCode(ctx: Context): Long = ctx.packageManager.getPackageInfo(ctx.packageName, 0).let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else @Suppress("DEPRECATION") it.versionCode.toLong() }

    /** This app's entry in a signed release list, or null; throws if the signature is wrong. */
    fun release(text: String): Release? {
        val outer = JSONObject(text)
        val payload = outer.getString("payload")
        val sig = Base64.decode(outer.getString("sig"), Base64.DEFAULT)
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(RELEASE_KEY, Base64.DEFAULT)))
        val ok = sig.size == 64 && Signature.getInstance("SHA256withECDSA").run { initVerify(key); update(payload.toByteArray(Charsets.UTF_8)); verify(derOf(sig)) }
        if (!ok) throw SecurityException("the release list isn't signed with the release key")
        val a = JSONObject(payload).optJSONObject("apps")?.optJSONObject(NAME) ?: return null
        val r = Release(a.optInt("versionCode"), a.optString("versionName"), a.optLong("size"), a.optString("sha256"), a.optString("path"))
        if (r.versionCode <= 0 || r.size <= 0 || !Regex("^[0-9a-f]{64}$").matches(r.sha256) || !Regex("^/download/[\\w.-]+\\.apk$").matches(r.path)) return null
        return r
    }

    /** The signature as it's signed (raw r‖s, 64 bytes) in the form Java checks (DER). */
    private fun derOf(raw: ByteArray): ByteArray {
        fun int(b: ByteArray): ByteArray { val v = BigInteger(1, b).toByteArray(); return byteArrayOf(0x02, v.size.toByte()) + v }
        val body = int(raw.copyOfRange(0, 32)) + int(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun open(url: String): HttpURLConnection = (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 20_000; readTimeout = 120_000; setRequestProperty("cache-control", "no-cache") }

    /**
     * Checks now. auto = the background check: the APK is kept and installed when the app leaves the
     * screen (installReady). Returns what happened, for the menu.
     */
    fun check(ctx: Context, auto: Boolean): String {
        val text = open("$SITE/release.json").run { if (responseCode != 200) throw IOException("release list: HTTP $responseCode"); inputStream.bufferedReader().use { it.readText() } }
        val r = release(text)?.takeIf { it.versionCode > versionCode(ctx) }
            ?: return "Cellovision ${ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName} is the newest version.".also { status = it }
        val apk = download(ctx, r)
        if (auto) { ready = apk; status = "Cellovision ${r.versionName} is ready: it installs when you leave the app."; return status }
        install(ctx, apk)
        status = "Updating to Cellovision ${r.versionName}…"
        return status
    }

    private fun download(ctx: Context, r: Release): File {
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val file = File(dir, "Cellovision-${r.versionCode}.apk")
        try {
            val c = open("$SITE${r.path}?v=${r.sha256.take(16)}")
            if (c.responseCode != 200) throw IOException("download: HTTP ${c.responseCode}")
            val md = MessageDigest.getInstance("SHA-256")
            var got = 0L
            c.inputStream.use { input -> file.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) { val n = input.read(buf); if (n < 0) break; got += n; if (got > r.size) throw SecurityException("the download is bigger than the signed version"); md.update(buf, 0, n); out.write(buf, 0, n) }
            } }
            if (got != r.size || md.digest().joinToString("") { "%02x".format(it) } != r.sha256) throw SecurityException("the download doesn't match the signed version")
            return file
        } catch (e: Exception) { file.delete(); throw e }
    }

    // How many of the app's screens are showing (the main one and the player). Opening the player hides the
    // main screen for a moment: the update waits until neither is showing.
    private var showing = 0
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    fun screenShown() { showing++ }
    fun screenHidden(ctx: Context) {
        showing = (showing - 1).coerceAtLeast(0)
        val app = ctx.applicationContext
        main.postDelayed({ if (showing == 0) installReady(app) }, 3000)
    }

    /** The app left the screen: put in the update that was waiting. */
    fun installReady(ctx: Context) { val f = ready ?: return; ready = null; if (f.exists()) runCatching { install(ctx, f) } }

    private fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName); setSize(apk.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("Cellovision.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val done = PendingIntent.getBroadcast(ctx, id, Intent(ctx, UpdateReceiver::class.java).setPackage(ctx.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            s.commit(done.intentSender)
        }
    }
}

/** Android's answer: done, or (the first time) it needs you to tap Update. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { ctx.startActivity(confirm) }
        }
    }
}
