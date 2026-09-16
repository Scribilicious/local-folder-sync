import {
    App,
    PluginSettingTab,
    SettingDefinitionGroup,
    SettingDefinitionItem,
    SettingDefinitionRender,
    normalizePath,
} from 'obsidian';
import type FolderSyncPlugin from './main';
import { SyncMode, SyncPair, SyncTrigger } from './types';

export class FolderSyncSettingTab extends PluginSettingTab {
    plugin: FolderSyncPlugin;

    constructor(app: App, plugin: FolderSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const items: SettingDefinitionItem[] = [];

        const autoSyncItems: SettingDefinitionRender[] = [
            this.row('Auto sync', 'Automatically sync folders, either on an interval or when files change', setting => {
                setting.addToggle(toggle =>
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
            }),
            this.row(
                'Auto sync trigger',
                "Interval: sync periodically. On change: sync automatically when a file changes in a sync pair's source or destination folder.",
                setting => {
                    setting.addDropdown(dropdown =>
                        dropdown
                            .addOption('interval', 'Interval')
                            .addOption('on-change', 'On change')
                            .setValue(this.plugin.settings.syncTrigger)
                            .onChange(async (value) => {
                                this.plugin.settings.syncTrigger = value as SyncTrigger;
                                await this.plugin.saveSettings();
                                if (this.plugin.settings.autoSync) {
                                    this.plugin.restartAutoSync();
                                }
                                this.update(); // Refresh so the interval/idle field shows/hides
                            })
                    );
                }
            ),
        ];

        if (this.plugin.settings.syncTrigger === 'interval') {
            autoSyncItems.push(
                this.row('Sync interval (minutes)', 'How often to sync', setting => {
                    setting.addText(text =>
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
                })
            );
        }

        if (this.plugin.settings.syncTrigger === 'on-change') {
            autoSyncItems.push(
                this.row('Sync after idle (seconds)', 'Wait this long after the last change before syncing', setting => {
                    setting.addText(text =>
                        text.setValue(this.plugin.settings.syncIdleSeconds.toString())
                            .onChange(async (value) => {
                                const num = parseInt(value, 10);
                                if (!isNaN(num) && num > 0) {
                                    this.plugin.settings.syncIdleSeconds = num;
                                    await this.plugin.saveSettings();
                                }
                            })
                    );
                })
            );
        }

        items.push({
            type: 'group',
            cls: 'folder-sync-settings',
            heading: 'Folder sync',
            items: autoSyncItems,
        });

        items.push({
            type: 'group',
            cls: 'folder-sync-settings',
            heading: 'Manual sync',
            items: [
                this.row('Sync now', undefined, setting => {
                    setting.addButton(cb => cb
                        .setButtonText('Sync now')
                        .setCta()
                        .onClick(async () => {
                            cb.setButtonText('Syncing...');
                            cb.setDisabled(true);
                            try {
                                await this.plugin.syncAll(true);
                            } catch {
                                // Error is already handled in syncAll
                            }
                            cb.setButtonText('Sync now');
                            cb.setDisabled(false);
                        })
                    );
                }),
            ],
        });

        items.push({
            type: 'group',
            cls: 'folder-sync-settings',
            heading: 'Sync folders',
            items: [
                this.row(
                    'Add sync folder',
                    'Add folder pairs to sync. One-way: only source changes reach the destination, and extra ' +
                    'destination files are deleted. Newer file wins: whichever side changed most recently is ' +
                    'copied to the other side; nothing is ever deleted automatically.',
                    setting => {
                        setting.addButton(cb => cb
                            .setButtonText('Add sync folder')
                            .onClick(() => this.addSyncPair())
                        );
                    }
                ),
            ],
        });

        this.plugin.settings.syncPairs.forEach((pair, index) => {
            items.push(this.buildSyncPairGroup(pair, index));
        });

        return items;
    }

    private row(
        name: string,
        desc: string | undefined,
        render: SettingDefinitionRender['render']
    ): SettingDefinitionRender {
        return { name, desc, render };
    }

    private buildSyncPairGroup(pair: SyncPair, index: number): SettingDefinitionGroup {
        return {
            type: 'group',
            cls: 'sync-folder-setting',
            heading: `Sync folder #${index + 1}`,
            items: [
                // Source path (dropdown of existing vault folders)
                this.row('Source', 'Obsidian folder to sync', setting => {
                    setting.addDropdown(dropdown => {
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
                }),

                // Destination path
                this.row('Destination', 'Local drive folder path (absolute path)', setting => {
                    setting.addText(text => {
                        text.setValue(pair.destination);
                        text.inputEl.placeholder = 'e.g., /Users/Jens/Documents/Backup';
                        text.onChange(async (value) => {
                            this.plugin.settings.syncPairs[index]!.destination = value;
                            await this.plugin.saveSettings();
                            this.refreshAutoSyncIfNeeded();
                        });
                    });
                }),

                // Sync mode
                this.row('Sync mode', 'One-way (source → destination) or newer file wins (two-way, never deletes)', setting => {
                    setting.addDropdown(dropdown => {
                        dropdown
                            .addOption('one-way', 'One-way (source → destination)')
                            .addOption('newer', 'Newer file wins (two-way)')
                            .setValue(pair.mode)
                            .onChange(async (value) => {
                                this.plugin.settings.syncPairs[index]!.mode = value as SyncMode;
                                await this.plugin.saveSettings();
                            });
                    });
                }),

                // Enabled toggle
                this.row('Enabled', 'Enable/disable this sync folder', setting => {
                    setting.addToggle(toggle => {
                        toggle.setValue(pair.enabled);
                        toggle.onChange(async (value) => {
                            this.plugin.settings.syncPairs[index]!.enabled = value;
                            await this.plugin.saveSettings();
                            this.refreshAutoSyncIfNeeded();
                        });
                    });
                }),

                // Remove button
                this.row('Remove', undefined, setting => {
                    setting.addButton(cb => cb
                        .setButtonText('Remove')
                        .onClick(() => this.removeSyncPair(index))
                    );
                }),
            ],
        };
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
        this.update(); // Refresh to show the new sync folder
    }

    private removeSyncPair(index: number): void {
        this.plugin.settings.syncPairs.splice(index, 1);
        void this.plugin.saveSettings();
        this.refreshAutoSyncIfNeeded();
        this.update();
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
}
