# Folder Sync Plugin - Development Guide for AI Agents

## Overview

This is an Obsidian plugin for one-way folder synchronization. It syncs files from Obsidian vault folders to external directories, supporting multiple folder pairs.

## Project Structure

```
local-folder-sync/
├── src/
│   ├── main.ts        # Plugin lifecycle, auto-sync management
│   ├── settings.ts    # Settings UI (PluginSettingTab)
│   ├── sync.ts        # Core sync logic (file operations)
│   ├── types.ts       # TypeScript interfaces and defaults
│   ├── manifest.json  # Plugin metadata
│   └── styles.css     # Custom CSS for settings
├── esbuild.config.mjs # Bundles src/ into a single dist/main.js
├── package.json       # Node.js dependencies
├── tsconfig.json      # TypeScript configuration (type-checking only)
├── README.md          # User documentation
└── .gitignore         # Git ignore rules
```

## Key Interfaces

### SyncPair (src/types.ts)
- `source`: string - Vault-relative path (e.g., "Notes/Project")
- `destination`: string - Absolute filesystem path (e.g., "/Users/name/Backup")
- `enabled`: boolean - Whether this pair is active
- `mode`: `'one-way' | 'newer'` - `one-way`: source overwrites destination, extra
  destination files are deleted. `newer`: two-way, whichever side changed most
  recently wins; files unique to one side are copied to the other; nothing is
  ever deleted automatically.

### FolderSyncSettings (src/types.ts)
- `syncPairs`: SyncPair[] - All configured sync pairs
- `syncInterval`: number - Auto-sync interval in minutes (used when `syncTrigger` is `interval`)
- `autoSync`: boolean - Whether auto-sync is enabled
- `syncTrigger`: `'interval' | 'on-change'` - How auto-sync is triggered. `on-change`
  watches vault events for source folders and `fs.watch` for destination folders
  (debounced ~1.5s), instead of a timer.

## Development Conventions

### Coding Style
- **TypeScript**: Strict mode enabled
- **Naming**: camelCase for variables/functions, PascalCase for classes/interfaces
- **Imports**: Group by source (obsidian, node, local)
- **Error handling**: Use try/catch, collect errors, don't crash entire sync

### File Organization
- **main.ts**: Plugin class extending `Plugin` - handles lifecycle, commands, auto-sync
- **settings.ts**: `PluginSettingTab` subclass - manages settings UI
- **sync.ts**: Pure functions for sync operations - no side effects on settings
- **types.ts**: All TypeScript interfaces and constants

### Obsidian API Usage
- Use `this.app.vault` for file operations in vault
- Use `this.addSettingTab()` to register settings
- Use `this.addCommand()` to register commands
- Use `new Notice()` for user notifications
- Use `normalizePath()` for cross-platform path handling

### Filesystem Operations
- Use Node.js `fs` module for external filesystem operations
- Use `path` module for path manipulation
- Always check if directories exist before creating
- Use `recursive: true` for mkdir to create parent directories

## Build Process

```bash
# Install dependencies (once)
npm install

# Development build (watches for changes)
npm run dev

# Production build
npm run build
```

Build output (a single bundled `main.js`, plus copied `manifest.json`/`styles.css`)
goes to `dist/`. Copy `dist/`'s contents into the plugin's folder under
`<vault>/.obsidian/plugins/local-folder-sync/` to install/update it - Obsidian
does not read from `dist/` directly.

## Testing Instructions

1. Build the plugin: `npm run build`
2. In Obsidian: Enable plugin under Settings > Community plugins > Folder Sync
3. Configure sync pairs in plugin settings
4. Test with:
   - Adding/removing files in source
   - Modifying files in source
   - Deleting files in source (should delete in destination)
   - Multiple sync pairs simultaneously
   - Auto-sync with different intervals

## Important Notes for Development

### Sync Modes
- Each pair has its own `mode`, chosen in settings: `one-way` or `newer`
- `one-way`: source → destination only. Files in destination that don't exist
  in source are DELETED (cleanup). Changes in destination are IGNORED.
