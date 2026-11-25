import { useId, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';

interface CsvDropZoneProps {
  onLoadCsv: (text: string, fileName: string) => void;
  compact?: boolean;
  title?: string;
  hint?: string;
  /** Displayed file name in CSV mode (e.g. MapInfo.sourceName). */
  fileName?: string;
  /** Optional secondary button (e.g. returning to the live DRA tab from CSV mode). */
  secondaryAction?: {
    label: string;
    onClick: () => void;
    testId?: string;
  };
}

function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsText(file);
  });
}

export function CsvDropZone({
  onLoadCsv,
  compact = false,
  title = 'Drop a DRA block-assignment CSV',
  hint = 'In DRA: Export → Block Assignment CSV (GEOID20,District). Live ticking is off in CSV mode.',
  fileName,
  secondaryAction,
}: CsvDropZoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const text = await readFileAsText(file);
      if (!text.trim()) {
        setError('That CSV file is empty.');
        return;
      }
      onLoadCsv(text, file.name);
    } catch {
      setError('Could not read that file. Try exporting again from DRA.');
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragActive) setDragActive(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    void handleFile(file);
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    void handleFile(file);
    e.target.value = '';
  };

  return (
    <div
      className={`zd-dropzone${compact ? ' zd-dropzone--compact' : ''}${dragActive ? ' zd-dropzone--active' : ''}`}
      data-testid="csv-dropzone"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        id={inputId}
        className="zd-dropzone__input"
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={handleInputChange}
        aria-label="Choose DRA block-assignment CSV file"
      />
      <div className="zd-dropzone__content">
        <p className="zd-dropzone__title">
          {title}
          {fileName && (
            <>
              {' '}
              <span
                className="zd-pill zd-pill--accent zd-mono zd-dropzone__file"
                title={fileName}
                data-testid="csv-source-name"
              >
                {fileName}
              </span>
            </>
          )}
        </p>
        <p className="zd-dropzone__hint">{hint}</p>
        {error && (
          <p className="zd-note zd-note--error zd-dropzone__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="zd-dropzone__actions">
        <button
          type="button"
          className={`zd-btn${compact ? ' zd-btn--sm' : ''}`}
          onClick={() => inputRef.current?.click()}
        >
          Choose CSV…
        </button>
        {secondaryAction && (
          <button
            type="button"
            className={`zd-btn${compact ? ' zd-btn--sm' : ''} zd-btn--primary`}
            data-testid={secondaryAction.testId}
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </button>
        )}
      </div>
    </div>
  );
}
