package org.firstinspires.ftc.objdash;

import com.qualcomm.robotcore.util.RobotLog;

import org.firstinspires.ftc.robotcore.internal.opmode.ClassFilter;
import org.firstinspires.ftc.robotcore.internal.opmode.ClassManager;

import java.lang.annotation.Annotation;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Finds {@link ObjConfig} classes in OnBot Java code and external libraries, and reads/writes their
 * static fields.
 *
 * Finding the classes: the SDK scans every class once at app start, before our hooks run, so we
 * can't see that scan. Instead we (1) read the OnBot Java class names and class loader from
 * ClassManager once, by reflection, and (2) register a ClassFilter so we hear about the rescans the
 * SDK does after each OnBot Java build. It's essential to use the SDK's class loader: static fields
 * belong to a particular loaded copy of a class, and OpModes use the SDK's copy.
 */
final class ConfigRegistry {
    static final ConfigRegistry INSTANCE = new ConfigRegistry();

    private static final String CONFIG_ANNOTATION = ObjConfig.class.getName();
    private static final int MAX_DEPTH = 3;

    /** Class name -> class, for OnBot Java and external library classes respectively. */
    private Map<String, Class<?>> onBotJava = new TreeMap<>();
    private Map<String, Class<?>> externalLibraries = new TreeMap<>();
    private List<Class<?>> pendingOnBot;
    private List<Class<?>> pendingExternal;
    private boolean initialScanDone = false;
    private String scanError = null;
    /** What the last scan saw, shown in the dashboard when no classes are found. */
    private String scanSummary = "Not scanned yet.";
    private final List<String> scanNotes = new ArrayList<>();
    private static final int MAX_NOTES = 25;
    /**
     * Right after the robot starts, the SDK may not have OnBot Java classes ready yet, so a scan
     * can come back empty. While nothing has been found, scan again this often.
     */
    private static final long EMPTY_RESCAN_MS = 3000;
    private long lastScanMillis = 0;
    private String lastLoggedSummary = null;

    /** "class|path" -> value as first seen, so the dashboard can offer Reset. */
    private final Map<String, String> defaults = new HashMap<>();

    private ConfigRegistry() {}

    // ---- discovery ------------------------------------------------------------------------------

    void registerFilter() {
        ClassManager.getInstance().registerFilter(new ClassFilter() {
            @Override public void filterAllClassesStart() { filterOnBotJavaClassesStart(); filterExternalLibrariesClassesStart(); }
            @Override public void filterClass(Class clazz) { filterOnBotJavaClass(clazz); }
            @Override public void filterAllClassesComplete() { filterOnBotJavaClassesComplete(); filterExternalLibrariesClassesComplete(); }

            private int seen;

            @Override public void filterOnBotJavaClassesStart() {
                synchronized (ConfigRegistry.this) { pendingOnBot = new ArrayList<>(); seen = 0; }
            }
            @Override public void filterOnBotJavaClass(Class clazz) {
                synchronized (ConfigRegistry.this) {
                    seen++;
                    if (isConfigClass(clazz) && pendingOnBot != null) pendingOnBot.add(clazz);
                }
            }
            @Override public void filterOnBotJavaClassesComplete() {
                synchronized (ConfigRegistry.this) {
                    if (pendingOnBot != null) onBotJava = toMap(pendingOnBot);
                    pendingOnBot = null;
                    initialScanDone = true;
                    scanSummary = "After an OnBot Java build the SDK reported " + seen + " classes; "
                            + onBotJava.size() + " have @ObjConfig. Click Refresh for a full scan.";
                    scanNotes.clear();
                }
                RobotLog.ii(ObjDashboard.TAG, "Config: OnBot Java rescan found %d @ObjConfig classes", onBotJava.size());
            }

            @Override public void filterExternalLibrariesClassesStart() {
                synchronized (ConfigRegistry.this) { pendingExternal = new ArrayList<>(); }
            }
            @Override public void filterExternalLibrariesClass(Class clazz) {
                if (isConfigClass(clazz)) synchronized (ConfigRegistry.this) { if (pendingExternal != null) pendingExternal.add(clazz); }
            }
            @Override public void filterExternalLibrariesClassesComplete() {
                synchronized (ConfigRegistry.this) {
                    if (pendingExternal != null) externalLibraries = toMap(pendingExternal);
                    pendingExternal = null;
                }
            }
        });
    }

    private static Map<String, Class<?>> toMap(List<Class<?>> classes) {
        Map<String, Class<?>> m = new TreeMap<>();
        for (Class<?> c : classes) m.put(c.getName(), c);
        return m;
    }

