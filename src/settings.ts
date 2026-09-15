import { App, PluginSettingTab, Setting, normalizePath } from 'obsidian';
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

        new Setting(containerEl).setName('Folder Sync').setHeading();

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
                            const num = parseInt(value, 10);
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

        // Idle delay (only relevant when the trigger is On Change)
        if (this.plugin.settings.syncTrigger === 'on-change') {
            new Setting(containerEl)
                .setName('Sync After Idle (seconds)')
                .setDesc('Wait this long after the last change before syncing')
                .addText(text =>
                    text.setValue(this.plugin.settings.syncIdleSeconds.toString())
                        .onChange(async (value) => {
                            const num = parseInt(value, 10);
                            if (!isNaN(num) && num > 0) {
                                this.plugin.settings.syncIdleSeconds = num;
                                await this.plugin.saveSettings();
                            }
                        })
                );
        }

        containerEl.createEl('hr');

        // Manual sync button
        new Setting(containerEl).setName('Manual Sync').setHeading();
        new Setting(containerEl)
            .addButton(cb => cb
                .setButtonText('Sync Now')
                .setCta()
                .onClick(async () => {
                    cb.setButtonText('Syncing...');
                    cb.setDisabled(true);
                    try {
                        await this.plugin.syncAll(true);
                    } catch {
                        // Error is already handled in syncAll
                    }
                    cb.setButtonText('Sync Now');
                    cb.setDisabled(false);
                })
            );

        containerEl.createEl('hr');

        // Sync Pairs section
        new Setting(containerEl).setName('Sync Folders').setHeading();
        new Setting(containerEl)
            .setName('Add folder pairs to sync. One-way: only source changes reach the destination, and extra destination files are deleted. Newer file wins: whichever side changed most recently is copied to the other side; nothing is ever deleted automatically.')
            .addButton(cb => cb
                .setButtonText('Add Sync Folder')
                .onClick(() => this.addSyncPair())
            );

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
            mode: 'one-way',
        });
        void this.plugin.saveSettings();
        this.refreshAutoSyncIfNeeded();
        this.display(); // Refresh the display
    }

    private removeSyncPair(index: number): void {
        this.plugin.settings.syncPairs.splice(index, 1);
        void this.plugin.saveSettings();
        this.refreshAutoSyncIfNeeded();
        this.display();
    }

    private async getVaultFolders(): Promise<string[]> {
        const folders: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            let listed;
            try {
                listed = await this.app.vault.adapter.list(dir);
            } catch {
                return;
            }
            for (const folder of listed.folders) {
                const normalized = normalizePath(folder);
                const name = normalized.split('/').pop() ?? '';
                if (name.startsWith('.')) {
                    continue;
                }
                folders.push(normalized);
                await walk(normalized);
            }
        };
        await walk('');
        return folders.sort((a, b) => a.localeCompare(b));
    }

    private createSyncPairSetting(container: HTMLElement, pair: SyncPair, index: number): void {
        const pairEl = container.createDiv({ cls: 'sync-folder-setting' });
        new Setting(pairEl).setName(`Sync Folder #${index + 1}`).setHeading();

        // Source path (dropdown of existing vault folders)
        new Setting(pairEl)
            .setName('Source')
            .setDesc('Obsidian folder to sync')
            .addDropdown(dropdown => {
                dropdown.addOption('', 'Select a folder...');
                if (pair.source) {
                    dropdown.addOption(pair.source, pair.source);
                }
                dropdown.setValue(pair.source);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.syncPairs[index]!.source = value;
                    await this.plugin.saveSettings();
                    this.refreshAutoSyncIfNeeded();
                });

                void this.getVaultFolders().then(folders => {
                    dropdown.selectEl.empty();
                    dropdown.addOption('', 'Select a folder...');
                    for (const folder of folders) {
                        dropdown.addOption(folder, folder);
                    }
                    if (pair.source && !folders.includes(pair.source)) {
                        dropdown.addOption(pair.source, pair.source);
                    }
                    dropdown.setValue(pair.source);
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
            })

        // Remove button
        new Setting(pairEl)
            .addButton(cb => cb
                .setButtonText('Remove')
                .onClick(() => this.removeSyncPair(index))
            );
    }
}
