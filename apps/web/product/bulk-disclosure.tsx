import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { InfoHelp } from './components/ui';
import { settingHelp } from './setting-help';

export function BulkDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false), id = useId();
  const help = settingHelp(title);
  return <>
    <h4 className="setting-heading bulk-disclosure-heading">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : undefined} />{title}
      </button>
      {help && <InfoHelp title={title}>{help}</InfoHelp>}
    </h4>
    <div id={id} data-bulk-disclosure hidden={!open}>{children}</div>
  </>;
}