    /**
     * Compared by name because OnBot Java rebuilds load a fresh copy of our library alongside the
     * new team code, so ObjConfig.class here may not be the same Class object the team code uses.
     */
    private static Annotation configAnnotation(Class<?> c) {
        try {
            for (Annotation a : c.getAnnotations()) {
                if (a.annotationType().getName().equals(CONFIG_ANNOTATION)) return a;
            }
        } catch (Throwable ignored) {
            // A class that fails to load its annotations isn't one we can use.
        }
        return null;
    }

    private static boolean isConfigClass(Class<?> c) {
        return configAnnotation(c) != null;
    }

    /** Makes the next request do a full scan again (the dashboard's Refresh button). */
    synchronized void requestRescan() {
        initialScanDone = false;
    }

    /** Counts for one scan, for the diagnostics shown in the dashboard. */
    private static final class ScanStats {
        int names, loaded, failed;
        String firstFailure;
    }

    /** Full scan of the classes the SDK loaded, using the SDK's own OnBot Java class loader. */
    private synchronized void ensureInitialScan() {
        if (initialScanDone && onBotJava.isEmpty() && externalLibraries.isEmpty()
                && System.currentTimeMillis() - lastScanMillis > EMPTY_RESCAN_MS) {
            initialScanDone = false;
        }
        if (initialScanDone) return;
        initialScanDone = true;
        lastScanMillis = System.currentTimeMillis();
        scanError = null;
        scanNotes.clear();
        try {
            ClassManager cm = ClassManager.getInstance();
            Object helper = readField(cm, "onBotJavaHelper");
            ClassLoader loader = (ClassLoader) readField(cm, "classLoader");
            if (helper == null || loader == null) {
                scanError = "OnBot Java isn't available on this Robot Controller (helper=" + helper + ", loader=" + loader + ").";
                scanSummary = scanError;
                return;
            }
            Method onBotNames = helper.getClass().getMethod("getOnBotJavaClassNames");
            Method libNames = helper.getClass().getMethod("getExternalLibrariesClassNames");
            ScanStats onBot = new ScanStats();
            ScanStats libs = new ScanStats();
            onBotJava = toMap(loadConfigClasses(onBotNames.invoke(helper), loader, onBot, true));
            externalLibraries = toMap(loadConfigClasses(libNames.invoke(helper), loader, libs, false));
            scanSummary = "Scanned " + onBot.names + " OnBot Java classes (" + onBot.loaded + " loaded, "
                    + onBot.failed + " failed) and " + libs.names + " library classes (" + libs.loaded
                    + " loaded, " + libs.failed + " failed). Found " + (onBotJava.size() + externalLibraries.size())
                    + " with @ObjConfig.";
            scanNotes.add("SDK class loader: " + loader.getClass().getName()
                    + "; dashboard's: " + describeLoader(ConfigRegistry.class.getClassLoader()));
            if (onBot.firstFailure != null) scanNotes.add("First OnBot Java load failure: " + onBot.firstFailure);
            // Retries repeat the same result while waiting, so only log when something changed.
            if (!scanSummary.equals(lastLoggedSummary)) {
                lastLoggedSummary = scanSummary;
                RobotLog.ii(ObjDashboard.TAG, "Config: %s", scanSummary);
                for (String n : scanNotes) RobotLog.ii(ObjDashboard.TAG, "Config: %s", n);
            }
        } catch (Throwable t) {
            scanError = "Couldn't scan for @ObjConfig classes: " + t;
            scanSummary = scanError;
            RobotLog.ee(ObjDashboard.TAG, t, "Config scan failed");
        }
    }

    private static String describeLoader(ClassLoader l) {
        return l == null ? "null" : l.getClass().getName();
    }

    private static Object readField(Object target, String name) throws Exception {
        Field f = target.getClass().getDeclaredField(name);
        f.setAccessible(true);
        return f.get(target);
    }

    private List<Class<?>> loadConfigClasses(Object names, ClassLoader loader, ScanStats stats, boolean noteAnnotations) {
        List<Class<?>> out = new ArrayList<>();
        if (!(names instanceof Collection)) {
            scanNotes.add("Class name list was " + (names == null ? "null" : names.getClass().getName()));
            return out;
        }
        for (Object n : (Collection<?>) names) {
            stats.names++;
            Class<?> c;
            try {
                c = Class.forName(String.valueOf(n), false, loader);
                stats.loaded++;
            } catch (Throwable t) {
                stats.failed++;
                if (stats.firstFailure == null) stats.firstFailure = n + ": " + t;
                continue;
            }
            if (isConfigClass(c)) out.add(c);
            // For diagnosing: which annotations can we see on top-level team classes?
            if (noteAnnotations && scanNotes.size() < MAX_NOTES && c.getEnclosingClass() == null) {
                StringBuilder s = new StringBuilder(c.getName()).append(':');
                try {
                    Annotation[] anns = c.getAnnotations();
                    if (anns.length == 0) s.append(" (no annotations)");
                    for (Annotation a : anns) s.append(" @").append(a.annotationType().getName());
                } catch (Throwable t) {
                    s.append(" couldn't read annotations: ").append(t);
                }
                scanNotes.add(s.toString());
            }
        }
        return out;
    }

