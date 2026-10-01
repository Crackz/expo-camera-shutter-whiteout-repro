# expo-camera Android: shutter animation can leave the whole window white

Minimal reproduction for an `expo-camera` Android bug. When `animateShutter` is `true` (the default) and the `CameraView` is unmounted shortly after `takePictureAsync()`, the Activity window can stay covered by a solid white layer. The app underneath keeps running: the view tree, accessibility tree and touch handling are intact, only the pixels are white. The next capture's shutter flash on an attached `CameraView` clears it.

- expo-camera: 57.0.6 (Expo SDK 57). The same code is in 58.0.6.
- Platform: Android only.

## Root cause

`android/src/main/java/expo/modules/camera/ExpoCameraView.kt`, `takePicture()` > `ImageCapture.OnImageCapturedCallback.onCaptureStarted()` (lines 289-303 in 57.0.6, 294-308 in 58.0.6):

```kotlin
rootView.postDelayed({
  rootView.foreground = Color.WHITE.toDrawable()   // +100 ms
  rootView.postDelayed(
    { rootView.foreground = null },                 // +150 ms
    ANIMATION_FAST_MILLIS
  )
}, ANIMATION_SLOW_MILLIS)
```

`rootView` (`View.getRootView()`) is evaluated again inside each runnable. While the camera view is attached it is the Activity's DecorView, so the white foreground is set on the DecorView. If the camera view is detached from the window between the set (+100 ms after `onCaptureStarted`) and the clear (+150 ms), `getRootView()` in the clear runnable returns the root of the detached subtree instead. The clear is applied to that detached view, and the DecorView keeps its white foreground.

The common way to hit this window is navigating away right after a capture (for example `takePictureAsync()` then `router.push()` to a review screen), because the camera screen unmounts a few hundred milliseconds after the tap, which is when `onCaptureStarted` fires on many devices.

## Suggested fix

Capture the target once and use the same reference for set and clear, for example:

```kotlin
override fun onCaptureStarted() {
  ...
  if (!animateShutter) return
  val target = rootView
  target.postDelayed({
    target.foreground = Color.WHITE.toDrawable()
    target.postDelayed({ target.foreground = null }, ANIMATION_FAST_MILLIS)
  }, ANIMATION_SLOW_MILLIS)
}
```

Alternatively (or additionally), clear any pending shutter foreground in `onDetachedFromWindow()`, or draw the flash on an overlay owned by the camera view instead of the window's DecorView.

## Workaround

Pass `animateShutter={false}` to `CameraView`.

## What the app does

One screen with a back-camera `CameraView` and a control panel:

- `animateShutter` switch (the control: with it OFF the bug never shows).
- `delay`: how long after calling `takePictureAsync()` (not awaited) the `CameraView` is unmounted. Unmounting swaps it for a dark "RESULT" screen, so a white window is unambiguous.
- `Capture`: one trial with the chosen delay.
- `Auto sweep`: runs trials from 0 ms to the sweep maximum (default 600 ms) in 25 ms steps. Each trial remounts the camera, waits for `onCameraReady`, captures, unmounts after the delay and shows the RESULT screen for 6 s. The trial number and delay are shown on screen and logged to logcat (`[repro] ...`, tag `ReactNativeJS`).

The time between the capture call and `onCaptureStarted` depends on the device, so the delay that hits the 50 ms window differs per device. Use the sweep to find it.

## Steps to reproduce

Use a physical Android device. On an emulator `takePictureAsync()` never reaches the code above (see "Reproducing on an emulator" below).

```bash
npm install
npx expo prebuild -p android
cd android && ./gradlew assembleRelease   # or: npx expo run:android --variant release
adb install -r app/build/outputs/apk/release/app-release.apk
```

1. Open the app and grant the camera permission.
2. Leave `animateShutter` ON and tap `Auto sweep` (or pick a delay and tap `Capture` a few times).
3. Watch the RESULT screens.

Expected: every RESULT screen is dark.

Actual: for delays inside the device's window, the RESULT screen is solid white (exact `#FFFFFF`, status bar area included) while the screen is still mounted (a `uiautomator dump` still lists its text). The white stays until a later capture runs its shutter flash with the camera still attached.

4. Turn `animateShutter` OFF and repeat: every RESULT screen stays dark.

## Automated sweep

`tools/sweep.py` drives the in-app sweep over adb and classifies every trial from `screencap` pixels plus a `uiautomator dump` (requires Python 3, numpy and Pillow):

```bash
python3 tools/sweep.py --serial <adb serial> --animate on  --out on.json
python3 tools/sweep.py --serial <adb serial> --animate off --out off.json
```

A trial counts as white when two RESULT screenshots (0.8 s and 2.5 s after the unmount) are at least 97% exact `#FFFFFF` pixels while the dump still shows that trial's RESULT text. A screenshot of the camera screen before each capture flags a white carried over from the previous trial (`pre_white`), so it is not counted twice.

## Reproducing on an emulator

On an emulator, `CameraViewModule.kt` (line 438 in 57.0.6, 492 in 58.0.6) skips the real capture and returns a generated image:

```kotlin
if (!EmulatorUtilities.isRunningOnEmulator()) {
  view.takePicture(options, promise, cacheDirectory, runtimeContext)
} else {
  val image = CameraViewHelper.generateSimulatorPhoto(view.width, view.height)
  ...
```

So `onCaptureStarted` never runs and the bug cannot show with the stock module. To exercise the real CameraX path on an emulator (the stock arm64 `Pixel 7 / API 34` AVD's emulated back camera works):

1. Build expo-camera from source (it ships prebuilt): add `"expo": { "autolinking": { "android": { "buildFromSource": ["expo-camera"] } } }` to `package.json`.
2. In `node_modules/expo-camera/android/src/main/java/expo/modules/camera/CameraViewModule.kt`, change that condition to `if (true || !EmulatorUtilities.isRunningOnEmulator())`.
3. Rebuild the release APK and run the sweep.

## Results on an emulator

Pixel 7 AVD, Android 14 (API 34, arm64), release build, sweep 0 to 600 ms in 25 ms steps, expo-camera 57.0.6:

| Build | animateShutter | White RESULT screens | Delays that went white |
|---|---|---|---|
| stock module | ON | 0/25 | none (emulator returns a generated image, see above) |
| real capture path | ON | 4/72 (3 sweeps) | 350 ms and 375 ms, in every sweep that measured them |
| real capture path | OFF | 0/49 (2 sweeps) | none |
| real capture path + suggested fix | ON | 0/25 | none |

Native timeline of a white trial (log lines added around the shutter code, times relative to the `takePictureAsync()` call):

```
+256 ms  onCaptureStarted   rootView = DecorView (attached)
+358 ms  set   foreground   rootView = DecorView (attached)
+370 ms  CameraView unmounted
+420 ms  clear foreground   rootView = ExpoCameraView (detached)  <- the DecorView stays white
```

With the suggested fix the same trial clears the DecorView at +420 ms and the RESULT screen stays dark.
