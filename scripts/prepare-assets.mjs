import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetPackageOutputs, validateCommittedAssetOutputs } from './package-assets.mjs';
import { createPublicSvgManifest, renderPublicSvgManifest } from './generate-public-svg-manifest.mjs';
import { PROJECT_ROOT } from './asset-registry.mjs';

async function privateRootExists(directory) {
    try {
        const info = await lstat(directory);
        if (!info.isDirectory()) {
            throw new Error(`Private source root exists but is not a directory: ${directory}`);
        }
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function publishGeneratedFiles(outputs) {
    const staged = [];
    try {
        for (const [destination, contents] of outputs) {
            await mkdir(path.dirname(destination), { recursive: true });
            const existing = await lstat(destination).catch((error) => {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            });
            if (existing && !existing.isFile()) {
                throw new Error(`Generated output destination is not a regular file: ${destination}`);
            }

            const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
            if (existing && (await readFile(destination)).equals(bytes)) {
                continue;
            }
            const token = `${process.pid}-${randomUUID()}`;
            const temporary = `${destination}.${token}.tmp`;
            const backup = `${destination}.${token}.bak`;
            const entry = {
                destination,
                temporary,
                backup,
                hadOriginal: Boolean(existing),
                backupMoved: false,
                installed: false
            };
            staged.push(entry);
            await writeFile(temporary, bytes, { flag: 'wx' });
        }

        for (const entry of staged) {
            if (entry.hadOriginal) {
                await rename(entry.destination, entry.backup);
                entry.backupMoved = true;
            }
            await rename(entry.temporary, entry.destination);
            entry.installed = true;
        }
    } catch (error) {
        const rollbackErrors = [];
        for (const entry of [...staged].reverse()) {
            try {
                if (entry.installed) {
                    await rm(entry.destination, { force: true });
                }
                if (entry.backupMoved) {
                    await rename(entry.backup, entry.destination);
                    entry.backupMoved = false;
                }
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        for (const entry of staged) {
            try {
                await rm(entry.temporary, { force: true });
                if (!entry.backupMoved) {
                    await rm(entry.backup, { force: true });
                }
            } catch (cleanupError) {
                rollbackErrors.push(cleanupError);
            }
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], 'Generated output publication failed and rollback was incomplete');
        }
        throw error;
    }

    for (const entry of staged) {
        await rm(entry.backup, { force: true });
        await rm(entry.temporary, { force: true });
    }
}

export async function prepareAssets({ projectRoot = PROJECT_ROOT } = {}) {
    const privateRoot = path.join(projectRoot, 'private');
    const hasPrivateRoot = await privateRootExists(privateRoot);

    if (!hasPrivateRoot) {
        const result = await validateCommittedAssetOutputs({ projectRoot });
        console.log(`Validated ${result.validatedBundles.length} committed RTAB bundle(s) without source changes.`);
        return { mode: 'validate-only', ...result };
    }

    const { outputFiles } = await createAssetPackageOutputs({ projectRoot });
    const runtimeAssets = await createPublicSvgManifest(undefined, undefined, projectRoot);
    outputFiles.set(
        path.join(projectRoot, 'src', 'generated', 'publicSvgManifest.ts'),
        renderPublicSvgManifest(runtimeAssets)
    );
    await publishGeneratedFiles(outputFiles);
    console.log(`Packaged ${outputFiles.size} generated asset output(s) from canonical sources.`);
    return { mode: 'package', outputFiles };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    prepareAssets().catch((error) => {
        console.error(`Failed to prepare assets: ${error.message}`);
        process.exitCode = 1;
    });
}
