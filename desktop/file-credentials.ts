import type { FileCredentialStorage } from '../server/credentials.ts';

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export function fileCredentialStorage(safeStorage: SafeStorage, platform: NodeJS.Platform): FileCredentialStorage {
  return {
    available: () => safeStorage.isEncryptionAvailable() &&
      (platform === 'win32' || platform === 'darwin' ||
        (platform === 'linux' && ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend()))),
    encrypt: password => safeStorage.encryptString(password),
    decrypt: encrypted => safeStorage.decryptString(encrypted),
  };
}
