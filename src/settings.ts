import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import type FolderSyncPlugin from './main';
import { SyncMode } from './types';

export class FolderSyncSettingTab extends PluginSettingTab {
    plugin: FolderSyncPlugin;

    constructor(app: App, plugin: FolderSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const definitions: SettingDefinitionItem[] = [];

        // Auto sync group
        definitions.push({
            type: 'group',
            heading: 'Auto sync',
            items: [
                {
                    name: 'Auto sync',
                    desc: 'Automatically sync folders, either on an interval or when files change',
                    control: { type: 'toggle', key: 'autoSync' },
                },
                {
                    name: 'Auto sync trigger',
                    desc: 'Interval: sync periodically. On change: sync automatically when a file changes in a sync pair\'s source or destination folder.',
                    control: {
                        type: 'dropdown',
                        key: 'syncTrigger',
                        options: { interval: 'Interval', 'on-change': 'On change' },
                    },
                },
                {
                    name: 'Sync interval (minutes)',
                    desc: 'How often to sync',
                    control: { type: 'number', key: 'syncInterval' },
                    visible: () => this.plugin.settings.syncTrigger === 'interval',
                },
            ],
        });

        // Manual sync button
        definitions.push({
            name: 'Manual sync',
        } as const);

        definitions.push({
            name: 'Sync now',
            desc: 'Sync all folders now',
            action: () => { void this.plugin.syncAll(true); },
        } as const);

        // Sync pairs list - use custom render for each pair
        const syncPairsItems = this.plugin.settings.syncPairs.map((pair, index) => ({
            name: `Sync folder #${index + 1}`,
            render: (setting: Setting) => {
                const container = setting.settingEl.createDiv({ cls: 'sync-folder-setting' });
                new Setting(container).setName(`Sync folder #${index + 1}`).setHeading();

                // Source
                new Setting(container)
                    .setName('Source')
                    .setDesc('Obsidian folder path (relative to vault root)')
                    .addText(text => {
                        text.setValue(pair.source);
                        text.inputEl.placeholder = 'E.g., notes/project';
                        text.onChange(async (value) => {
                            this.plugin.settings.syncPairs[index] = { ...pair, source: value };
                            await this.plugin.saveSettings();
                            this.refreshAutoSyncIfNeeded();
                        });
                    });

                // Destination
                new Setting(container)
                    .setName('Destination')
                    .setDesc('Local drive folder path (absolute path)')
                    .addText(text => {
                        text.setValue(pair.destination);
                        text.inputEl.placeholder = 'E.g., /users/jens/documents/backup';
                        text.onChange(async (value) => {
                            this.plugin.settings.syncPairs[index] = { ...pair, destination: value };
                            await this.plugin.saveSettings();
                            this.refreshAutoSyncIfNeeded();
                        });
                    });

                // Sync mode
                new Setting(container)
                    .setName('Sync mode')
                    .setDesc('One-way (source -> destination) or newer file wins (two-way, never deletes)')
                    .addDropdown(dropdown => {
                        dropdown
                            .addOption('one-way', 'One-way (source -> destination)')
                            .addOption('newer', 'Newer file wins (two-way)')
                            .setValue(pair.mode)
                            .onChange(async (value) => {
                                this.plugin.settings.syncPairs[index] = { ...pair, mode: value as SyncMode };
                                await this.plugin.saveSettings();
                            });
                    });

                // Enabled
                new Setting(container)
                    .setName('Enabled')
                    .setDesc('Enable/disable this sync folder')
                    .addToggle(toggle => {
                        toggle.setValue(pair.enabled);
                        toggle.onChange(async (value) => {
                            this.plugin.settings.syncPairs[index] = { ...pair, enabled: value };
                            await this.plugin.saveSettings();
                            this.refreshAutoSyncIfNeeded();
                        });
                    });
            },
            action: () => { /* remove */ },
            searchable: false,
        }));

        definitions.push({
            type: 'list',
            heading: 'Sync folders',
            emptyState: 'No sync folders configured',
            onDelete: (idx: number) => {
                this.plugin.settings.syncPairs.splice(idx, 1);
                void this.plugin.saveSettings();
                this.refreshAutoSyncIfNeeded();
                this.update();
            },
            addItem: {
                name: 'Add sync folder',
                action: () => {
                    this.plugin.settings.syncPairs.push({ source: '', destination: '', enabled: false, mode: 'newer' });
                    void this.plugin.saveSettings();
                    this.refreshAutoSyncIfNeeded();
                    this.update();
                },
            },
            items: syncPairsItems as never,
        } as never);

        return definitions;
    }

    getControlValue(key: string): unknown {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        return settings[key];
    }

    setControlValue(key: string, value: unknown): void | Promise<void> {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        settings[key] = value;
        return this.plugin.saveSettings();
    }

    private refreshAutoSyncIfNeeded(): void {
        if (this.plugin.settings.autoSync && this.plugin.settings.syncTrigger === 'on-change') {
            this.plugin.restartAutoSync();
        }
    }
}
