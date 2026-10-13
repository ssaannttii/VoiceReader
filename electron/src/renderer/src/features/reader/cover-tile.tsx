import type { CSSProperties } from 'react';
import { FileTextIcon, GlobeIcon, ScanTextIcon, TypeIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CoverArt } from './library-view';
import { coverGradient, coverInitial } from './reader-text';
import { useCoverUrl } from './use-reader-data';

/**
 * EPUB cover, or a stable generated tile. Without `shape` it keeps the
 * original rounded gradient tile; with it, books are 2:3 portraits with a
 * spine and articles, notes and scans are squares with their own artwork.
 */
export function CoverTile({
  id,
  title,
  hasCover,
  className,
  size = 'md',
  shape,
  art = 'book',
  style,
}: {
  id: string;
  title: string;
  hasCover: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  shape?: 'book' | 'square';
  art?: CoverArt;
  style?: CSSProperties;
}) {
  const url = useCoverUrl(id, hasCover);
  const gradient = coverGradient(id + title);
  if (shape) {
    const generated = !url;
    const tinted = generated && (art === 'web' || art === 'text' || art === 'scan');
    return (
      <div
        aria-hidden="true"
        className={cn('rd-cover-tile', className)}
        data-shape={shape}
        data-size={size}
        data-art={generated ? art : undefined}
        style={
          { ...style, ...(generated ? { '--rd-cover-art': gradient } : null) } as CSSProperties
        }
      >
        {url ? (
          <img src={url} alt="" draggable={false} />
        ) : tinted ? (
          <CoverGlyph art={art} />
        ) : (
          <>
            <span className="rd-cover-initial">{coverInitial(title)}</span>
            {art === 'pdf' && (
              <span className="rd-cover-tag">
                <FileTextIcon aria-hidden="true" />
                PDF
              </span>
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rd-cover',
        size === 'sm' && 'size-10 rounded-lg text-lg',
        size === 'md' && 'h-[4.5rem] w-14 rounded-[0.7rem] text-2xl',
        size === 'lg' && 'h-32 w-24 rounded-2xl text-5xl',
        className,
      )}
      style={url ? style : { ...style, background: gradient }}
    >
      {url ? <img src={url} alt="" draggable={false} /> : coverInitial(title)}
    </div>
  );
}

function CoverGlyph({ art }: { art: CoverArt }) {
  if (art === 'web')
    return (
      <span className="rd-cover-page">
        <GlobeIcon aria-hidden="true" />
        <i />
        <i />
        <i />
      </span>
    );
  const Icon = art === 'scan' ? ScanTextIcon : TypeIcon;
  return <Icon className="rd-cover-glyph" aria-hidden="true" />;
}
