/** Selected native Calendar/Workspace factory. */
export default function (host) {
  if (!host || typeof host.bundle !== "function") throw new Error("Native host services required");
  return host.bundle("google-mutations");
}
