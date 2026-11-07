export type SyncMode = 'one-way' | 'newer';
export type SyncTrigger = 'interval' | 'on-change';
/**
 * How to sync files embedded in markdown notes (e.g. `![[image.png]]`):
 * - 'auto': copy them next to their note only when Obsidian stores new
 *   attachments somewhere other than the note's own folder
 *   (Files & links → Default location for new attachments).
 * - 'always': always copy them next to their note, regardless of that setting.
 * - 'never': never follow embedded files; sync only what lives in the source folder.
 */
export type EmbedSyncMode = 'auto' | 'always' | 'never';

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
    embedSyncMode: EmbedSyncMode;
}

export interface FolderSyncSettings {
    syncPairs: SyncPair[];
    syncInterval: number; // in minutes, used when syncTrigger === 'interval'
    syncIdleSeconds: number; // seconds of no changes before an 'on-change' sync fires
    autoSync: boolean;
    syncTrigger: SyncTrigger;
}

export const DEFAULT_SYNC_PAIR: SyncPair = {
    source: '',
    destination: '',
    enabled: false,
    mode: 'newer',
    embedSyncMode: 'auto',
};

export const DEFAULT_SETTINGS: FolderSyncSettings = {
    syncPairs: [],
    syncInterval: 5,
    syncIdleSeconds: 120,
    autoSync: false,
    syncTrigger: 'on-change',
};
