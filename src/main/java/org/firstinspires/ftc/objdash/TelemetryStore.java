package org.firstinspires.ftc.objdash;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Holds the current telemetry values and a ring buffer of numeric samples for the current run.
 *
 * A "run" starts each time an OpMode is initialized. The browser polls with the run id and the
 * last sequence number it has seen, and gets back only the samples it is missing.
 */
final class TelemetryStore {
    static final TelemetryStore INSTANCE = new TelemetryStore();

    /** Max samples kept on the robot. The browser keeps the full history for the run. */
    private static final int CAPACITY = 200_000;

    private final double[] sampleTime = new double[CAPACITY];
    private final int[] sampleKey = new int[CAPACITY];
    private final double[] sampleValue = new double[CAPACITY];
    /** Total samples recorded this run. The slot for sample n is n % CAPACITY. */
    private long seq = 0;

    private final List<String> keys = new ArrayList<>();
    private final Map<String, Integer> keyIndex = new HashMap<>();
    private final LinkedHashMap<String, String> values = new LinkedHashMap<>();
    /** Graph colors set from code with ObjDash.put(key, value, color). */
    private final Map<String, String> colors = new HashMap<>();
    /** Letters, digits, '#', and the punctuation used in rgb()/hsl(); keeps junk out of the page. */
    private static final java.util.regex.Pattern COLOR = java.util.regex.Pattern.compile("[#A-Za-z0-9(),.% ]{1,40}");

    private String runId = "idle";
    private String opMode = "";
    private String state = "idle";
    private long startWallMillis = System.currentTimeMillis();
    private long startNanos = System.nanoTime();
    /** Seconds from INIT to START, or NaN until START is pressed. */
    private double startOffset = Double.NaN;

    private TelemetryStore() {}

    synchronized void startRun(String opModeName) {
        seq = 0;
        keys.clear();
        keyIndex.clear();
        values.clear();
        colors.clear();
        startWallMillis = System.currentTimeMillis();
        startNanos = System.nanoTime();
        startOffset = Double.NaN;
        runId = Long.toString(startWallMillis);
        opMode = opModeName == null ? "" : opModeName;
        state = "init";
    }

    synchronized void setState(String newState) {
        state = newState;
    }

    synchronized String state() {
        return state;
    }

    /** Called when START is pressed. Graph time 0 is this moment; INIT samples get negative times. */
    synchronized void markStarted() {
        startOffset = (System.nanoTime() - startNanos) / 1e9;
        state = "running";
    }

    synchronized void setColor(String key, String color) {
        if (key == null) return;
        if (color == null || color.trim().isEmpty()) {
            colors.remove(key);
        } else if (COLOR.matcher(color.trim()).matches()) {
            colors.put(key, color.trim());
        }
    }

    synchronized void remove(String key) {
        values.remove(key);
    }

    synchronized void put(String key, Object value) {
        if (key == null) return;
        values.put(key, String.valueOf(value));

        double d;
        if (value instanceof Number) {
            d = ((Number) value).doubleValue();
        } else if (value instanceof Boolean) {
            d = ((Boolean) value) ? 1 : 0;
        } else {
            return;
        }
        if (Double.isNaN(d) || Double.isInfinite(d)) return;

        Integer idx = keyIndex.get(key);
        if (idx == null) {
            idx = keys.size();
            keys.add(key);
            keyIndex.put(key, idx);
        }
        int slot = (int) (seq % CAPACITY);
        sampleTime[slot] = (System.nanoTime() - startNanos) / 1e9;
        sampleKey[slot] = idx;
        sampleValue[slot] = d;
        seq++;
    }

    /**
     * @param clientRun the run id the browser has data for (samples restart at 0 if it differs)
     * @param since     the number of samples the browser already has for that run
     * @param max       the most samples to return in one response
     */
    synchronized String toJson(String clientRun, long since, int max) {
        if (!runId.equals(clientRun) || since < 0 || since > seq) since = 0;
        long oldest = Math.max(0, seq - CAPACITY);
        boolean gap = since < oldest;
        long start = Math.max(since, oldest);
        long end = Math.min(seq, start + max);

        StringBuilder b = new StringBuilder(64 + (int) (end - start) * 24);
        b.append("{\"run\":").append(Json.quote(runId));
        b.append(",\"opMode\":").append(Json.quote(opMode));
        b.append(",\"state\":").append(Json.quote(state));
        b.append(",\"startedAt\":").append(startWallMillis);
        b.append(",\"startOffset\":").append(Json.number(startOffset));
        b.append(",\"from\":").append(start);
        b.append(",\"seq\":").append(end);
        b.append(",\"more\":").append(end < seq);
        b.append(",\"gap\":").append(gap);
        b.append(",\"keys\":[");
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) b.append(',');
            b.append(Json.quote(keys.get(i)));
        }
        b.append("],\"values\":{");
        boolean first = true;
        for (Map.Entry<String, String> e : values.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append(Json.quote(e.getKey())).append(':').append(Json.quote(e.getValue()));
        }
        b.append("},\"colors\":{");
        first = true;
        for (Map.Entry<String, String> e : colors.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append(Json.quote(e.getKey())).append(':').append(Json.quote(e.getValue()));
        }
        b.append("},\"samples\":[");
        for (long n = start; n < end; n++) {
            int slot = (int) (n % CAPACITY);
            if (n > start) b.append(',');
            b.append('[').append(Json.number(Math.round(sampleTime[slot] * 10000) / 10000.0))
             .append(',').append(sampleKey[slot])
             .append(',').append(Json.number(sampleValue[slot])).append(']');
        }
        b.append("]}");
        return b.toString();
    }
}
