package org.firstinspires.ftc.objdash;

import com.qualcomm.robotcore.eventloop.opmode.OpModeManagerImpl;

import org.firstinspires.ftc.robotcore.internal.network.NetworkConnectionHandler;
import org.firstinspires.ftc.robotcore.internal.opmode.OpModeMeta;
import org.firstinspires.ftc.robotcore.internal.opmode.RegisteredOpModes;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Lists OpModes and drives INIT / START / STOP from the dashboard.
 *
 * These use the same OpModeManagerImpl calls as the Driver Station's buttons. The calls only queue
 * a state change that the robot's event loop thread carries out, and the SDK tells the Driver
 * Station about it, so the Driver Station screen stays in sync.
 */
final class OpModeControl {
    private OpModeControl() {}

    /** Thrown for requests that can't be carried out right now; the message is shown to the user. */
    static final class RefusedException extends Exception {
        RefusedException(String message) {
            super(message);
        }
    }

    private static volatile OpModeManagerImpl manager;

    static void setManager(OpModeManagerImpl m) {
        manager = m;
    }

    private static OpModeManagerImpl requireManager() throws RefusedException {
        OpModeManagerImpl m = manager;
        if (m == null) throw new RefusedException("The robot isn't ready yet. Wait for the Robot Controller to finish starting.");
        return m;
    }

    private static boolean driverStationConnected() {
        try {
            return NetworkConnectionHandler.getInstance().isPeerConnected();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static String activeName(OpModeManagerImpl m) {
        String name = m.getActiveOpModeName();
        return name == null || OpModeManagerImpl.DEFAULT_OP_MODE_NAME.equals(name) ? "" : name;
    }

    static String listJson() {
        List<OpModeMeta> metas = new ArrayList<>(RegisteredOpModes.getInstance().getOpModes());
        Collections.sort(metas, new Comparator<OpModeMeta>() {
            @Override
            public int compare(OpModeMeta a, OpModeMeta b) {
                int c = a.flavor.compareTo(b.flavor);
                if (c != 0) return c;
                c = String.valueOf(a.group).compareToIgnoreCase(String.valueOf(b.group));
                if (c != 0) return c;
                return a.name.compareToIgnoreCase(b.name);
            }
        });

        OpModeManagerImpl m = manager;
        StringBuilder b = new StringBuilder("{\"active\":").append(Json.quote(m == null ? "" : activeName(m)));
        b.append(",\"driverStation\":").append(driverStationConnected());
        b.append(",\"opModes\":[");
        boolean first = true;
        for (OpModeMeta meta : metas) {
            if (meta.flavor == OpModeMeta.Flavor.SYSTEM || OpModeMeta.isSystemName(meta.name)) continue;
            if (!first) b.append(',');
            first = false;
            b.append("{\"name\":").append(Json.quote(meta.name))
             .append(",\"group\":").append(Json.quote(OpModeMeta.DefaultGroup.equals(meta.group) ? "" : meta.group))
             .append(",\"flavor\":").append(Json.quote(meta.flavor.name()))
             .append('}');
        }
        return b.append("]}").toString();
    }

    static void init(String name) throws RefusedException {
        OpModeManagerImpl m = requireManager();
        if (name == null || name.isEmpty() || OpModeMeta.isSystemName(name)
                || RegisteredOpModes.getInstance().getOpModeMetadata(name) == null) {
            throw new RefusedException("There's no OpMode named \"" + name + "\". Refresh the list.");
        }
        String active = activeName(m);
        if (!active.isEmpty()) throw new RefusedException("Stop " + active + " first.");
        m.initOpMode(name);
    }

    static void start() throws RefusedException {
        OpModeManagerImpl m = requireManager();
        if (activeName(m).isEmpty()) throw new RefusedException("INIT an OpMode first.");
        if (!"init".equals(TelemetryStore.INSTANCE.state())) throw new RefusedException("This OpMode is already running.");
        m.startActiveOpMode();
    }

    static void stop() throws RefusedException {
        OpModeManagerImpl m = requireManager();
        if (activeName(m).isEmpty()) return;
        // Same as the Driver Station's STOP: switch to the SDK's built-in stop OpMode. This runs the
        // OpMode's stop on the event loop thread, unlike stopActiveOpMode() which would run it here.
        m.initOpMode(OpModeManagerImpl.DEFAULT_OP_MODE_NAME);
    }
}
