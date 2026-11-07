/// <reference types="node" />
import { TAbstractFile, TFile, TFolder, Vault, MetadataCache, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { SyncPair } from './types';

type SyncResult = { copied: number; deleted: number; errors: string[] };

/**
 * Convert an OS-specific path to forward-slash form so it can be compared
 * against vault paths (which always use '/', even on Windows).
 */
function toPosixPath(p: string): string {
    return p.split(path.sep).join('/');
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    const start = buffer.byteOffset;
    const end = buffer.byteOffset + buffer.byteLength;
    const slice = buffer.buffer.slice(start, end);
    return slice as ArrayBuffer;
}

/**
 * Sync a single pair. Dispatches to the pair's configured mode.
 */
export async function syncPair(
    vault: Vault,
    metadataCache: MetadataCache,
    pair: SyncPair,
    onProgress?: (message: string) => void
): Promise<SyncResult> {
    const errors: string[] = [];

    const sourcePath = normalizePath(pair.source);
    const destPath = normalizePath(pair.destination);

    if (!sourcePath || !destPath) {
        errors.push('Source or destination path is empty');
        return { copied: 0, deleted: 0, errors };
    }

    const sourceFolder = vault.getAbstractFileByPath(sourcePath);
    if (!sourceFolder || !(sourceFolder instanceof TFolder)) {
        errors.push(`Source folder not found: ${sourcePath}`);
        return { copied: 0, deleted: 0, errors };
    }

    const embedSync = shouldSyncEmbeds(vault, pair);

    // Check if destination exists, create if not
    if (!fs.existsSync(destPath)) {
        try {
            fs.mkdirSync(destPath, { recursive: true });
            if (onProgress) onProgress(`Created destination folder: ${destPath}`);
        } catch (error: unknown) {
            errors.push(`Failed to create destination folder: ${error instanceof Error ? error.message : String(error)}`);
            return { copied: 0, deleted: 0, errors };
        }
    }

    if (pair.mode === 'newer') {
        return syncPairNewer(vault, metadataCache, embedSync, sourceFolder, destPath, onProgress);
    }
    return syncPairOneWay(vault, metadataCache, embedSync, sourceFolder, destPath, onProgress);
}

/**
 * Decide whether this pair should copy embedded files next to their notes.
 * 'auto' checks Obsidian's "Default location for new attachments" setting:
 * when it is './' (same folder as current file), attachments already live
 * next to their notes and the normal sync covers them — running the embed
 * pass would only cost time. Any other value ('/' for the vault root,
 * './sub' or a specific folder path) keeps attachments elsewhere, so the
 * embed pass is needed to place copies next to the note in the destination.
 */
function shouldSyncEmbeds(vault: Vault, pair: SyncPair): boolean {
    if (pair.embedSyncMode === 'always') return true;
    if (pair.embedSyncMode === 'never') return false;

    // getConfig is not part of the official typings, but the runtime method
    // has existed for a long time; fall back to "don't run" when absent.
    const reader = vault as unknown as { getConfig?: (name: string) => unknown };
    if (typeof reader.getConfig !== 'function') return false;

    let folder: unknown;
    try {
        folder = reader.getConfig.call(vault, 'attachmentFolderPath');
    } catch {
        return false;
    }
    return folder !== './';
}

/**
 * ONE-WAY sync: only changes from source are applied to destination.
 * Files in destination that no longer exist in source are deleted.
 */
async function syncPairOneWay(
    vault: Vault,
    metadataCache: MetadataCache,
    embedSync: boolean,
    sourceFolder: TFolder,
    destPath: string,
    onProgress?: (message: string) => void
): Promise<SyncResult> {
    const errors: string[] = [];
    let copied = 0;

    const files = getAllFilesInFolder(sourceFolder);

    for (const file of files) {
        try {
            const relativePath = file.path.slice(sourceFolder.path.length + 1);
            const destFilePath = path.join(destPath, relativePath);
            const destDir = path.dirname(destFilePath);

            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            // Read as binary so images, PDFs, and other non-text attachments
            // aren't corrupted (vault.read assumes UTF-8 text)
            const content = Buffer.from(await vault.readBinary(file));

            const destContentBuffer = fs.existsSync(destFilePath) ? fs.readFileSync(destFilePath) : Buffer.from([]);
            const destContent = Buffer.from(destContentBuffer);
            const needsUpdate = !fs.existsSync(destFilePath) || !destContent.equals(content);

            if (needsUpdate) {
                fs.writeFileSync(destFilePath, content);
                copied++;
                if (onProgress) onProgress(`Copied: ${relativePath}`);
            }
        } catch (error: unknown) {
            errors.push(`Error syncing file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Copy files embedded in the synced notes (which may live outside the
    // source folder, e.g. in a central attachments folder) into the note's
    // folder in the destination, and remember their paths so cleanup keeps them.
    let embedPaths = new Set<string>();
    if (embedSync) {
        const embeds = await copyMarkdownEmbeds(vault, metadataCache, sourceFolder, destPath, onProgress);
        copied += embeds.copied;
        errors.push(...embeds.errors);
        embedPaths = embeds.destRelativePaths;
    }

    const deleted = await cleanupDestination(sourceFolder, destPath, onProgress, embedPaths);

    return { copied, deleted, errors };
}

/**
 * NEWER-WINS sync: two-way. For each file that exists on only one side, it's
 * copied to the other side. For files that exist on both sides, whichever
 * side has the more recent modification time overwrites the other (files
 * with identical content are left alone regardless of timestamps). This mode
 * never deletes anything — a file missing from one side is always treated as
 * "needs to be copied there", never as "was deleted, so remove it".
 */
async function syncPairNewer(
    vault: Vault,
    metadataCache: MetadataCache,
    embedSync: boolean,
    sourceFolder: TFolder,
    destPath: string,
    onProgress?: (message: string) => void
): Promise<SyncResult> {
    const errors: string[] = [];
    let copied = 0;

    // Copy files embedded in the synced notes into the note's folder in the
    // destination (attachment-following is one-directional, like the vault
    // originals: these copies must not be ingested back into the vault as
    // duplicates, so their paths are kept and skipped below).
    let embedPaths = new Set<string>();
    if (embedSync) {
        const embeds = await copyMarkdownEmbeds(vault, metadataCache, sourceFolder, destPath, onProgress);
        copied += embeds.copied;
        errors.push(...embeds.errors);
        embedPaths = embeds.destRelativePaths;
    }

    const sourceByRelPath = new Map<string, TFile>();
    for (const file of getAllFilesInFolder(sourceFolder)) {
        sourceByRelPath.set(file.path.slice(sourceFolder.path.length + 1), file);
    }

    const destByRelPath = new Map<string, DestFileEntry>(
        listDestinationFiles(destPath).map(entry => [entry.relativePath, entry])
    );

    const allRelativePaths = new Set<string>([...sourceByRelPath.keys(), ...destByRelPath.keys()]);

    for (const relativePath of allRelativePaths) {
        try {
            const sourceFile = sourceByRelPath.get(relativePath);
            const destEntry = destByRelPath.get(relativePath);
            const destFilePath = path.join(destPath, relativePath);

            if (sourceFile && !destEntry) {
                const destDir = path.dirname(destFilePath);
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }
                const content = Buffer.from(await vault.readBinary(sourceFile));
                fs.writeFileSync(destFilePath, content);
                copied++;
                if (onProgress) onProgress(`Copied to destination (new): ${relativePath}`);
            } else if (!sourceFile && destEntry) {
                if (embedPaths.has(destEntry.relativePath)) {
                    continue;
                }
                const vaultPath = normalizePath(`${sourceFolder.path}/${relativePath}`);
                await ensureVaultFolder(vault, path.dirname(vaultPath));
                const contentBuffer = fs.readFileSync(destEntry.fullPath);
                await vault.createBinary(vaultPath, toArrayBuffer(contentBuffer));
                copied++;
                if (onProgress) onProgress(`Copied to vault (new): ${relativePath}`);
            } else if (sourceFile && destEntry) {
                const destContent = fs.readFileSync(destEntry.fullPath);
                const sourceContent = Buffer.from(await vault.readBinary(sourceFile));

                if (destContent.equals(sourceContent)) {
                    continue;
                }

                if (sourceFile.stat.mtime > destEntry.mtimeMs) {
                    fs.writeFileSync(destEntry.fullPath, sourceContent);
                    copied++;
                    if (onProgress) onProgress(`Updated destination (source newer): ${relativePath}`);
                } else {
                    await vault.modifyBinary(sourceFile, toArrayBuffer(destContent));
                    copied++;
                    if (onProgress) onProgress(`Updated vault (destination newer): ${relativePath}`);
                }
            }
        } catch (error: unknown) {
            errors.push(`Error syncing file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return { copied, deleted: 0, errors };
}

/**
 * Create a vault folder (and any missing parents) if it doesn't already exist.
 */
async function ensureVaultFolder(vault: Vault, folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    if (!normalized || normalized === '.') return;

    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await vault.adapter.exists(current))) {
            await vault.adapter.mkdir(current);
        }
    }
}

/**
 * Recursively get all files in a folder
 */
function getAllFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];

    Vault.recurseChildren(folder, (file: TAbstractFile): void => {
        if (file instanceof TFile) {
            files.push(file);
        }
    });

    return files;
}

