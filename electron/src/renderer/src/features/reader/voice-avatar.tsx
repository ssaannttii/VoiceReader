import type { CSSProperties } from 'react';
import { AudioLinesIcon, CloudOffIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { voiceAvatar } from './player-chrome';

/**
 * Round generated avatar for a voice: a stable gradient and the name's initial.
 * No voice (the default) shows a neutral waveform; offline shows a cloud.
 */
export function VoiceAvatar({
  id,
  name,
  size = 24,
  offline = false,
  className,
}: {
  id: string | null;
  name: string;
  size?: number;
  offline?: boolean;
  className?: string;
}) {
  const style = { '--rd-avatar': `${size}px` } as CSSProperties;
  if (offline || !id) {
    const Icon = offline ? CloudOffIcon : AudioLinesIcon;
    return (
      <span
        className={cn('rd-avatar rd-avatar-neutral', className)}
        style={style}
        aria-hidden="true"
      >
        <Icon className="size-[55%]" />
      </span>
    );
  }
  const avatar = voiceAvatar(id, name);
  return (
    <span
      className={cn('rd-avatar', className)}
      style={{ ...style, background: avatar.background }}
      aria-hidden="true"
    >
      {avatar.initial}
    </span>
  );
}
