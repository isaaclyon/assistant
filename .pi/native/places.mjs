/** Selected native factory; the host supplies instance-bound services. */
export default function (host) {
  if (!host || typeof host.bundle !== "function") throw new Error("Native host services required");
  return host.bundle("places");
}
