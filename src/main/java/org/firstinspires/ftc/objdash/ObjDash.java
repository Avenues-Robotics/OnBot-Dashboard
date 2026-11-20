package org.firstinspires.ftc.objdash;

/**
 * Public API for sending values to the OBJ Dashboard.
 *
 * <pre>
 * import org.firstinspires.ftc.objdash.ObjDash;
 *
 * ObjDash.put("armPos", arm.getCurrentPosition());
 * ObjDash.put("state", "SCORING");
 * </pre>
 *
 * Every value shows up in the dashboard's telemetry table. Numbers (and booleans, as 0/1) are also
 * recorded with a timestamp so they can be graphed. Calls are cheap and thread-safe, so it's fine to
 * call this every loop.
 */
public final class ObjDash {
    private ObjDash() {}

    /** Shows {@code value} under {@code key}. Numeric values are also recorded for graphing. */
    public static void put(String key, Object value) {
        TelemetryStore.INSTANCE.put(key, value);
    }

    /**
     * Like {@link #put(String, Object)}, and also sets the graph line color for {@code key}.
     *
     * <pre>
     * ObjDash.put("flywheel/target", target, "red");
     * ObjDash.put("flywheel/velocity", velocity, "#2563eb");
     * </pre>
     *
     * Use a CSS color name ("red", "orange", "teal", ...) or hex code ("#ff8800"). Pass null to
     * go back to an automatic color. Values without a color get one that doesn't clash with
     * the others on the graph.
     */
    public static void put(String key, Object value, String color) {
        TelemetryStore.INSTANCE.setColor(key, color);
        TelemetryStore.INSTANCE.put(key, value);
    }

    /** Removes a key from the dashboard's telemetry table (recorded graph samples are kept). */
    public static void remove(String key) {
        TelemetryStore.INSTANCE.remove(key);
    }
}
