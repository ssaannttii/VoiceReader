import { describe, expect, it } from 'vitest';
import { clipboardLink, linkHost, linkPreview, normalizeUrl } from './add-link';

describe('normalizeUrl', () => {
  it('adds https only when the scheme is missing', () => {
    expect(normalizeUrl(' example.com/a ')).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });
});

describe('linkHost', () => {
  it('accepts web links and bare domains', () => {
    expect(linkHost('https://www.example.com/post')).toBe('example.com');
    expect(linkHost('es.wikipedia.org/wiki/Lector')).toBe('es.wikipedia.org');
    expect(linkHost('http://192.168.1.20:3900/x')).toBe('192.168.1.20');
    expect(linkHost('localhost:8080')).toBe('localhost');
  });

  it('rejects text, other schemes and hosts without a domain', () => {
    expect(linkHost('')).toBeNull();
    expect(linkHost('hola que tal')).toBeNull();
    expect(linkHost('ftp://example.com')).toBeNull();
    expect(linkHost('example')).toBeNull();
  });
});

describe('clipboardLink', () => {
  it('finds a link on its own or inside a short shared text', () => {
    expect(clipboardLink('https://example.com/a')).toBe('https://example.com/a');
    expect(clipboardLink('Mira esto: https://example.com/a).')).toBe('https://example.com/a');
    expect(clipboardLink('example.com/a')).toBe('example.com/a');
  });

  it('ignores plain text', () => {
    expect(clipboardLink('Una frase cualquiera.')).toBeNull();
    expect(clipboardLink('')).toBeNull();
    expect(clipboardLink(null)).toBeNull();
  });
});

describe('linkPreview', () => {
  it('shows host and path, shortened', () => {
    expect(linkPreview('https://www.example.com/')).toBe('example.com');
    expect(linkPreview('https://example.com/a/very/long/path/to/an/article', 20)).toBe(
      'example.com/a/very/…',
    );
  });
});
