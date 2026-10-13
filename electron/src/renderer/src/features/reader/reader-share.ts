/**
 * Share → Reader (Web Share Target, docs/reader/README.md).
 *
 * The manifest's share target POSTs to `/reader-share`; the service worker
 * (`public/reader-sw.js`) uploads shared files itself and sends links and text
 * on to `#/reader/share?title=…&text=…&url=…`, which this module interprets.
 */

export interface ShareParams {
  title?: string;
  text?: string;
  url?: string;
  /** Files the service worker queued for import, and how many it could not upload. */
  files?: number;
  failed?: number;
  /** Upload error the service worker reports (shown as the toast description). */
  error?: string;
}

export type ShareRequest =
  | { kind: 'url'; url: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'files'; files: number; failed: number; error?: string }
  | null;

const str = (value: unknown): string | undefined => {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value : undefined;
};
const count = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : Number(str(value));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/** Route search → typed share params (unknown keys dropped). */
export function parseShareSearch(search: Record<string, unknown>): ShareParams {
  const params: ShareParams = {};
  const title = str(search.title);
  const text = str(search.text);
  const url = str(search.url);
  const files = count(search.files);
  const failed = count(search.failed);
  const error = str(search.error);
  if (title) params.title = title;
  if (text) params.text = text;
  if (url) params.url = url;
  if (files !== undefined) params.files = files;
  if (failed !== undefined) params.failed = failed;
  if (error) params.error = error;
  return params;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'«»]+/i;

/** An http(s) URL, without trailing punctuation a sentence would add. */
function cleanUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[)\].,;:!?»"']+$/u, '');
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Text longer than this around a link is read as text, not as a link with its title. */
const LINK_CAPTION_MAX = 200;

/**
 * What a share should import. Apps put the link in different fields: Chrome
 * on Android sends it as `text`, often after the page title. A link with only
 * a short caption imports the article; longer text is imported as text.
 */
export function shareRequest(params: ShareParams): ShareRequest {
  if (params.files !== undefined || params.failed !== undefined)
    return {
      kind: 'files',
      files: params.files ?? 0,
      failed: params.failed ?? 0,
      ...(params.error ? { error: params.error } : {}),
    };
  const direct = params.url ? cleanUrl(params.url) : null;
  if (direct) return { kind: 'url', url: direct };
  const text = params.text?.trim() ?? '';
  const title = params.title?.trim() || undefined;
  const found = URL_PATTERN.exec(text);
  if (found) {
    const link = cleanUrl(found[0]);
    const caption = text.replace(found[0], '').trim();
    if (link && caption.length <= LINK_CAPTION_MAX) return { kind: 'url', url: link };
  }
  if (text) return { kind: 'text', text, ...(title ? { title } : {}) };
  const titleLink = title ? cleanUrl(title) : null;
  if (titleLink) return { kind: 'url', url: titleLink };
  if (title) return { kind: 'text', text: title };
  return null;
}
