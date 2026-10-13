/** Link input for "Paste a link" (pure): normalising, validating, clipboard pick-up. */

/** Adds `https://` when the scheme is missing ("example.com/a" → "https://example.com/a"). */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The host when the input is a usable web link, else null. */
export function linkHost(value: string): string | null {
  if (!value.trim() || /\s/.test(value.trim())) return null;
  try {
    const url = new URL(normalizeUrl(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname;
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
    if (!ip && host !== 'localhost' && !/\.[a-z\d-]{2,}$/i.test(host)) return null;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** First http(s) link in clipboard text, if the text is (mostly) just a link. */
export function clipboardLink(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const match = /https?:\/\/[^\s<>"']+/i.exec(trimmed);
  const candidate = match ? match[0].replace(/[).,;:!?]+$/, '') : trimmed;
  if (!match && /\s/.test(candidate)) return null;
  // A bare "example.com" counts only when it looks like a domain with a path or a dot.
  if (!match && !/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(candidate)) return null;
  return linkHost(candidate) ? candidate : null;
}

/** Short label for a link chip: host plus the start of the path. */
export function linkPreview(value: string, max = 28): string {
  try {
    const url = new URL(normalizeUrl(value));
    const text = `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  } catch {
    return value.slice(0, max);
  }
}
