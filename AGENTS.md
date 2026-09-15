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

---

## Obsidian Community Hub Submission Guide

### Prerequisites for Submission

Before submitting to the Obsidian Community Hub, ensure the following:

#### manifest.json Requirements
- **id**: Unique plugin identifier (e.g., `local-folder-sync`)
- **name**: Plugin display name (must match README title)
- **version**: Follows Semantic Versioning (x.y.z format)
- **minAppVersion**: Set to the minimum Obsidian version that supports all used APIs
  - `1.5.0` or higher if using `ButtonComponent.setDisabled()` or `setButtonText()`
- **description**: Must NOT contain the word "Obsidian" (it's implied by context)
- **isDesktopOnly**: Must be `true` for plugins using Node.js modules (fs, path, etc.)

#### README.md Requirements
- **Title**: Must match the `name` field in manifest.json exactly
  - Good: `# Local Folder Sync` (matches manifest name)
  - Bad: `# Obsidian Folder Sync Plugin` (contains "Obsidian", doesn't match)

#### Settings UI Requirements
- **Headings**: Use `new Setting(containerEl).setName('Heading Text').setHeading()`
  - Do NOT use `containerEl.createEl('h2', { text: '...' })` or similar
  - Do NOT use the word "Settings" in heading text (e.g., use "Folder Sync" not "Folder Sync Settings")
- **Buttons**: Use `new Setting(containerEl).addButton(cb => cb.setButtonText(...).onClick(...))`
  - Avoid raw `createEl('button', ...)` calls

#### Timer/Interval Compatibility
- **Popout windows**: Use `window.setInterval()`, `window.clearInterval()`, `window.setTimeout()`, `window.clearTimeout()`
  - Do NOT use the global `setInterval()`, `clearInterval()`, etc.
- **Types**: Use `number` for timer IDs (not `NodeJS.Timeout`) since window methods return numbers

#### Console Logging
- **Avoid**: Remove or minimize `console.log()`, `console.error()`, `console.warn()` calls
- **Reason**: Obsidian Hub flags unnecessary logging as warnings

#### Type Safety
- **Explicit return types**: Add `: Promise<void>` to async methods
- **Error handling**: Use `catch` without parameters or `catch (error: unknown)` to avoid type issues
- **Avoid**: Using `any` type or error types that override other types in unions

### Creating a New Release

#### Step 1: Prepare the Code
```bash
# Bump version in manifest.json
# Edit src/manifest.json and change "version" field

# Build the plugin
npm run build

# Verify main.js was created (should be in project root)
ls -la main.js
```

#### Step 2: Commit and Tag
```bash
# Commit all changes
git add manifest.json src/
git commit -m "Bump version to X.Y.Z"

# Create annotated tag (without 'v' prefix)
git tag -a X.Y.Z -m "Version X.Y.Z"

# Push to GitHub
git push origin main
git push origin X.Y.Z
```

**Important**: The tag name must match the version in manifest.json exactly (e.g., `1.0.3`, not `v1.0.3`).

#### Step 3: Create GitHub Release
1. Go to: `https://github.com/OWNER/REPO/releases`
2. Click "Draft a new release"
3. **Tag version**: Select the tag you created (e.g., `1.0.3`)
4. **Release title**: Enter the version number (e.g., `1.0.3`)
5. **Description**: Add release notes explaining what changed
6. **Attach assets**: Drag and drop these files from your project root:
   - `main.js` (required - the built plugin bundle)
   - `manifest.json` (required - must match the release version)
   - `styles.css` (optional - custom styles)
7. Click "Publish release"

**Critical**: The release tag MUST match the version in manifest.json. If manifest says `1.0.3`, the tag must be `1.0.3`.

### Common Obsidian Hub Errors and Fixes

| Error | Location | Fix |
|-------|----------|-----|
| Plugin description must not include "Obsidian" | manifest.json | Remove "Obsidian" from description |
| isDesktopOnly should be true | manifest.json | Set to `true` if using Node.js modules |
| README title doesn't match manifest name | README.md | Make title match manifest.name exactly |
| Uses createEl for headings | settings.ts | Use `new Setting().setName().setHeading()` |
| Avoid using "Settings" in settings headings | settings.ts | Remove "Settings" word from headings |
| Uses APIs newer than minAppVersion | Any file | Update minAppVersion in manifest.json |
| Uses setInterval without window. | main.ts | Use `window.setInterval()` |
| Unnecessary console logging | Any file | Remove console.log/error calls |
| Promise-returning method where void expected | main.ts | Add `: Promise<void>` return type |

### Release Checklist

- [ ] manifest.json version is correct (x.y.z format)
- [ ] manifest.json description doesn't contain "Obsidian"
- [ ] manifest.json isDesktopOnly is true (if using Node.js)
- [ ] manifest.json minAppVersion supports all used APIs
- [ ] README.md title matches manifest.json name
- [ ] Settings use `new Setting().setName().setHeading()` for headings
- [ ] Settings don't use "Settings" in heading text
- [ ] All timers use window.* variants (setInterval, setTimeout, etc.)
- [ ] Timer variables are typed as `number | null` (not NodeJS.Timeout)
- [ ] Async methods have explicit `: Promise<void>` return types
- [ ] Console logging is minimized/removed
- [ ] Tag exists and matches manifest version (without 'v' prefix)
- [ ] main.js is built and tested
- [ ] GitHub release exists with correct tag
- [ ] GitHub release has main.js and manifest.json attached as assets
