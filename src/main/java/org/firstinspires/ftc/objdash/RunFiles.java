package org.firstinspires.ftc.objdash;

import org.firstinspires.ftc.robotcore.internal.system.AppUtil;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Saved runs on the robot: /sdcard/FIRST/objdash/&lt;folder&gt;/&lt;name&gt;.json
 */
final class RunFiles {
    private RunFiles() {}

    static final File ROOT = new File(AppUtil.FIRST_FOLDER, "objdash");
    private static final String EXT = ".json";
    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9 _.\\-]{0,63}");

    static final class BadNameException extends Exception {
        BadNameException(String what) {
            super(what + " must be 1-64 characters: letters, numbers, spaces, '_', '-' or '.', and can't start with a symbol");
        }
    }

    static final class ExistsException extends Exception {
        ExistsException() {
            super("A saved run with that name already exists");
        }
    }

    private static void check(String value, String what) throws BadNameException {
        if (value == null || !VALID.matcher(value).matches() || value.contains("..")) {
            throw new BadNameException(what);
        }
    }

    private static File fileFor(String folder, String name) throws BadNameException {
        check(folder, "Folder");
        check(name, "File name");
        return new File(new File(ROOT, folder), name + EXT);
    }

    /** Writes the body to the file and returns the file's full path. */
    static String save(String folder, String name, InputStream body, long length, boolean overwrite)
            throws BadNameException, ExistsException, IOException {
        File file = fileFor(folder, name);
        if (file.exists() && !overwrite) throw new ExistsException();
        File dir = file.getParentFile();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't create " + dir);

        File tmp = new File(dir, "." + name + EXT + ".tmp");
        OutputStream out = new FileOutputStream(tmp);
        try {
            byte[] buf = new byte[16384];
            long remaining = length;
            while (remaining > 0) {
                int n = body.read(buf, 0, (int) Math.min(buf.length, remaining));
                if (n < 0) throw new IOException("Upload ended early");
                out.write(buf, 0, n);
                remaining -= n;
            }
        } finally {
            out.close();
        }
        if (file.exists() && !file.delete()) throw new IOException("Couldn't replace " + file);
        if (!tmp.renameTo(file)) throw new IOException("Couldn't write " + file);
        return file.getAbsolutePath();
    }

    /** Returns prefix-NNN, one higher than the highest existing prefix-NNN in the folder. */
    static String nextName(String folder, String prefix) throws BadNameException {
        check(prefix, "Prefix");
        int highest = 0;
        if (folder != null && !folder.isEmpty()) {
            check(folder, "Folder");
            String[] names = new File(ROOT, folder).list();
            if (names != null) {
                Pattern p = Pattern.compile(Pattern.quote(prefix) + "-(\\d{3,})" + Pattern.quote(EXT));
                for (String n : names) {
                    Matcher m = p.matcher(n);
                    if (m.matches()) highest = Math.max(highest, Integer.parseInt(m.group(1)));
                }
            }
        }
        return String.format("%s-%03d", prefix, highest + 1);
    }

    /** JSON listing of every folder and its saved runs, newest first. */
    static String listJson() {
        StringBuilder b = new StringBuilder("{\"root\":").append(Json.quote(ROOT.getAbsolutePath())).append(",\"folders\":[");
        File[] dirs = ROOT.listFiles();
        if (dirs != null) {
            Arrays.sort(dirs, new Comparator<File>() {
                @Override public int compare(File a, File c) { return a.getName().compareToIgnoreCase(c.getName()); }
            });
            boolean firstDir = true;
            for (File dir : dirs) {
                if (!dir.isDirectory()) continue;
                File[] files = dir.listFiles();
                List<File> runs = new ArrayList<>();
                if (files != null) {
                    for (File f : files) {
                        if (f.isFile() && f.getName().endsWith(EXT) && !f.getName().startsWith(".")) runs.add(f);
                    }
                }
                Collections.sort(runs, new Comparator<File>() {
                    @Override public int compare(File a, File c) { return c.getName().compareTo(a.getName()); }
                });
                if (!firstDir) b.append(',');
                firstDir = false;
                b.append("{\"name\":").append(Json.quote(dir.getName())).append(",\"runs\":[");
                for (int i = 0; i < runs.size(); i++) {
                    File f = runs.get(i);
                    String n = f.getName();
                    if (i > 0) b.append(',');
                    b.append("{\"name\":").append(Json.quote(n.substring(0, n.length() - EXT.length())))
                     .append(",\"size\":").append(f.length())
                     .append(",\"modified\":").append(f.lastModified()).append('}');
                }
                b.append("]}");
            }
        }
        return b.append("]}").toString();
    }

    static String load(String folder, String name) throws BadNameException, IOException {
        File file = fileFor(folder, name);
        InputStream in = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(16, file.length()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            in.close();
        }
    }
}