- `newer`: two-way. Whichever side (source or destination) has the more recent
  mtime wins for files present on both sides; files unique to one side are
  copied to the other. This mode NEVER deletes — a missing file is always
  treated as "needs to be copied", never as "was deleted, so remove it".
- `syncAllPairs` also skips (with an error, not silently) any pair whose
  destination overlaps (same or nested) with another enabled pair's destination,
  since two pairs writing/cleaning the same folder could delete each other's files.

### Auto Sync Triggers
- `interval`: the existing timer-based auto-sync (`syncInterval` minutes)
- `on-change`: `FolderSyncPlugin.startWatchers()` registers vault event
  listeners (`create`/`modify`/`delete`/`rename`) filtered to enabled pairs'
  source folders, plus one `fs.watch(destPath, {recursive: true})` per unique
  enabled destination. Any event schedules a debounced `syncAll()` (~1.5s).
  Watcher/event handlers bail out early while `isSyncing` is true, to avoid
  the sync's own writes re-triggering itself.
- Changing pairs (add/remove/enable/source/destination) in settings while
  auto-sync + on-change is active calls `restartAutoSync()` to refresh watchers.

### Path Handling
- Source paths: relative to vault root, use forward slashes
- Destination paths: absolute filesystem paths
- Use `normalizePath()` from obsidian for cross-platform compatibility

### Error Handling
- Sync should continue even if individual files fail
- Collect all errors and report at the end
- Log errors to console for debugging
- Show user-friendly summary with counts

### Concurrency
- Prevent concurrent syncs with `isSyncing` flag
- Auto-sync checks this flag before starting
- Manual sync also checks and shows notice if busy

### Desktop Only
- This plugin uses Node.js `fs` module
- Set `isDesktopOnly: true` in manifest.json
- Won't work in mobile/web versions of Obsidian

## Common Tasks

### Adding a New Setting
1. Add property to `FolderSyncSettings` interface in types.ts
2. Add default value to `DEFAULT_SETTINGS` in types.ts
3. Add UI control in `display()` method in settings.ts
4. Use the setting value in main.ts or sync.ts as needed

### Adding a New Command
1. In main.ts `onload()`: `this.addCommand({ id, name, callback })`
2. Implement callback as async function
3. Show user feedback with `new Notice()`

### Modifying Sync Logic
1. Edit functions in sync.ts
2. Ensure one-way sync direction is maintained
3. Test edge cases: empty folders, special characters in filenames, large files
4. Consider performance for many files

## File Modifications

When modifying files:
- **main.ts**: Add commands, lifecycle hooks, auto-sync logic
- **settings.ts**: Add/remove setting controls, validate inputs
- **sync.ts**: Modify file copy/delete behavior, add filters
- **types.ts**: Add new interfaces, change defaults
- **manifest.json**: Update version, description when releasing

## Dependencies

- `obsidian`: Latest (from npm)
- `@types/node`: For Node.js type definitions (fs, path modules)
- `typescript`: For type-checking
- `esbuild`: Bundles `src/main.ts` and all local imports into a single `dist/main.js`
  — **required** because Obsidian's plugin loader does not resolve relative
  `require()`s between separate plugin files; see `esbuild.config.mjs`.

## Known Limitations

1. **Large files**: No chunking or streaming - entire file loaded into memory.
2. **Permissions**: No special handling for permission errors.
3. **Conflicts**: `newer` mode resolves conflicts by mtime comparison only - no
   3-way merge or content-diff conflict detection.
4. **`on-change` recursive fs.watch**: Node's `{recursive: true}` option for
   watching the destination folder isn't supported on all platforms (notably
   older Linux); failures there are caught and logged, not fatal, but changes
   in that destination won't trigger auto-sync.

## Future Enhancements (Possible)

If requested, consider adding:
- [ ] File filtering by extension/pattern
- [ ] Skip delete option (don't cleanup destination)
- [ ] Dry run mode (show what would change)
- [ ] Sync history/log
- [ ] Individual sync pair commands
- [ ] Progress indicators for large syncs
- [ ] Exclude patterns (.gitignore style)
- [ ] Binary file support
