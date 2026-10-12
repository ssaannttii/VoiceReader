import { cn } from '@/lib/utils';
import { coverGradient, coverInitial } from './reader-text';
import { useCoverUrl } from './use-reader-data';

/** EPUB cover, or a stable gradient tile with the title's initial. */
export function CoverTile({
  id,
  title,
  hasCover,
  className,
  size = 'md',
}: {
  id: string;
  title: string;
  hasCover: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const url = useCoverUrl(id, hasCover);
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
      style={url ? undefined : { background: coverGradient(id + title) }}
    >
      {url ? <img src={url} alt="" draggable={false} /> : coverInitial(title)}
    </div>
  );
}
