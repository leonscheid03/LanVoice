// Bewusst ohne AndroidX/Material: Die App ist nur eine dünne Hülle um die Weboberfläche des Servers
// (WebView) plus ein Vordergrunddienst. Das hält die APK klein und den Build einfach.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "de.lanvoice.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.lanvoice.app"
        minSdk = 29 // Android 10; nötig u. a. für Zertifikat-Zugriff und die WLAN-Sperre
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
    }
}
