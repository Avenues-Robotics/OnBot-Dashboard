package org.firstinspires.ftc.objdash;

import android.content.Context;

import com.qualcomm.ftccommon.FtcEventLoop;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.OpModeManagerImpl;
import com.qualcomm.robotcore.eventloop.opmode.OpModeManagerNotifier;
import com.qualcomm.robotcore.util.RobotLog;
import com.qualcomm.robotcore.util.WebHandlerManager;

import org.firstinspires.ftc.ftccommon.external.OnCreateEventLoop;
import org.firstinspires.ftc.ftccommon.external.WebHandlerRegistrar;
import org.firstinspires.ftc.robotcore.internal.webserver.WebHandler;

import java.io.FileNotFoundException;
import java.util.List;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoHTTPD.Response;
import fi.iki.elonen.NanoHTTPD.Response.Status;

/**
 * SDK hooks for the OBJ Dashboard.
 *
 * The SDK's AnnotatedHooksClassFilter scans for these annotations and invokes the methods
 * reflectively from FtcRobotControllerActivity. They must be public static with exactly these
 * parameter lists.
 *
 * Note: @WebHandlerRegistrar only runs when the Robot Controller app starts, so after uploading a
 * new .aar the Control Hub must be power-cycled (Restart Robot is not enough).
 */
public final class ObjDashboard {
    public static final String TAG = "OBJDash";
    public static final String PATH = "/objdash";

    private static final String JSON = "application/json; charset=utf-8";
    private static final long MAX_UPLOAD_BYTES = 64L * 1024 * 1024;
    private static final int MAX_SAMPLES_PER_POLL = 20000;

    private ObjDashboard() {}

    /**
     * The SDK holds OpMode listeners only through weak references, so we must keep strong ones
     * here or the garbage collector silently removes them.
     */
    private static OpModeManagerImpl listenedManager;
    private static OpModeManagerNotifier.Notifications listener;

    @OnCreateEventLoop
    public static synchronized void onCreateEventLoop(Context context, FtcEventLoop eventLoop) {
        final OpModeManagerImpl manager = eventLoop.getOpModeManager();
        if (listenedManager != null && listener != null) listenedManager.unregisterListener(listener);
        listener = new OpModeManagerNotifier.Notifications() {
            @Override
            public void onOpModePreInit(OpMode opMode) {
                String name = manager.getActiveOpModeName();
                // The SDK runs a built-in "stop robot" OpMode between real ones; ignore it so the
                // last run's data stays visible.
                if (OpModeManagerImpl.DEFAULT_OP_MODE_NAME.equals(name)) return;
                if (name == null || name.isEmpty()) name = opMode.getClass().getSimpleName();
                TelemetryStore.INSTANCE.startRun(name);
                RobotLog.ii(TAG, "Run started for OpMode %s", name);
            }

            @Override
            public void onOpModePreStart(OpMode opMode) {
                if (!OpModeManagerImpl.DEFAULT_OP_MODE_NAME.equals(manager.getActiveOpModeName())) {
                    TelemetryStore.INSTANCE.markStarted();
                }
            }

            @Override
            public void onOpModePostStop(OpMode opMode) {
                if (!OpModeManagerImpl.DEFAULT_OP_MODE_NAME.equals(manager.getActiveOpModeName())) {
                    TelemetryStore.INSTANCE.setState("stopped");
                }
            }
        };
        listenedManager = manager;
        manager.registerListener(listener);
        OpModeControl.setManager(manager);
        RobotLog.ii(TAG, "OBJ Dashboard: event loop created");
    }

