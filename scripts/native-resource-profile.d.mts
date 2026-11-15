export type NativeResourceProfile = {
 name: 'standard-2';
 scope: 'prepared-snapshot' | 'http' | 'registered';
 staff: 101 | 500;
 nanoCpus: number;
 memoryBytes: number;
 dockerArgs: string[];
 diskLimited: false;
};
export function nativeResourceProfile(env: Record<string, string | undefined>): NativeResourceProfile | null;
