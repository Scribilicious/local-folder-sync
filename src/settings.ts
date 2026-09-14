import { App, PluginSettingTab, Setting } from 'obsidian';
import type FolderSyncPlugin from './main';
import { SyncMode, SyncPair, SyncTrigger } from './types';

export class FolderSyncSettingTab extends PluginSettingTab {
    plugin: FolderSyncPlugin;

    constructor(app: App, plugin: FolderSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('folder-sync-settings');

        containerEl.createEl('h2', { text: 'Folder Sync Settings' });

        // Auto sync toggle
        new Setting(containerEl)
            .setName('Auto Sync')
            .setDesc('Automatically sync folders, either on an interval or when files change')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.autoSync)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSync = value;
                        await this.plugin.saveSettings();
                        if (value) {
                            this.plugin.startAutoSync();
                        } else {
                            this.plugin.stopAutoSync();
                        }
                    })
            );

        // Auto sync trigger
        new Setting(containerEl)
            .setName('Auto Sync Trigger')
            .setDesc('Interval: sync periodically. On Change: sync automatically when a file changes in a sync pair\'s source or destination folder.')
            .addDropdown(dropdown =>
                dropdown
                    .addOption('interval', 'Interval')
                    .addOption('on-change', 'On Change')
                    .setValue(this.plugin.settings.syncTrigger)
                    .onChange(async (value) => {
                        this.plugin.settings.syncTrigger = value as SyncTrigger;
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.autoSync) {
                            this.plugin.restartAutoSync();
                        }
                        this.display(); // Refresh so the interval field shows/hides
                    })
            );

        // Sync interval (only relevant when the trigger is Interval)
        if (this.plugin.settings.syncTrigger === 'interval') {
            new Setting(containerEl)
                .setName('Sync Interval (minutes)')
                .setDesc('How often to sync')
                .addText(text =>
                    text.setValue(this.plugin.settings.syncInterval.toString())
                        .onChange(async (value) => {
                            const num = parseInt(value);
                            if (!isNaN(num) && num > 0) {
                                this.plugin.settings.syncInterval = num;
                                await this.plugin.saveSettings();
                                if (this.plugin.settings.autoSync) {
                                    this.plugin.restartAutoSync();
                                }
                            }
                        })
                );
        }

        containerEl.createEl('hr');

        // Manual sync button
        containerEl.createEl('h3', { text: 'Manual Sync' });
        const syncBtn = containerEl.createEl('button', {
            text: 'Sync Now',
            cls: 'mod-cta',
        });
        syncBtn.addEventListener('click', async () => {
            syncBtn.disabled = true;
            syncBtn.textContent = 'Syncing...';

            try {
                await this.plugin.syncAll(true);
            } catch (error) {
                // Error is already handled in syncAll
            }

            syncBtn.disabled = false;
            syncBtn.textContent = 'Sync Now';
        });

        containerEl.createEl('hr');

        // Sync Pairs section
        containerEl.createEl('h3', { text: 'Sync Folders' });
        containerEl.createEl('p', {
            text: 'Add folder pairs to sync. One-way: only source changes reach the destination, and extra ' +
                'destination files are deleted. Newer file wins: whichever side changed most recently is ' +
                'copied to the other side; nothing is ever deleted automatically.'
        });

        const addButton = containerEl.createEl('button', {
            text: 'Add Sync Folder',
        });
        addButton.addEventListener('click', () => {
            this.addSyncPair();
        });

        // List existing sync pairs
        const listEl = containerEl.createDiv({ cls: 'sync-folder-list' });
        this.plugin.settings.syncPairs.forEach((pair, index) => {
            this.createSyncPairSetting(listEl, pair, index);
        });
    }

    private refreshAutoSyncIfNeeded(): void {
        if (this.plugin.settings.autoSync && this.plugin.settings.syncTrigger === 'on-change') {
            this.plugin.restartAutoSync();
        }
    }

    private addSyncPair(): void {
        this.plugin.settings.syncPairs.push({
            source: '',
            destination: '',
            enabled: false,
            mode: 'newer',
        });
        this.plugin.saveSettings();
        this.refreshAutoSyncIfNeeded();
        this.display(); // Refresh the display
    }

    private removeSyncPair(index: number): void {
        this.plugin.settings.syncPairs.splice(index, 1);
        this.plugin.saveSettings();
        this.refreshAutoSyncIfNeeded();
        this.display();
    }

    private createSyncPairSetting(container: HTMLElement, pair: SyncPair, index: number): void {
        const pairEl = container.createDiv({ cls: 'sync-folder-setting' });
        pairEl.createEl('h4', { text: `Sync Folder #${index + 1}` });

        // Source path
        new Setting(pairEl)
            .setName('Source')
            .setDesc('Obsidian folder path (relative to vault root, e.g., "Notes/Project")')
            .addText(text => {
                text.setValue(pair.source);
                text.inputEl.placeholder = 'e.g., Notes/Project';
                text.onChange(async (value) => {
                    this.plugin.settings.syncPairs[index]!.source = value;
                    await this.plugin.saveSettings();
                    this.refreshAutoSyncIfNeeded();
                });
            });

        // Destination path
        new Setting(pairEl)
            .setName('Destination')
            .setDesc('Local drive folder path (absolute path)')
            .addText(text => {
                text.setValue(pair.destination);
                text.inputEl.placeholder = 'e.g., /Users/Jens/Documents/Backup';
                text.onChange(async (value) => {
                    this.plugin.settings.syncPairs[index]!.destination = value;
                    await this.plugin.saveSettings();
                    this.refreshAutoSyncIfNeeded();
                });
            });

        // Sync mode
        new Setting(pairEl)
            .setName('Sync Mode')
            .setDesc('One-way (source → destination) or Newer file wins (two-way, never deletes)')
            .addDropdown(dropdown => {
                dropdown
                    .addOption('one-way', 'One-way (source → destination)')
                    .addOption('newer', 'Newer file wins (two-way)')
                    .setValue(pair.mode)
                    .onChange(async (value) => {
                        this.plugin.settings.syncPairs[index]!.mode = value as SyncMode;
                        await this.plugin.saveSettings();
                    });
            });

        // Enabled toggle
        new Setting(pairEl)
            .setName('Enabled')
            .setDesc('Enable/disable this sync folder')
            .addToggle(toggle => {
                toggle.setValue(pair.enabled);
                toggle.onChange(async (value) => {
                    this.plugin.settings.syncPairs[index]!.enabled = value;
                    await this.plugin.saveSettings();
                    this.refreshAutoSyncIfNeeded();
                });
            });

        // Remove button
        const removeBtn = pairEl.createEl('button', {
            text: 'Remove',
            cls: 'sync-folder-remove-btn',
        });
        removeBtn.addEventListener('click', () => this.removeSyncPair(index));
    }
}
