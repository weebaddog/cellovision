# The Cellovision app's pages call these from JavaScript.
-keepclassmembers class com.cellovision.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
