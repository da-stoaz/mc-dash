import { ChangeEvent } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@heroui/react';
import { ServerRecord } from '../lib/serverTypes';

type Props = {
  server: ServerRecord;
  busy?: string;
  onAction: (id: string, action: 'start' | 'stop' | 'restart' | 'prepare') => void;
  onUpload: (id: string, file: File) => void;
  onEdit: () => void;
  onDeleteContainer: () => void;
};

export function ActionButtons({ server, busy, onAction, onUpload, onEdit, onDeleteContainer }: Props) {
  const disabled = !!busy || server.status === 'creating';

  const handleFile = (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (file) {
      onUpload(server.id, file);
      evt.target.value = '';
    }
  };

  return (
    <div className="flex flex-wrap gap-2 justify-end">
      <input type="file" accept=".zip" className="hidden" id={`file-${server.id}`} onChange={handleFile} />
      <Tooltip content="Upload server pack zip">
        <Button size="sm" variant="flat" onPress={() => document.getElementById(`file-${server.id}`)?.click()} isDisabled={disabled || busy === 'upload'}>
          {busy === 'upload' ? 'Uploading…' : 'Upload'}
        </Button>
      </Tooltip>
      <Button size="sm" color="warning" variant="flat" onPress={() => onAction(server.id, 'prepare')} isDisabled={disabled || busy === 'prepare'}>
        {busy === 'prepare' ? 'Preparing…' : 'Prepare'}
      </Button>
      <Button size="sm" color="success" variant="flat" onPress={() => onAction(server.id, 'start')} isDisabled={disabled || busy === 'start'}>
        {busy === 'start' ? 'Starting…' : 'Start'}
      </Button>
      <Button size="sm" variant="flat" onPress={() => onAction(server.id, 'stop')} isDisabled={disabled || busy === 'stop'}>
        {busy === 'stop' ? 'Stopping…' : 'Stop'}
      </Button>
      <Button size="sm" color="secondary" variant="flat" onPress={() => onAction(server.id, 'restart')} isDisabled={disabled || busy === 'restart'}>
        {busy === 'restart' ? 'Restarting…' : 'Restart'}
      </Button>
      <Button size="sm" variant="bordered" onPress={onEdit}>
        Edit
      </Button>
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button size="sm" color="danger" variant="flat" isDisabled={disabled || busy === 'delete'}>
            Delete
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <div className="p-3 space-y-2 text-sm">
            <div>Delete container only?</div>
            <Button color="danger" size="sm" onPress={onDeleteContainer}>
              Delete container
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
