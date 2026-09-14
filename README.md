# Local Folder Sync

A plugin that syncs vault folders to external directories, one-way or two-way per folder pair.

## Features

- **Two sync modes, per pair**:
  - **One-way**: Files are copied FROM the source folder TO the destination folder,
    and destination files no longer in source are deleted (cleanup).
  - **Newer file wins**: Two-way sync. Whichever side (source or destination)
    changed most recently is copied to the other side. Files unique to one side
    are copied to the other. Nothing is ever deleted automatically.
- **Multiple folder pairs**: Add and manage multiple source-destination pairs, each with its own mode
- **Auto-sync**: Automatically sync on an interval, or on-change (as soon as a file changes)
- **Manual sync**: Trigger sync via the command palette, the settings button, or the status bar indicator
- **Sync status**: A status bar item shows when a sync is running and its result

## Installation

### Development Setup

1. Clone or copy this project anywhere (it does **not** need to live inside your vault):
   ```
   git clone <repo> local-folder-sync
   ```

2. Install dependencies and build:
   ```bash
   cd local-folder-sync
   npm install
   npm run build
   ```
   This produces a single bundled `dist/main.js`, plus `dist/manifest.json` and `dist/styles.css`.
   (Obsidian's plugin loader requires one bundled file — it can't `require()` between separate
   plugin files — so `npm run dev`/`npm run build` always emit one bundle, not the raw TypeScript output.)

3. Copy `dist/`'s contents into your vault's plugin folder:
   ```bash
   mkdir -p "<vault>/.obsidian/plugins/local-folder-sync"
   cp dist/main.js dist/manifest.json dist/styles.css "<vault>/.obsidian/plugins/local-folder-sync/"
   ```

4. Enable the plugin in Obsidian under Settings > Community plugins, then fully restart
   Obsidian if you're updating an already-loaded plugin (module load failures can be cached
   for the running session).

### Production Use

Same as above: build, then copy `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`
into `<vault>/.obsidian/plugins/local-folder-sync/`.

## Usage

### Settings

Open the plugin settings to:

1. **Toggle Auto Sync**: Enable/disable automatic synchronization
2. **Set Auto Sync Trigger**: `Interval` (sync every N minutes) or `On Change` (sync as soon as a file changes)
3. **Set Sync Interval**: Configure how often (in minutes) to auto-sync, when using the `Interval` trigger
4. **Add Sync Pairs**: Add multiple folder pairs to sync
   - **Source**: Obsidian folder path (relative to vault root, e.g., `Notes/Project`)
   - **Destination**: Absolute local path (e.g., `/Users/Jens/Documents/Backup`)
   - **Sync Mode**: `One-way` (source → destination, deletes extra destination files) or
     `Newer file wins` (two-way, never deletes)
   - **Enabled**: Toggle individual pairs on/off

### Manual Sync

- Use the command palette: `Folder Sync: Sync all folders now`
- Or click the "Sync Now" button in the plugin settings

## Implementation Details

### Sync Behavior

- **One-way mode**: Changes are ONLY synced from source to destination
  - New/modified files in source are copied to destination
  - Files deleted from source are deleted from destination (cleanup)
- **Newer file wins mode**: Two-way — whichever side changed more recently is copied to the other
  - Files unique to one side are copied to the other side
  - Nothing is ever deleted automatically in this mode
- **Subfolder support**: Nested folder structures are preserved on both sides
- **Overlap protection**: If two enabled pairs' destinations are the same or nested, the later one is
  skipped (with an error) rather than risking one pair deleting the other's files

### Error Handling

- Errors for each file/folder are collected and shown in the summary
- Sync continues for other files even if some fail
- Errors are logged to console for debugging

### File Structure

```
local-folder-sync/
├── src/
│   ├── main.ts            # Main plugin class, auto-sync, watchers, status bar
│   ├── settings.ts        # Settings UI
│   ├── sync.ts            # Sync logic (one-way and newer-wins)
│   ├── types.ts           # TypeScript types
│   ├── manifest.json      # Plugin metadata
│   └── styles.css         # Custom styles
├── esbuild.config.mjs     # Bundles src/ into a single dist/main.js
├── package.json           # Node dependencies
└── tsconfig.json          # TypeScript config (type-checking only)
```

## Building

```bash
# Development mode (watches for changes)
npm run dev

# Production build
npm run build
```

## Notes

- This is a **desktop-only** plugin (requires filesystem access)
- Paths are normalized for cross-platform compatibility
- The plugin prevents concurrent syncs to avoid conflicts

## License

MIT
