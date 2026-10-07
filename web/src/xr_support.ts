export type ImmersiveVRDetector = { isSessionSupported: (mode: "immersive-vr") => Promise<boolean> };

export async function supportsImmersiveVR(xr: ImmersiveVRDetector | undefined): Promise<boolean> {
  if (!xr) return false;
  try { return await xr.isSessionSupported("immersive-vr"); } catch { return false; }
}
