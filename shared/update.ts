export type UpdateStatus = {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'installing' | 'ready' | 'error';
  current: string;
  supported: boolean;
  latest?: string;
  detail: string;
};

export function compareVersions(left: string, right: string) {
  const parse = (value: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Invalid update version.');
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid update version.');
    return parts;
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}