interface DestFileEntry {
    relativePath: string;
    fullPath: string;
    mtimeMs: number;
}

interface EmbedSyncResult {
    copied: number;
    errors: string[];
    /** Destination-relative paths of the copied embeds (forward slashes). */
    destRelativePaths: Set<string>;
}

const WIKI_EMBED_PATTERN = /!\[\[([^\][]+?)\]\]/g;
const MARKDOWN_EMBED_PATTERN = /!\[([^\]]*)\]\(([^)]+?)\)/g;

/**
 * Strip the alias/display part (`[[target|alias]]`) and heading/block
 * reference (`[[target#heading]]`, `![](path#anchor)`) from a linktext,
 * leaving just the path Obsidian needs to resolve the target file.
 */
function stripLinkTarget(linktext: string): string {
    const pipeIndex = linktext.indexOf('|');
    const withoutAlias = pipeIndex === -1 ? linktext : linktext.slice(0, pipeIndex);
    const hashIndex = withoutAlias.indexOf('#');
    let target = (hashIndex === -1 ? withoutAlias : withoutAlias.slice(0, hashIndex)).trim();
    const queryIndex = target.indexOf('?');
    if (queryIndex !== -1) {
        target = target.slice(0, queryIndex);
    }
    if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1);
    }
    if (target.startsWith('./')) {
        target = target.slice(2);
    }
    return target;
}

