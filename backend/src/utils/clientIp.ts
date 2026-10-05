/**
 * Best-effort client IP for a request behind CloudFront and the ALB.
 *
 * 1. `CloudFront-Viewer-Address`: "<ip>:<port>". IPv6 addresses are not bracketed
 *    (e.g. "2001:db8::1:46532"), so the port is whatever follows the last colon.
 *    A bracketed "[v6]:port" form is tolerated too.
 * 2. The first entry of `X-Forwarded-For`.
 * 3. Otherwise null.
 *
 * (Replaces Cloudflare's CF-Connecting-IP.) Only used as the optional `remoteip`
 * hint for Turnstile, never for access control.
 */
export function getClientIp(request: Request): string | null {
  const viewer = request.headers.get('CloudFront-Viewer-Address')?.trim();
  if (viewer) {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(viewer);
    if (bracketed) return bracketed[1];

    const lastColon = viewer.lastIndexOf(':');
    if (lastColon > 0 && /^\d+$/.test(viewer.slice(lastColon + 1))) {
      return viewer.slice(0, lastColon);
    }
    return viewer;
  }

  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }

  return null;
}
