import type { Route } from './config.ts';

// Do not decode, verify or log session values. Authentication belongs upstream.
export function requestCookies(raw: string | undefined, route: Route): string {
  return (raw ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const equals = part.indexOf('=');
      return equals > 0 && route.cookieNames.includes(part.slice(0, equals));
    })
    .join('; ');
}

export function responseCookies(
  values: string[],
  route: Route,
  production: boolean,
): string[] {
  const result: string[] = [];
  // getSetCookie() preserves separate headers and commas within Expires.
  for (const value of values) {
    const [pair, ...attributes] = value.split(';').map((part) => part.trim());
    const equals = pair.indexOf('=');
    if (equals < 1 || !route.cookieNames.includes(pair.slice(0, equals)))
      continue;
    const forwarded = attributes.filter(
      (attribute) =>
        !['domain', 'path'].includes(
          attribute.split('=')[0].trim().toLowerCase(),
        ),
    );
    if (
      production &&
      !forwarded.some((attribute) => attribute.toLowerCase() === 'secure')
    )
      forwarded.push('Secure');
    if (
      !forwarded.some(
        (attribute) =>
          attribute.split('=')[0].trim().toLowerCase() === 'samesite',
      )
    )
      forwarded.push('SameSite=Lax');
    // Host-only and subsystem-scoped on the public gateway, also for logout.
    result.push([pair, ...forwarded, 'Path=' + route.cookiePath].join('; '));
  }
  return result;
}
