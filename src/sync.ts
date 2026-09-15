import { TFile, TFolder, Vault, normalizePath } from 'obsidian';
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
        return syncPairNewer(vault, sourceFolder, destPath, onProgress);
    }
    return syncPairOneWay(vault, sourceFolder, destPath, onProgress);
}

/**
 * ONE-WAY sync: only changes from source are applied to destination.
 * Files in destination that no longer exist in source are deleted.
 */
async function syncPairOneWay(
    vault: Vault,
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

            const destContent = fs.existsSync(destFilePath) ? fs.readFileSync(destFilePath) : Buffer.from([]);
            const needsUpdate = !fs.existsSync(destFilePath) ||
                !Buffer.from(destContent).equals(content);

            if (needsUpdate) {
                fs.writeFileSync(destFilePath, content);
                copied++;
                if (onProgress) onProgress(`Copied: ${relativePath}`);
            }
        } catch (error: unknown) {
            errors.push(`Error syncing file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const deleted = await cleanupDestination(sourceFolder, destPath, onProgress);

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
    sourceFolder: TFolder,
    destPath: string,
    onProgress?: (message: string) => void
): Promise<SyncResult> {
    const errors: string[] = [];
    let copied = 0;

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

    Vault.recurseChildren(folder, (file) => {
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

/**
 * Recursively list all files under a destination folder on disk.
 */
function listDestinationFiles(destPath: string): DestFileEntry[] {
    const results: DestFileEntry[] = [];

    const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const relativePath = toPosixPath(fullPath.slice(destPath.length + 1));
                const stat = fs.statSync(fullPath);
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
 * Remove files from destination that no longer exist in source
 */
async function cleanupDestination(
    sourceFolder: TFolder,
    destPath: string,
    onProgress?: (message: string) => void
): Promise<number> {
    let deleted = 0;
    const sourceFiles = getAllFilesInFolder(sourceFolder);
    const sourcePaths = new Set<string>(sourceFiles.map(f => f.path.slice(sourceFolder.path.length + 1)));

    for (const entry of listDestinationFiles(destPath)) {
        if (!sourcePaths.has(entry.relativePath)) {
            try {
                fs.unlinkSync(entry.fullPath);
                deleted++;
                if (onProgress) onProgress(`Deleted: ${entry.relativePath}`);
            } catch {
                // Deletion error - already recorded in errors array
            }
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
            results.set(key, {
                copied: 0,
                deleted: 0,
                errors: [
                    `Skipped: destination overlaps with sync pair #${overlapIndex + 1} ` +
                    `("${pairs[overlapIndex]?.destination}"). Fix the paths — syncing both ` +
                    `could delete each other's files.`,
                ],
            });
            continue;
        }

        const result = await syncPair(vault, pair, (msg: string) => {
            if (onProgress) onProgress(i, msg);
        });

        results.set(key, result);
    }

    return results;
}
