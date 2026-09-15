import { Plugin, Notice, TAbstractFile, EventRef, normalizePath } from 'obsidian';
import * as fs from 'fs';
import { FolderSyncSettingTab } from './settings';
import { syncAllPairs } from './sync';
import { FolderSyncSettings, DEFAULT_SETTINGS, SyncPair } from './types';

export default class FolderSyncPlugin extends Plugin {
    settings: FolderSyncSettings = DEFAULT_SETTINGS;
    private autoSyncInterval: number | null = null;
    private isSyncing = false;

    private vaultEventRefs: EventRef[] = [];
    private fsWatchers: fs.FSWatcher[] = [];
    private debounceTimer: number | null = null;

    private statusBarItem: HTMLElement | null = null;
    private statusBarClearTimer: number | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();

        // Add settings tab
        this.addSettingTab(new FolderSyncSettingTab(this.app, this));

        // Add command for manual sync
        this.addCommand({
            id: 'folder-sync-manual',
            name: 'Sync all folders now',
            callback: async (): Promise<void> => {
                await this.syncAll(true);
            },
        });

        // Start auto sync if enabled
        if (this.settings.autoSync) {
            this.startAutoSync();
        }
    }

    onunload(): void {
        this.stopAutoSync();
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData() as Partial<FolderSyncSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
        // Fill in defaults for sync pairs saved before `mode` existed
        this.settings.syncPairs = this.settings.syncPairs.map(pair => ({
            ...pair,
            mode: pair.mode ?? 'one-way',
        }));
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    startAutoSync(): void {
        this.stopAutoSync();

        if (this.settings.syncTrigger === 'on-change') {
            this.startWatchers();
        } else {
            this.autoSyncInterval = window.setInterval(() => {
                if (!this.isSyncing) {
                    void this.syncAll(false);
                }
            }, this.settings.syncInterval * 60 * 1000);
        }
    }

    stopAutoSync(): void {
        if (this.autoSyncInterval) {
            window.clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
        this.stopWatchers();
    }

    restartAutoSync(): void {
        this.stopAutoSync();
        this.startAutoSync();
    }

    /**
     * Watch enabled sync pairs' source (vault events) and destination
     * (filesystem) folders, and trigger a debounced sync on any change.
     */
    private startWatchers(): void {
        const onVaultEvent = (file: TAbstractFile) => {
            if (this.isSyncing) return;

            const enabledPairs = this.settings.syncPairs.filter(p => p.enabled);
            const isRelevant = enabledPairs.some(pair => {
                const sourcePath = normalizePath(pair.source);
                return file.path === sourcePath || file.path.startsWith(sourcePath + '/');
            });

            if (isRelevant) this.scheduleDebouncedSync();
        };

        this.vaultEventRefs.push(
            this.app.vault.on('create', onVaultEvent),
            this.app.vault.on('modify', onVaultEvent),
            this.app.vault.on('delete', onVaultEvent),
            this.app.vault.on('rename', onVaultEvent)
        );

        const destinations = new Set(
            this.settings.syncPairs.filter(p => p.enabled).map(p => normalizePath(p.destination))
        );

        for (const destPath of destinations) {
            if (!destPath || !fs.existsSync(destPath)) continue;
            try {
                const watcher = fs.watch(destPath, { recursive: true }, (): void => {
                    if (this.isSyncing) return;
                    this.scheduleDebouncedSync();
                });
                this.fsWatchers.push(watcher);
            } catch {
                // Fail silently - watcher not critical
            }
        }
    }

    private stopWatchers(): void {
        for (const ref of this.vaultEventRefs) {
            this.app.vault.offref(ref);
        }
        this.vaultEventRefs = [];

        for (const watcher of this.fsWatchers) {
            watcher.close();
        }
        this.fsWatchers = [];

        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    private scheduleDebouncedSync(): void {
        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
        }
        const idleMs = Math.max(1, this.settings.syncIdleSeconds) * 1000;
        this.debounceTimer = window.setTimeout(() => {
            this.debounceTimer = null;
            if (!this.isSyncing) {
                void this.syncAll(false);
            }
        }, idleMs);
    }

    private setStatus(text: string, autoClearMs?: number): void {
        if (!this.statusBarItem) return;
        if (this.statusBarClearTimer) {
            window.clearTimeout(this.statusBarClearTimer);
            this.statusBarClearTimer = null;
        }
        this.statusBarItem.setText(text);
        if (autoClearMs) {
            this.statusBarClearTimer = window.setTimeout(() => {
                this.statusBarItem?.setText('');
                this.statusBarClearTimer = null;
            }, autoClearMs);
        }
    }

    /**
     * Run a sync of all enabled pairs.
     * @param announce Show a result Notice even when nothing changed
     *   (used for manually-triggered syncs; auto-triggered syncs stay quiet
     *   unless something actually happened, to avoid Notice spam).
     */
    async syncAll(announce: boolean): Promise<void> {
        if (this.isSyncing) {
            new Notice('Sync is already in progress...');
            return;
        }

        this.isSyncing = true;
        this.setStatus('⏳ Folder sync: syncing...');
        let totalCopied = 0;
        let totalDeleted = 0;
        const allErrors: string[] = [];

        try {
            // Filter enabled pairs
            const enabledPairs = this.settings.syncPairs.filter(p => p.enabled);

            if (enabledPairs.length === 0) {
                if (announce) new Notice('No sync pairs enabled. Add a sync pair in settings.');
                this.setStatus('');
                return;
            }

            // Sync each pair
            const results = await syncAllPairs(this.app.vault, enabledPairs);

            // Aggregate results
            for (const [, result] of results) {
                totalCopied += result.copied;
                totalDeleted += result.deleted;
                if (result.errors.length > 0) {
                    allErrors.push(...result.errors);
                }
            }

            const changed = totalCopied > 0 || totalDeleted > 0 || allErrors.length > 0;

            let summary = `Synced: ${totalCopied} copied, ${totalDeleted} deleted`;
            if (allErrors.length > 0) {
                summary += `, ${allErrors.length} errors`;
            }

            if (announce || changed) {
                new Notice(`Folder sync: ${summary}`);
            }
            this.setStatus(summary, 5000);

        } catch {
            new Notice('Folder sync: sync failed');
            this.setStatus('Folder sync: failed', 5000);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Sync a single pair (exposed for potential future use)
     */
    async syncSinglePair(pair: SyncPair): Promise<void> {
        if (this.isSyncing) {
            new Notice('Sync is already in progress...');
            return;
        }

        this.isSyncing = true;
        try {
            const result = await syncAllPairs(this.app.vault, [pair]);
            const firstResult = result.values().next().value;
            if (firstResult) {
                let message = `${firstResult.copied} copied, ${firstResult.deleted} deleted`;
                if (firstResult.errors.length > 0) {
                    message += `, ${firstResult.errors.length} errors`;
                }
                new Notice(`Sync pair: ${message}`);
            }
        } catch (error: unknown) {
            new Notice(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.isSyncing = false;
        }
    }
}
