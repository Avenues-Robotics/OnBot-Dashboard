package org.firstinspires.ftc.objdash;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Marks a class whose {@code public static} fields can be edited live from the OBJ Dashboard.
 *
 * <pre>
 * &#64;ObjConfig
 * public class ArmConstants {
 *     public static double kP = 0.01;
 *     public static int target = 500;
 *     public static boolean useFeedforward = true;
 * }
 * </pre>
 *
 * Supported field types: boolean, int, long, short, byte, float, double (and their boxed forms),
 * String, enums, and objects whose public fields are of those types (for example PIDFCoefficients).
 * Final fields are shown read-only. Edits change the running value immediately but are not saved
 * into your code; they reset when the robot restarts or OnBot Java rebuilds.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface ObjConfig {
    /** Name to show in the dashboard. Defaults to the class's simple name. */
    String value() default "";
}
