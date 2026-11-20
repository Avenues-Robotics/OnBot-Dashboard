package org.firstinspires.ftc.objdash;

import org.firstinspires.ftc.robotcore.internal.opmode.OnBotJavaHelper;
import org.firstinspires.ftc.robotcore.internal.opmode.OpModeMetaAndClass;
import org.firstinspires.ftc.robotcore.internal.opmode.RegisteredOpModes;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the telemetry names an OpMode will send, before it runs, by reading OnBot Java source.
 *
 * Starting from the OpMode's .java file, it collects every {@code ObjDash.put("name", ...)} and
 * follows every other OnBot Java class the file mentions (subsystems, helpers, ...), so puts in
 * those classes are found too. Only names written as a literal "string" can be found; the
 * dashboard also remembers names from earlier runs to cover the rest.
 */
final class OpModeKeyScanner {
    private OpModeKeyScanner() {}

    private static final Pattern PUT = Pattern.compile("ObjDash\\s*\\.\\s*put\\s*\\(\\s*\"((?:[^\"\\\\\\n]|\\\\.)*)\"\\s*,");
    private static final Pattern IDENTIFIER = Pattern.compile("\\b[A-Z][A-Za-z0-9_]*\\b");
    private static final Pattern PACKAGE = Pattern.compile("^\\s*package\\s+([\\w.]+)\\s*;", Pattern.MULTILINE);
    private static final int MAX_FILES = 200;

    static String scanJson(String opModeName) {
        StringBuilder b = new StringBuilder("{\"opMode\":").append(Json.quote(opModeName));
        try {
            File srcDir = OnBotJavaHelper.srcDir;
            Map<String, List<File>> bySimpleName = new HashMap<>();
            index(srcDir, bySimpleName, 0);

            File start = sourceFor(opModeName, srcDir, bySimpleName);
            if (start == null) {
                return b.append(",\"keys\":[],\"files\":[],\"classes\":[],\"note\":")
                        .append(Json.quote("Couldn't find the source for this OpMode in OnBot Java")).append('}').toString();
            }
            return scanFrom(b, srcDir, start, bySimpleName);
        } catch (Throwable t) {
            return b.append(",\"keys\":[],\"files\":[],\"classes\":[],\"note\":").append(Json.quote("Scan failed: " + t)).append('}').toString();
        }
    }

    /** Walks from {@code start} through the classes it mentions; appends keys/files/classes to b. */
    static String scanFrom(StringBuilder b, File srcDir, File start, Map<String, List<File>> bySimpleName) throws IOException {
        {
            Set<String> keys = new LinkedHashSet<>();
            List<String> scanned = new ArrayList<>();
            List<String> classNames = new ArrayList<>();
            Set<File> visited = new java.util.HashSet<>();
            Deque<File> queue = new ArrayDeque<>();
            queue.add(start);
            visited.add(start);
            while (!queue.isEmpty() && scanned.size() < MAX_FILES) {
                File f = queue.poll();
                String[] code = stripComments(read(f));
                scanned.add(srcDir.toURI().relativize(f.toURI()).getPath());
                Matcher pkg = PACKAGE.matcher(code[0]);
                String simple = f.getName().substring(0, f.getName().length() - 5);
                classNames.add(pkg.find() ? pkg.group(1) + "." + simple : simple);

                Matcher m = PUT.matcher(code[0]);
                while (m.find()) keys.add(unescape(m.group(1)));

                // Follow other OnBot Java classes this file mentions.
                Matcher id = IDENTIFIER.matcher(code[1]);
                while (id.find()) {
                    List<File> files = bySimpleName.get(id.group());
                    if (files == null) continue;
                    for (File other : files) if (visited.add(other)) queue.add(other);
                }
            }

            b.append(",\"keys\":[");
            boolean first = true;
            for (String k : keys) {
                if (!first) b.append(',');
                first = false;
                b.append(Json.quote(k));
            }
            b.append("],\"files\":[");
            for (int i = 0; i < scanned.size(); i++) {
                if (i > 0) b.append(',');
                b.append(Json.quote(scanned.get(i)));
            }
            // Fully-qualified names of the classes this OpMode uses, so the Config panel can put
            // their @ObjConfig variables first.
            b.append("],\"classes\":[");
            for (int i = 0; i < classNames.size(); i++) {
                if (i > 0) b.append(',');
                b.append(Json.quote(classNames.get(i)));
            }
            return b.append("]}").toString();
        }
    }

