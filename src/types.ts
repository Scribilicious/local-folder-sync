export type SyncMode = 'one-way' | 'newer';
export type SyncTrigger = 'interval' | 'on-change';

export interface SyncPair {
    source: string;
    destination: string;
    enabled: boolean;
    /**
     * 'one-way': source overwrites destination; extra destination files are deleted.
     * 'newer': whichever side (source or destination) changed more recently wins;
     * files unique to one side are copied to the other; nothing is ever deleted.
     */
    mode: SyncMode;
}

export interface FolderSyncSettings {
    syncPairs: SyncPair[];
    syncInterval: number; // in minutes, used when syncTrigger === 'interval'
    autoSync: boolean;
    syncTrigger: SyncTrigger;
}

export const DEFAULT_SETTINGS: FolderSyncSettings = {
    syncPairs: [],
    syncInterval: 5,
    autoSync: false,
    syncTrigger: 'on-change',
};