    private synchronized List<Class<?>> classes() {
        ensureInitialScan();
        Map<String, Class<?>> all = new TreeMap<>(externalLibraries);
        all.putAll(onBotJava);
        return new ArrayList<>(all.values());
    }

    // ---- field model ----------------------------------------------------------------------------

    private static boolean isLeafType(Class<?> t) {
        return t.isPrimitive() || t == String.class || t.isEnum()
                || t == Boolean.class || t == Integer.class || t == Long.class || t == Short.class
                || t == Byte.class || t == Float.class || t == Double.class;
    }

    private static boolean isNestable(Class<?> t) {
        String n = t.getName();
        return !t.isArray() && !t.isInterface() && !n.startsWith("java.") && !n.startsWith("android.")
                && !n.startsWith("kotlin.");
    }

    private static String typeName(Class<?> t) {
        if (t.isEnum()) return "enum";
        if (t == boolean.class || t == Boolean.class) return "boolean";
        if (t == String.class) return "string";
        if (t == float.class || t == Float.class || t == double.class || t == Double.class) return "decimal";
        return "integer";
    }

    private static String format(Object v) {
        if (v == null) return "null";
        if (v instanceof Enum) return ((Enum<?>) v).name();
        return String.valueOf(v);
    }

    private static String displayName(Class<?> c) {
        Annotation a = configAnnotation(c);
        try {
            Object v = a == null ? null : a.annotationType().getMethod("value").invoke(a);
            if (v instanceof String && !((String) v).isEmpty()) return (String) v;
        } catch (Exception ignored) {
            // Fall back to the class name.
        }
        return c.getSimpleName();
    }

    /**
     * The editable fields of a class (static) or of an object (instance). Static fields come only
     * from the annotated class itself, so an OpMode marked @ObjConfig doesn't also list the SDK's
     * inherited constants.
     */
    private static List<Field> fieldsOf(Class<?> c, boolean statics) {
        List<Field> out = new ArrayList<>();
        for (Field f : statics ? c.getDeclaredFields() : c.getFields()) {
            int m = f.getModifiers();
            if (Modifier.isStatic(m) != statics || !Modifier.isPublic(m)) continue;
            if (f.isSynthetic()) continue;
            out.add(f);
        }
        return out;
    }

    synchronized String toJson() {
        List<Class<?>> classes = classes();
        StringBuilder b = new StringBuilder("{");
        if (scanError != null) b.append("\"error\":").append(Json.quote(scanError)).append(',');
        b.append("\"scan\":{\"summary\":").append(Json.quote(scanSummary)).append(",\"notes\":[");
        for (int i = 0; i < scanNotes.size(); i++) {
            if (i > 0) b.append(',');
            b.append(Json.quote(scanNotes.get(i)));
        }
        b.append("]},\"classes\":[");
        boolean firstClass = true;
        for (Class<?> c : classes) {
            StringBuilder fields = new StringBuilder();
            try {
                appendFields(fields, c.getName(), "", fieldsOf(c, true), null, 0);
            } catch (Throwable t) {
                RobotLog.ee(ObjDashboard.TAG, t, "Config: reading %s failed", c.getName());
                String note = "Couldn't read " + c.getName() + ": " + t;
                if (!scanNotes.contains(note) && scanNotes.size() < MAX_NOTES) scanNotes.add(note);
                continue;
            }
            if (fields.length() == 0) {
                String note = c.getName() + " has @ObjConfig but no public static fields of a supported type";
                if (!scanNotes.contains(note) && scanNotes.size() < MAX_NOTES) scanNotes.add(note);
                continue;
            }
            if (!firstClass) b.append(',');
            firstClass = false;
            b.append("{\"id\":").append(Json.quote(c.getName()))
             .append(",\"name\":").append(Json.quote(displayName(c)))
             .append(",\"fields\":[").append(fields).append("]}");
        }
        return b.append("]}").toString();
    }