    static void index(File dir, Map<String, List<File>> out, int depth) {
        File[] files = dir.listFiles();
        if (files == null || depth > 20) return;
        for (File f : files) {
            if (f.isDirectory()) {
                index(f, out, depth + 1);
            } else if (f.getName().endsWith(".java")) {
                String simple = f.getName().substring(0, f.getName().length() - 5);
                List<File> list = out.get(simple);
                if (list == null) out.put(simple, list = new ArrayList<>());
                list.add(f);
            }
        }
    }

    /** The OpMode's source file: from the SDK's name -> class map, or by searching the sources. */
    private static File sourceFor(String opModeName, File srcDir, Map<String, List<File>> bySimpleName) throws IOException {
        Class<?> clazz = registeredClass(opModeName);
        if (clazz != null) {
            String name = clazz.getName();
            int inner = name.indexOf('$');
            if (inner >= 0) name = name.substring(0, inner);
            File f = new File(srcDir, name.replace('.', '/') + ".java");
            if (f.isFile()) return f;
            List<File> bySimple = bySimpleName.get(name.substring(name.lastIndexOf('.') + 1));
            if (bySimple != null && !bySimple.isEmpty()) return bySimple.get(0);
        }
        // Fallback: a class with the OpMode's name, or an annotation like @TeleOp(name = "...").
        List<File> sameName = bySimpleName.get(opModeName);
        if (sameName != null && !sameName.isEmpty()) return sameName.get(0);
        Pattern annotated = Pattern.compile("@(TeleOp|Autonomous)\\s*\\([^)]*name\\s*=\\s*\"" + Pattern.quote(opModeName) + "\"");
        for (List<File> files : bySimpleName.values()) {
            for (File f : files) if (annotated.matcher(stripComments(read(f))[0]).find()) return f;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static Class<?> registeredClass(String opModeName) {
        try {
            RegisteredOpModes r = RegisteredOpModes.getInstance();
            Field f = RegisteredOpModes.class.getDeclaredField("opModeClasses");
            f.setAccessible(true);
            Map<String, OpModeMetaAndClass> map = (Map<String, OpModeMetaAndClass>) f.get(r);
            OpModeMetaAndClass mc = map == null ? null : map.get(opModeName);
            return mc == null ? null : mc.clazz;
        } catch (Throwable t) {
            return null;
        }
    }

    private static String read(File f) throws IOException {
        InputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(64, f.length()));
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            in.close();
        }
    }

    /**
     * Returns {code without comments, code without comments or string/char literal contents}.
     * The first is searched for put("..."), the second for class names (so words inside strings
     * aren't mistaken for classes).
     */
    static String[] stripComments(String s) {
        StringBuilder withStrings = new StringBuilder(s.length());
        StringBuilder noStrings = new StringBuilder(s.length());
        int i = 0, n = s.length();
        while (i < n) {
            char c = s.charAt(i);
            char next = i + 1 < n ? s.charAt(i + 1) : '\0';
            if (c == '/' && next == '/') {
                while (i < n && s.charAt(i) != '\n') i++;
            } else if (c == '/' && next == '*') {
                i += 2;
                while (i < n && !(s.charAt(i) == '*' && i + 1 < n && s.charAt(i + 1) == '/')) i++;
                i += 2;
                withStrings.append(' ');
                noStrings.append(' ');
            } else if (c == '"' || c == '\'') {
                int startQuote = i++;
                while (i < n && s.charAt(i) != c && s.charAt(i) != '\n') {
                    if (s.charAt(i) == '\\') i++;
                    i++;
                }
                i++;
                withStrings.append(s, startQuote, Math.min(i, n));
                noStrings.append(c).append(c);
            } else {
                withStrings.append(c);
                noStrings.append(c);
                i++;
            }
        }
        return new String[] {withStrings.toString(), noStrings.toString()};
    }

    private static String unescape(String s) {
        if (s.indexOf('\\') < 0) return s;
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i + 1 >= s.length()) { b.append(c); continue; }
            char e = s.charAt(++i);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                default: b.append(e);
            }
        }
        return b.toString();
    }
}
