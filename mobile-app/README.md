# Android mobile app (React Native + Expo)

This is a real React Native Android app source project, added alongside the original Node.js game. It connects to the existing `/ws` server protocol, streams steering input, and sends jump events. It also includes touch controls.

## Build an APK with GitHub Actions (no USB needed)

1. Push the whole repository to GitHub. The workflow at `.github/workflows/build-android-apk.yml` runs on push and can also be started manually.
2. In GitHub, open **Actions** → **Build Android APK** → the latest run.
3. Download the `anything-but-a-game-controller-apk` artifact and extract the ZIP. The APK is `app-release.apk`.

## Build locally (optional)

Requires Node.js 20 and Java 17; Android SDK setup is also required.

```bash
cd mobile-app
npm install
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```

On Windows, run `gradlew.bat assembleRelease`. Output: `mobile-app/android/app/build/outputs/apk/release/app-release.apk`.

## Connect to the game

1. Start the game server on your laptop with `npm install` and **`npm run start:http`** in the repository root (plain HTTP – the native app can't trust a self-signed HTTPS certificate, and doesn't need HTTPS for sensors).
2. Open the laptop game at `http://localhost:3000` and start/create a room.
3. Find your laptop's local IPv4 address (Windows: run `ipconfig`; use the Wi-Fi adapter's IPv4 Address).
4. On the phone app, enter `LAPTOP_IP:3000` and the room code displayed by the laptop game, then tap Connect. Both devices must be on the same Wi-Fi.

### Notes

- This build uses `ws://` for local Wi-Fi. The Android app explicitly allows cleartext traffic for this local development server. Do not expose the unauthenticated local server directly to the public internet.
- Sensor values vary by phone; calibrate after connecting. The jump gesture is supplemented with a visible tap button.
- GitHub Actions builds the APK from the React Native source; this is not a screenshot or mockup. The build must finish successfully before an APK artifact is available.
