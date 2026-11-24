import { useEffect, useRef } from 'react';
import type { MiniMapRenderer } from '../types';

interface MiniMapSlotProps {
  renderMiniMap?: MiniMapRenderer;
  /** Optional header caption (used outside walkthrough to label the current preview). */
  caption?: string;
  /** Optional secondary hint text in the header. */
  subCaption?: string;
  /** Placeholder copy when no shell renderer is provided. */
  placeholderTitle?: string;
  placeholderText?: string;
}

/**
 * Mounts the extension shell's MapLibre mini-map renderer inside a sized slot
 * whenever `mapMode === 'mini'` (during a walkthrough or for hover previews outside it).
 */
export function MiniMapSlot({
  renderMiniMap,
  caption,
  subCaption,
  placeholderTitle = 'Mini-map fallback active',
  placeholderText = 'DRA map highlights are unavailable; previews render here.',
}: MiniMapSlotProps) {
  const slotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!renderMiniMap || !slotRef.current) return;
    const container = slotRef.current;
    const cleanup = renderMiniMap(container);
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [renderMiniMap]);

  if (!caption) {
    return (
      <div className="zd-minimap-slot" ref={slotRef} data-testid="minimap-slot">
        {!renderMiniMap && (
          <div className="zd-minimap-placeholder">
            <strong>{placeholderTitle}</strong>
            <span>{placeholderText}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="zd-card zd-minimap-card" aria-label="Mini-map preview">
      <div className="zd-section-head" style={{ marginBottom: 6 }}>
        <h3 className="zd-section-title">{caption}</h3>
        {subCaption && (
          <span className="zd-minimap-card__sub zd-num">{subCaption}</span>
        )}
      </div>
      <div className="zd-minimap-slot" ref={slotRef} data-testid="minimap-slot">
        {!renderMiniMap && (
          <div className="zd-minimap-placeholder">
            <strong>{placeholderTitle}</strong>
            <span>{placeholderText}</span>
          </div>
        )}
      </div>
    </section>
  );
}
