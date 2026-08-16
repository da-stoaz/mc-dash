import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { FileUp, Upload, X } from 'lucide-react';
import { formatBytes } from './server-details/metricsUtils';

type FilePickerProps = {
  label: string;
  /** Same syntax as the native input's `accept` (e.g. ".zip"). */
  accept?: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** Hint rendered under the field. Stays visible once a file is picked. */
  description?: ReactNode;
  isDisabled?: boolean;
};

/**
 * Bordered file field. A bare `<input type="file">` renders as an unstyled
 * browse button with no container, which reads as "not an input" next to the
 * HeroUI fields around it — nothing shows where to click. This gives it the
 * same filled box as its siblings, makes the whole box a click and drop
 * target, and shows the picked file inside the field instead of below it.
 */
export function FilePicker({ label, accept, file, onFileChange, description, isDisabled = false }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputId = useId();

  const openPicker = () => {
    if (isDisabled) return;
    inputRef.current?.click();
  };

  // The native input holds on to its value, so a parent clearing the selection
  // (own clear button, or after a successful upload) would leave the same file
  // staged internally and re-picking it would fire no change event.
  useEffect(() => {
    if (!file && inputRef.current) inputRef.current.value = '';
  }, [file]);

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>

      <div
        // Mouse convenience only — the button inside is the accessible control,
        // so the click is skipped when it came from a button (which opens the
        // picker itself) to avoid firing twice.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          openPicker();
        }}
        onDragOver={(event) => {
          if (isDisabled) return;
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          if (isDisabled) return;
          event.preventDefault();
          setIsDragging(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) onFileChange(dropped);
        }}
        className={[
          'flex items-center gap-3 rounded-medium border-2 border-dashed px-3 py-3 transition-colors',
          isDisabled
            ? 'cursor-not-allowed border-default-200 bg-default-100 opacity-60'
            : 'cursor-pointer bg-default-100 hover:bg-default-200',
          isDragging ? 'border-primary bg-default-200' : !isDisabled ? 'border-default-300' : '',
        ].join(' ')}
      >
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept={accept}
          disabled={isDisabled}
          className="hidden"
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        />

        <Button
          size="sm"
          variant="flat"
          startContent={<Upload size={14} />}
          onPress={openPicker}
          isDisabled={isDisabled}
        >
          Choose file
        </Button>

        <div className="min-w-0 flex-1 text-sm">
          {file ? (
            <div className="flex items-center gap-2">
              <FileUp size={14} className="shrink-0 text-primary" />
              <span className="truncate font-medium">{file.name}</span>
              <span className="shrink-0 text-xs muted">{formatBytes(file.size)}</span>
            </div>
          ) : (
            <span className="muted">No file selected — click or drop one here</span>
          )}
        </div>

        {file && !isDisabled && (
          <Button
            size="sm"
            variant="light"
            isIconOnly
            aria-label="Clear selected file"
            onPress={() => onFileChange(null)}
          >
            <X size={14} />
          </Button>
        )}
      </div>

      {description && <div className="text-xs muted">{description}</div>}
    </div>
  );
}
