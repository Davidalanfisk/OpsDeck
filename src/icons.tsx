import type { SVGProps } from 'react';

type IconName = 'folder' | 'file' | 'link' | 'terminal' | 'note' | 'window' | 'maximize' | 'restore' | 'close' | 'download';
const paths: Record<IconName, string> = {
  folder: 'M3 5h6l2 2h10v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5z',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4',
  link: 'M10 13a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1 M14 11a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1',
  terminal: 'M3 5h18v14H3z M6 9l3 3-3 3 M11 15h5',
  note: 'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5',
  window: 'M3 4h18v16H3z M3 8h18',
  maximize: 'M5 5h14v14H5z',
  restore: 'M8 5h11v11 M5 8h11v11H5z',
  close: 'M6 6l12 12 M18 6L6 18',
  download: 'M12 3v12 M8 11l4 4 4-4 M4 17v3h16v-3',
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
    <path d={paths[name]} />
  </svg>;
}
