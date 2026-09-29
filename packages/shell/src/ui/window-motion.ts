import type { MotionProps } from "framer-motion";

const EASE = [0.22, 1, 0.36, 1] as const;
/** Gentler at the start than EASE, so the growth out of the icon reads. */
const ZOOM = [0.2, 0.75, 0.25, 1] as const;

/** One pose of a window: what framer-motion holds it at, or animates it to. */
type Pose = { opacity: number; scale?: number; y?: number };

/** The props that make a window's animated wrapper arrive and leave. */
export type WindowMotion = {
  initial: Pose;
  animate: Pose;
  exit: Pose;
  transition: NonNullable<MotionProps["transition"]>;
};

/**
 * How a window arrives and leaves. One opened from an icon, folder or dock tile (`origin`, a point on the stage) grows
 * out of it and shrinks back into it on close; one opened from anywhere else fades in with a small rise and out with a
 * small drop.
 *
 * Under a reduced-motion setting every pose is opacity alone, so the window fades in and out at full size and nothing
 * scales or shifts, not even for a frame. The fade keeps its timing. framer-motion's own handling of the setting (the
 * MotionConfig in DesktopShell) would not do this: it applies a transform at once instead of animating it, so a window
 * closing from an icon would jump to its exit pose, a small copy at the icon, and fade from there.
 */
export function windowMotion(origin: { x: number; y: number } | undefined, reduced: boolean): WindowMotion {
  const transition: WindowMotion["transition"] = origin
    ? { duration: 0.34, ease: ZOOM, opacity: { duration: 0.2 } }
    : { duration: 0.16, ease: EASE };
  if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition };
  return origin
    ? {
        initial: { opacity: 0, scale: 0.14 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.14 },
        transition,
      }
    : {
        initial: { opacity: 0, scale: 0.97, y: 10 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.97, y: 8 },
        transition,
      };
}
