/** Pure tilt math. px/py are 0..1 pointer coords within the element; returns
 *  rotation in degrees, clamped to ±max. Center (0.5,0.5) → no tilt. */
export function computeTilt(px: number, py: number, max = 8): { rotateX: number; rotateY: number } {
  const clamp = (v: number) => Math.max(-max, Math.min(max, v));
  // top (py=0) tilts the card back → +rotateX; left (px=0) → -rotateY.
  const rotateX = clamp((0.5 - py) * 2 * max);
  const rotateY = clamp((px - 0.5) * 2 * max);
  return { rotateX, rotateY };
}
