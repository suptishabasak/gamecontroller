# Mobile app added

A React Native/Expo Android app now lives in `mobile-app/`. The correct repository-root GitHub Actions workflow is `.github/workflows/build-android-apk.yml`. It generates the Android project and compiles a debug APK.

Important: the workflow has been authored but cannot be run from this local ZIP. Push the ZIP contents to GitHub and check the Actions run; if the Android/Gradle build fails, share the failing log section to diagnose the specific error.