/**
 * Check whether an embed target is a URL (`https://...`, `obsidian://...`)
 * rather than a vault file.
 */
function isUrl(target: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/**
 * Find the linktext of every image/file embed in a markdown note:
 * wikilink embeds (`![[image.png]]`) and markdown image embeds (`![alt](media/image.png)`).
 */
function extractEmbedLinktexts(markdown: string): string[] {
    const targets: string[] = [];
    let match: RegExpExecArray | null;

    WIKI_EMBED_PATTERN.lastIndex = 0;
    while ((match = WIKI_EMBED_PATTERN.exec(markdown)) !== null) {
        targets.push(stripLinkTarget(match[1] ?? ''));
    }

    MARKDOWN_EMBED_PATTERN.lastIndex = 0;
    while ((match = MARKDOWN_EMBED_PATTERN.exec(markdown)) !== null) {
        targets.push(stripLinkTarget(match[2] ?? ''));
    }

    return targets;
}

/**
 * Copy files embedded in the source folder's markdown notes into the
 * destination, into the same folder as the embedding note. Embeds are
 * resolved exactly the way Obsidian resolves them, so an image living in a
 * central attachments folder is found even when the note only says
 * `![[image.png]]`.
 *
 * Files that already live inside the pair's source folder are skipped —
 * the regular sync handles those. Returns the set of destination-relative
 * paths of all copies so callers can keep them alive during cleanup and
 * prevent them from being synced back into the vault in newer mode.
 */
async function copyMarkdownEmbeds(
    vault: Vault,
    metadataCache: MetadataCache,
    sourceFolder: TFolder,
    destPath: string,
    onProgress?: (message: string) => void
): Promise<EmbedSyncResult> {
    const errors: string[] = [];
    const destRelativePaths = new Set<string>();
    const keptVaultPaths = new Map<string, string>();
    let copied = 0;

    for (const file of getAllFilesInFolder(sourceFolder)) {
        if (file.extension !== 'md') continue;

        let markdown: string;
        try {
            markdown = await vault.read(file);
        } catch (error: unknown) {
            errors.push(`Error reading ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        const noteRelPath = file.path.slice(sourceFolder.path.length + 1);
        const noteRelDir = toPosixPath(path.dirname(noteRelPath));

        for (const linktext of extractEmbedLinktexts(markdown)) {
            if (!linktext || isUrl(linktext)) continue;

            let target = linktext;
            try {
                target = decodeURIComponent(linktext);
            } catch {
                // Leave as-is if it isn't valid percent-encoding
            }

            const resolved = metadataCache.getFirstLinkpathDest(target, file.path);
            if (!resolved) continue;

            // Already covered by the regular sync when it lives in the source
            // folder. Embedded notes are left where they are, too.
            if (resolved.path === sourceFolder.path || resolved.path.startsWith(sourceFolder.path + '/')) continue;
            if (resolved.extension === 'md') continue;

            const destRelativePath = toPosixPath(noteRelDir === '.' ? resolved.name : `${noteRelDir}/${resolved.name}`);

            const alreadyKept = keptVaultPaths.get(destRelativePath);
            if (alreadyKept !== undefined) {
                if (alreadyKept !== resolved.path) {
                    errors.push(
                        `Skipped embedded file "${resolved.path}": another file with the same name ` +
                        `("${alreadyKept}") is embedded in the same destination folder.`
                    );
                    continue;
                }
                continue;
            }
            keptVaultPaths.set(destRelativePath, resolved.path);
            destRelativePaths.add(destRelativePath);

            try {
                const destFilePath = path.join(destPath, destRelativePath);
                const content = Buffer.from(await vault.readBinary(resolved));

                const needsUpdate = !fs.existsSync(destFilePath) ||
                    !Buffer.from(fs.readFileSync(destFilePath)).equals(content);

                if (needsUpdate) {
                    const destDir = path.dirname(destFilePath);
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    fs.writeFileSync(destFilePath, content);
                    copied++;
                    if (onProgress) onProgress(`Copied embed: ${destRelativePath}`);
                }
            } catch (error: unknown) {
                destRelativePaths.delete(destRelativePath);
                keptVaultPaths.delete(destRelativePath);
                errors.push(
                    `Error copying embedded file ${resolved.path}: ` +
                    `${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    }

    return { copied, errors, destRelativePaths };
}

/**
 * Recursively list all files under a destination folder on disk.
 *
 * Skips dotfiles/dot-folders (e.g. `.git`, `.DS_Store`): Obsidian's vault API
 * hides these from the source-side file listing, so treating them as
 * destination-only would make one-way mode delete them and newer-wins mode
 * repeatedly fail trying to copy them into the vault.
 */
function listDestinationFiles(destPath: string): DestFileEntry[] {
    const results: DestFileEntry[] = [];

    const walk = (dir: string): void => {
        const entries: fs.Dirent[] = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const relativePath = toPosixPath(fullPath.slice(destPath.length + 1));
                const stat: fs.Stats = fs.statSync(fullPath);
                results.push({ relativePath, fullPath, mtimeMs: stat.mtimeMs });
            }
        }
    };

    if (fs.existsSync(destPath)) {
        walk(destPath);
    }

    return results;
}

/**
 * Remove files from destination that no longer exist in source.
 * `preservePaths` lists destination-relative files to keep even though they
 * don't exist in the source (copies of embedded files placed next to their notes).
 */
async function cleanupDestination(
    sourceFolder: TFolder,
    destPath: string,
    onProgress?: (message: string) => void,
    preservePaths: Set<string> = new Set<string>()
): Promise<number> {
    let deleted = 0;
    const sourceFiles = getAllFilesInFolder(sourceFolder);
    const sourcePaths = new Set<string>(sourceFiles.map(f => f.path.slice(sourceFolder.path.length + 1)));

    for (const entry of listDestinationFiles(destPath)) {
        if (sourcePaths.has(entry.relativePath) || preservePaths.has(entry.relativePath)) {
            continue;
        }
        try {
            fs.unlinkSync(entry.fullPath);
            deleted++;
            if (onProgress) onProgress(`Deleted: ${entry.relativePath}`);
        } catch {
            // Deletion error - already recorded in errors array
        }
    }

    return deleted;
}

/**
 * Two destinations "overlap" if they are the same folder, or one is nested
 * inside the other — syncing both would let one pair's cleanup delete files
 * that belong to the other pair.
 */
function pathsOverlap(a: string, b: string): boolean {
    if (a === b) return true;
    return a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * Sync all enabled pairs
 */
export async function syncAllPairs(
    vault: Vault,
    metadataCache: MetadataCache,
    pairs: SyncPair[],
    onProgress?: (pairIndex: number, message: string) => void
): Promise<Map<string, SyncResult>> {
    const results = new Map<string, SyncResult>();

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (!pair || !pair.enabled) continue;

        const destPath = normalizePath(pair.destination);
        const key = `${pair.source} -> ${pair.destination}`;

        const overlapIndex = pairs.findIndex((p, j): boolean =>
            j !== i && p?.enabled && pathsOverlap(normalizePath(p.destination), destPath)
        );

        if (overlapIndex !== -1 && pairs[overlapIndex]) {
            const overlapPair = pairs[overlapIndex];
            results.set(key, {
                copied: 0,
                deleted: 0,
                errors: [
                    `Skipped: destination overlaps with sync pair #${overlapIndex + 1} ` +
                    `("${overlapPair?.destination}"). Fix the paths — syncing both ` +
                    `could delete each other's files.`,
                ],
            });
            continue;
        }

        const result = await syncPair(vault, metadataCache, pair, (msg: string): void => {
            if (onProgress) onProgress(i, msg);
        });

        results.set(key, result);
    }

    return results;
}
