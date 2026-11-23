export function normalizeWebsiteUrl(value: string) {
  const trimmed = value.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`); }
  catch { throw new Error('Invalid website URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('Website URLs must be http or https addresses without credentials.');
  }
  return url.href;
}