    @WebHandlerRegistrar
    public static void registerWebHandlers(Context context, WebHandlerManager manager) {
        // The web server matches exact paths only, so every page and API route is registered.
        WebHandler assets = new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                String uri = session.getUri();
                String path = uri.equals(PATH) || uri.equals(PATH + "/") ? "index.html" : uri.substring(PATH.length() + 1);
                String body = WebAssets.content(path);
                if (body == null) return text(Status.NOT_FOUND, "Not found: " + uri);
                Response r = NanoHTTPD.newFixedLengthResponse(Status.OK, WebAssets.mime(path), body);
                r.addHeader("Cache-Control", "no-cache");
                return r;
            }
        };
        manager.register(PATH, assets);
        manager.register(PATH + "/", assets);
        for (String path : WebAssets.PATHS) manager.register(PATH + "/" + path, assets);

        manager.register(PATH + "/api/telemetry", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                Map<String, List<String>> p = session.getParameters();
                long since = parseLong(param(p, "since"), 0);
                return json(TelemetryStore.INSTANCE.toJson(param(p, "run"), since, MAX_SAMPLES_PER_POLL));
            }
        });

        manager.register(PATH + "/api/runs", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                return json(RunFiles.listJson());
            }
        });

        manager.register(PATH + "/api/nextname", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                Map<String, List<String>> p = session.getParameters();
                try {
                    return json("{\"name\":" + Json.quote(RunFiles.nextName(param(p, "folder"), param(p, "prefix"))) + "}");
                } catch (RunFiles.BadNameException e) {
                    return error(Status.BAD_REQUEST, e.getMessage());
                }
            }
        });

        manager.register(PATH + "/api/run", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                Map<String, List<String>> p = session.getParameters();
                try {
                    return json(RunFiles.load(param(p, "folder"), param(p, "name")));
                } catch (RunFiles.BadNameException e) {
                    return error(Status.BAD_REQUEST, e.getMessage());
                } catch (FileNotFoundException e) {
                    return error(Status.NOT_FOUND, "No saved run with that name");
                } catch (Exception e) {
                    RobotLog.ee(TAG, e, "Loading run failed");
                    return error(Status.INTERNAL_ERROR, "Couldn't read the saved run: " + e.getMessage());
                }
            }
        });

        manager.register(PATH + "/api/save", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                if (session.getMethod() != NanoHTTPD.Method.POST) return error(Status.METHOD_NOT_ALLOWED, "Use POST");
                Map<String, List<String>> p = session.getParameters();
                long length = parseLong(session.getHeaders().get("content-length"), -1);
                if (length < 0) return error(Status.BAD_REQUEST, "Missing Content-Length");
                if (length > MAX_UPLOAD_BYTES) return error(Status.BAD_REQUEST, "Run is too large to save");
                try {
                    String path = RunFiles.save(param(p, "folder"), param(p, "name"), session.getInputStream(),
                            length, "1".equals(param(p, "overwrite")));
                    RobotLog.ii(TAG, "Saved run to %s", path);
                    return json("{\"ok\":true,\"path\":" + Json.quote(path) + "}");
                } catch (RunFiles.BadNameException e) {
                    return error(Status.BAD_REQUEST, e.getMessage());
                } catch (RunFiles.ExistsException e) {
                    return error(Status.CONFLICT, e.getMessage());
                } catch (Exception e) {
                    RobotLog.ee(TAG, e, "Saving run failed");
                    return error(Status.INTERNAL_ERROR, "Couldn't save: " + e.getMessage());
                }
            }
        });

        ConfigRegistry.INSTANCE.registerFilter();

        manager.register(PATH + "/api/config", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                if ("1".equals(param(session.getParameters(), "rescan"))) ConfigRegistry.INSTANCE.requestRescan();
                return json(ConfigRegistry.INSTANCE.toJson());
            }
        });

        manager.register(PATH + "/api/config/set", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                if (session.getMethod() != NanoHTTPD.Method.POST) return error(Status.METHOD_NOT_ALLOWED, "Use POST");
                Map<String, List<String>> p = session.getParameters();
                try {
                    String value = ConfigRegistry.INSTANCE.set(param(p, "class"), param(p, "path"), param(p, "value"));
                    RobotLog.ii(TAG, "Config: %s.%s = %s", param(p, "class"), param(p, "path"), value);
                    return json("{\"ok\":true,\"value\":" + Json.quote(value) + "}");
                } catch (ConfigRegistry.BadValueException e) {
                    return error(Status.BAD_REQUEST, e.getMessage());
                } catch (Exception e) {
                    RobotLog.ee(TAG, e, "Config set failed");
                    return error(Status.INTERNAL_ERROR, "Failed: " + e.getMessage());
                }
            }
        });

        manager.register(PATH + "/api/opmode/keys", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                String name = param(session.getParameters(), "name");
                if (name == null || name.isEmpty()) return error(Status.BAD_REQUEST, "Missing OpMode name");
                return json(OpModeKeyScanner.scanJson(name));
            }
        });

        manager.register(PATH + "/api/opmodes", new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                return json(OpModeControl.listJson());
            }
        });

        manager.register(PATH + "/api/opmode/init", opModeAction(new OpModeAction() {
            @Override public void run(Map<String, List<String>> p) throws OpModeControl.RefusedException {
                OpModeControl.init(param(p, "name"));
            }
        }));
        manager.register(PATH + "/api/opmode/start", opModeAction(new OpModeAction() {
            @Override public void run(Map<String, List<String>> p) throws OpModeControl.RefusedException {
                OpModeControl.start();
            }
        }));
        manager.register(PATH + "/api/opmode/stop", opModeAction(new OpModeAction() {
            @Override public void run(Map<String, List<String>> p) throws OpModeControl.RefusedException {
                OpModeControl.stop();
            }
        }));

        RobotLog.ii(TAG, "OBJ Dashboard: registered web handler at %s", PATH);
    }

    private interface OpModeAction {
        void run(Map<String, List<String>> params) throws OpModeControl.RefusedException;
    }

    /** POST-only wrapper that reports refusals as {"error": ...}. */
    private static WebHandler opModeAction(final OpModeAction action) {
        return new WebHandler() {
            @Override
            public Response getResponse(NanoHTTPD.IHTTPSession session) {
                if (session.getMethod() != NanoHTTPD.Method.POST) return error(Status.METHOD_NOT_ALLOWED, "Use POST");
                try {
                    action.run(session.getParameters());
                    return json("{\"ok\":true}");
                } catch (OpModeControl.RefusedException e) {
                    return error(Status.CONFLICT, e.getMessage());
                } catch (Exception e) {
                    RobotLog.ee(TAG, e, "OpMode control failed");
                    return error(Status.INTERNAL_ERROR, "Failed: " + e.getMessage());
                }
            }
        };
    }

    private static String param(Map<String, List<String>> params, String name) {
        List<String> v = params.get(name);
        return v == null || v.isEmpty() ? null : v.get(0);
    }

    private static long parseLong(String s, long fallback) {
        if (s == null) return fallback;
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static Response json(String body) {
        Response r = NanoHTTPD.newFixedLengthResponse(Status.OK, JSON, body);
        r.addHeader("Cache-Control", "no-store");
        return r;
    }

    private static Response error(Status status, String message) {
        return NanoHTTPD.newFixedLengthResponse(status, JSON, "{\"error\":" + Json.quote(message) + "}");
    }

    private static Response text(Status status, String message) {
        return NanoHTTPD.newFixedLengthResponse(status, "text/plain; charset=utf-8", message);
    }
}
