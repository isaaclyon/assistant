/** Selected native factory; the host supplies the protected operation owner. */
export default function(host) {
 if (!host || typeof host.bundle !== "function") throw new Error("Native host services required");
 return host.bundle("private-browser");
}
