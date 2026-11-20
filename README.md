# OBJ Dashboard

An Android library (`.aar`) for the FTC Robot Controller that you install with **OnBot Java → Upload Files**.

Open it at **`http://192.168.43.1:8080/objdash`** while connected to the robot's Wi-Fi.

## Features

- **Run OpModes.** Pick an OpMode in the top bar and use Init / Start / Stop. These are the same actions as the Driver Station's buttons, and the Driver Station screen stays in sync. A Driver Station is not required. Without one, the dashboard's Stop button is the only way to stop the robot. **Press SPACE anywhere on the page to stop** (except while typing in a text box).
- **Live telemetry.** Values sent from OpModes show up in a table, updated about 10 times a second.
- **Graphing.** Check any number in the table to plot it against time (1s / 2s / 5s / 10s / 30s / 60s / All window, drag across the graph to zoom and double-click to reset, Pause, hover readout). Every `ObjDash.put` call is a graph point with its own timestamp, so detail is limited by your loop speed, not the 100 ms screen refresh.
- **Statistics and regression.** Drag across the graph, then choose **Zoom**, **Statistics** or **Regression** (Esc cancels). Statistics gives Δt and, for each graphed value, range (min … max), mean and standard deviation (sample, n − 1). Regression fits y = m·x + b with x = time in seconds (the graph's time axis) and gives m, b and R², and draws the line on the graph. Results stack in a sidebar right of the graph. Hover a result to highlight its span, × removes it. They're kept across a page refresh, cleared when a new run starts, and included in Export PNG.
- **Pick graph lines before START.** When you select an OpMode, the robot reads its OnBot Java source, and every OnBot Java class it uses, for `ObjDash.put("name", ...)`. Those names appear in the table in grey with "–" and can be checked right away. Names built in code (like `"motor" + i`) can't be found that way, so the page also remembers every name each OpMode has sent before. Checked lines stay checked through stop, INIT and START.
- **Kept across refresh.** The current run is stored in the browser, so a page refresh or reconnect doesn't lose it.
- **Save to robot.** Saves the run to `/sdcard/FIRST/objdash/<folder>/<name>.json`. The defaults are a folder named after the OpMode and a name like `11-13-2026-001`, numbered automatically. **Open…** reopens saved runs.
- **Export PNG.** Downloads the current graph as a 3200×1800 PNG with title and legend.

A new run starts each time an OpMode is initialized.

## Using it from an OpMode

```java
import org.firstinspires.ftc.objdash.ObjDash;

ObjDash.put("arm/position", arm.getCurrentPosition());
ObjDash.put("arm/target", target);
ObjDash.put("state", state);   // text shows in the table; numbers and booleans can be graphed
ObjDash.put("flywheel/target", target, "red");   // optional graph color: CSS name or "#rrggbb"
```

Values without a color get one automatically, and no two lines on the graph share a color. A color set in code always wins.

## Live-tunable variables (`@ObjConfig`)

```java
import org.firstinspires.ftc.objdash.ObjConfig;

@ObjConfig                   // or @ObjConfig("Arm Tuning") to set the name shown
public class ArmConstants {
    public static double kP = 0.01;
    public static int target = 500;
    public static boolean useFeedforward = true;
    public static PIDFCoefficients pid = new PIDFCoefficients(10, 0, 1, 0);  // shown as p / i / d / f
}
```

Every `public static` field appears in the dashboard's Config panel and can be edited while an OpMode runs. Your code sees the new value the next time it reads the field. Supported: `boolean`, `int`, `long`, `short`, `byte`, `float`, `double` (and boxed forms), `String`, enums, and objects whose public fields are those types (up to 3 levels). `final` fields are shown read-only. Edits aren't written back into your code: they reset when the robot restarts or OnBot Java rebuilds. ↺ resets a field to the value it had when the dashboard first saw it.

The Config panel shows only the `@ObjConfig` classes the selected OpMode uses: its own class plus any OnBot Java class it uses, found by the same source scan. If no OpMode is selected, or its source can't be read, every `@ObjConfig` class is shown.

Read a config value each loop (for example `arm.setPower(kP * error)`), not once in `init`, so changes take effect right away.

## Code layout

| Path | What |
|---|---|
| `src/main/java/.../ObjDashboard.java` | SDK hooks: web routes, OpMode start/stop tracking |
| `src/main/java/.../ObjDash.java` | Public API for OpModes |
| `src/main/java/.../TelemetryStore.java` | Current values and sample buffer for the current run |
| `src/main/java/.../RunFiles.java` | Saving, listing and loading runs on the robot |
| `src/main/java/.../ObjConfig.java` | The `@ObjConfig` annotation |
| `src/main/java/.../ConfigRegistry.java` | Finding `@ObjConfig` classes, reading and setting their fields |
| `src/main/java/.../OpModeControl.java` | OpMode list and INIT / START / STOP |
| `src/main/java/.../OpModeKeyScanner.java` | Reads an OpMode's OnBot Java source (and the classes it uses) for telemetry names |
| `src/main/web/` | The web page (HTML/CSS/JS). Edit these normally |

The web files are turned into a generated `WebAssets` Java class at build time (the `generateWebAssets` task in `build.gradle`), because OnBot Java rejects `.aar` files that contain assets.

**After uploading a new `.aar`, power-cycle the Control Hub.** The web page is registered only when the Robot Controller app starts, so "Restart Robot" isn't enough.

## Build

```sh
./gradlew assembleRelease
```

Output: `build/outputs/aar/ObjDashboard-release.aar`

Requirements: JDK 17+ and the Android SDK with platform `android-30`. Set the SDK location with `sdk.dir` in `local.properties` (not committed) or with `ANDROID_HOME`.

## Constraints (don't break these)

| Setting | Value | Why |
|---|---|---|
| FTC SDK | `12.0.0` (`ftcSdkVersion` in `build.gradle`) | Must match the Robot Controller app on the robot |
| Dependencies | `compileOnly` | The SDK is already on the robot. Don't bundle it into the `.aar` |
| Java | source/target 1.8 | OnBot Java only supports Java 8 |
| compileSdk / minSdk | 30 / 24 | Same values as FtcRobotController v12.0 |
| Resources/assets | none (`androidResources = false`) | OnBot Java rejects `.aar` files that contain assets |

Upgrading the FTC SDK: change `ftcSdkVersion`, then check FtcRobotController's `build.gradle` (AGP version), `build.common.gradle` (compileSdk), and `gradle/wrapper/gradle-wrapper.properties` for that release and match them here.

## Install and test

1. On the Robot Controller web page (e.g. `http://192.168.43.1:8080`), open **OnBot Java**, click **Upload Files**, and pick the `.aar`.
2. Build in OnBot Java, then restart the robot.
3. Browse to `http://192.168.43.1:8080/objdash`.
4. Look for `OBJDash` in the robot log (Manage → View Logs).
