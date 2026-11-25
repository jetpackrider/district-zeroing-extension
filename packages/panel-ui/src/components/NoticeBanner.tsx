import type { PanelState } from '@zd/contracts';

interface NoticeBannerProps {
  notice: NonNullable<PanelState['notice']>;
}

const LABELS: Record<NonNullable<PanelState['notice']>['level'], string> = {
  info: 'Info',
  warn: 'Warning',
  error: 'Error',
};

const TAG_TONE: Record<NonNullable<PanelState['notice']>['level'], 'accent' | 'warn' | 'error'> = {
  info: 'accent',
  warn: 'warn',
  error: 'error',
};

export function NoticeBanner({ notice }: NoticeBannerProps) {
  const role = notice.level === 'info' ? 'status' : 'alert';
  return (
    <div className={`zd-notice zd-notice--${notice.level}`} role={role}>
      <span className={`zd-pill zd-pill--${TAG_TONE[notice.level]} zd-notice__tag`}>
        {LABELS[notice.level]}
      </span>
      <span>{notice.text}</span>
    </div>
  );
}