    private void appendFields(StringBuilder b, String classId, String prefix, List<Field> fields, Object owner, int depth)
            throws IllegalAccessException {
        for (Field f : fields) {
            f.setAccessible(true);
            Class<?> t = f.getType();
            String path = prefix + f.getName();
            boolean isFinal = Modifier.isFinal(f.getModifiers());
            if (isLeafType(t)) {
                String value = format(f.get(owner));
                String key = classId + "|" + path;
                if (!defaults.containsKey(key)) defaults.put(key, value);
                if (b.length() > 0) b.append(',');
                b.append("{\"path\":").append(Json.quote(path))
                 .append(",\"type\":").append(Json.quote(typeName(t)))
                 .append(",\"value\":").append(Json.quote(value))
                 .append(",\"default\":").append(Json.quote(defaults.get(key)))
                 .append(",\"readOnly\":").append(isFinal)
                 .append(",\"depth\":").append(depth);
                if (t.isEnum()) {
                    b.append(",\"options\":[");
                    Object[] constants = t.getEnumConstants();
                    for (int i = 0; i < constants.length; i++) {
                        if (i > 0) b.append(',');
                        b.append(Json.quote(((Enum<?>) constants[i]).name()));
                    }
                    b.append(']');
                }
                b.append('}');
            } else if (depth < MAX_DEPTH && isNestable(t)) {
                Object child = f.get(owner);
                if (child == null) continue;
                StringBuilder inner = new StringBuilder();
                appendFields(inner, classId, path + ".", fieldsOf(child.getClass(), false), child, depth + 1);
                if (inner.length() == 0) continue;
                if (b.length() > 0) b.append(',');
                b.append("{\"path\":").append(Json.quote(path)).append(",\"type\":\"group\",\"depth\":").append(depth).append('}');
                b.append(',').append(inner);
            }
        }
    }

    // ---- editing --------------------------------------------------------------------------------

    static final class BadValueException extends Exception {
        BadValueException(String message) {
            super(message);
        }
    }

    /** Sets classId's field at path (like "kP" or "pid.p") and returns the new value as shown. */
    synchronized String set(String classId, String path, String text) throws BadValueException {
        if (classId == null || path == null || text == null) throw new BadValueException("Missing class, field or value");
        Class<?> c = null;
        for (Class<?> k : classes()) if (k.getName().equals(classId)) c = k;
        if (c == null) throw new BadValueException("No @ObjConfig class " + classId + ". Refresh the page.");

        try {
            String[] parts = path.split("\\.");
            Object owner = null;
            Class<?> ownerType = c;
            for (int i = 0; i < parts.length; i++) {
                Field f = ownerType.getField(parts[i]);
                if (Modifier.isStatic(f.getModifiers()) != (i == 0)) throw new BadValueException("Unknown field " + path);
                f.setAccessible(true);
                if (i < parts.length - 1) {
                    owner = f.get(owner);
                    if (owner == null) throw new BadValueException(parts[i] + " is null");
                    ownerType = owner.getClass();
                    continue;
                }
                if (Modifier.isFinal(f.getModifiers())) throw new BadValueException(path + " is final and can't be changed");
                if (!isLeafType(f.getType())) throw new BadValueException(path + " can't be edited directly");
                f.set(owner, parse(f.getType(), text.trim(), path));
                return format(f.get(owner));
            }
        } catch (NoSuchFieldException e) {
            throw new BadValueException("Unknown field " + path + ". Refresh the page.");
        } catch (IllegalAccessException e) {
            throw new BadValueException("Can't change " + path + ": " + e.getMessage());
        }
        throw new BadValueException("Unknown field " + path);
    }

    private static Object parse(Class<?> t, String s, String path) throws BadValueException {
        try {
            if (t == String.class) return s;
            if (s.equals("null") && !t.isPrimitive()) return null;
            if (t == boolean.class || t == Boolean.class) {
                if (s.equalsIgnoreCase("true")) return true;
                if (s.equalsIgnoreCase("false")) return false;
                throw new BadValueException(path + " must be true or false");
            }
            if (t.isEnum()) {
                for (Object e : t.getEnumConstants()) if (((Enum<?>) e).name().equals(s)) return e;
                throw new BadValueException(s + " isn't one of the choices for " + path);
            }
            if (t == double.class || t == Double.class) return Double.parseDouble(s);
            if (t == float.class || t == Float.class) return Float.parseFloat(s);
            long v;
            try {
                v = Long.parseLong(s);
            } catch (NumberFormatException e) {
                throw new BadValueException(path + " must be a whole number");
            }
            if (t == long.class || t == Long.class) return v;
            if (t == int.class || t == Integer.class) return (int) checkRange(v, Integer.MIN_VALUE, Integer.MAX_VALUE, path);
            if (t == short.class || t == Short.class) return (short) checkRange(v, Short.MIN_VALUE, Short.MAX_VALUE, path);
            if (t == byte.class || t == Byte.class) return (byte) checkRange(v, Byte.MIN_VALUE, Byte.MAX_VALUE, path);
        } catch (NumberFormatException e) {
            throw new BadValueException(path + " must be a number");
        }
        throw new BadValueException("Unsupported type for " + path);
    }

    private static long checkRange(long v, long min, long max, String path) throws BadValueException {
        if (v < min || v > max) throw new BadValueException(path + " must be between " + min + " and " + max);
        return v;
    }
}
