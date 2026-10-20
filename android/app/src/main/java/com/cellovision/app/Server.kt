package com.cellovision.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Which Cellovision server this device watches from, and talking to it with the app's sign-in. */
class Server(private val context: Context) {
    private val prefs = context.getSharedPreferences("server", Context.MODE_PRIVATE)

    var url: String
        get() = prefs.getString("url", "") ?: ""
        set(v) = prefs.edit().putString("url", v).apply()

    /** A request to the server, signed in as the app's pages are (their cookie). */
    fun call(method: String, path: String, body: String? = null): JSONObject {
        val conn = URL(url.trimEnd('/') + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 8000
        conn.readTimeout = 30000
        conn.setRequestProperty("content-type", "application/json")
        conn.setRequestProperty("x-cellovision", "1")
        cookie()?.let { conn.setRequestProperty("cookie", it) }
        if (body != null) { conn.doOutput = true; conn.outputStream.use { it.write(body.toByteArray()) } }
        val code = conn.responseCode
        val text = (if (code < 400) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: "{}"
        val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        if (code >= 400) throw Exception(json.optString("error", "Error $code"))
        return json
    }

    fun cookie(): String? = CookieManager.getInstance().getCookie(url)

    companion object {
        const val PORT = 8420

        /** Is there a Cellovision server at this address? Its name, or null. */
        fun hello(base: String, timeoutMs: Int = 1500): String? = runCatching {
            val c = URL(base.trimEnd('/') + "/api/hello").openConnection() as HttpURLConnection
            c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
            if (c.responseCode != 200) return null
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            if (j.has("setUp") && j.has("profiles")) j.optString("name", "Cellovision") else null
        }.getOrNull()

        /** Every server answering on this device's Wi-Fi (asks all 254 addresses at once). */
        fun find(context: Context): List<Pair<String, String>> {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val lp: LinkProperties = cm.getLinkProperties(cm.activeNetwork) ?: return emptyList()
            val mine = lp.linkAddresses.map { it.address }.filterIsInstance<Inet4Address>().firstOrNull() ?: return emptyList()
            val prefix = mine.hostAddress!!.substringBeforeLast('.')
            val pool = Executors.newFixedThreadPool(64)
            val found = java.util.Collections.synchronizedList(mutableListOf<Pair<String, String>>())
            for (i in 1..254) pool.execute {
                val base = "http://$prefix.$i:$PORT"
                hello(base, 1200)?.let { found += base to it }
            }
            pool.shutdown()
            pool.awaitTermination(15, TimeUnit.SECONDS)
            return found.sortedBy { it.first }
        }
    }
}
