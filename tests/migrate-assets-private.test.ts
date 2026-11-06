import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { migrateAssetsPrivate } from '../scripts/migrate-assets-private.mjs';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

interface RegistryAsset {
    assetId: string;
    logicalPath: string;
}

interface Registry {
    assets: RegistryAsset[];
}

function hash(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

function fixtureSvg(assetId: string) {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><title>${assetId}</title></svg>`);
}

function nativePath(logicalPath: string) {
    return logicalPath.split('/').join(path.sep);
}

async function listSvgFiles(root: string, relativeDirectory = ''): Promise<string[]> {
    const directory = relativeDirectory ? path.join(root, nativePath(relativeDirectory)) : root;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    const files: string[] = [];
    for (const entry of entries) {
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files.push(...await listSvgFiles(root, relative));
        } else if (entry.isFile() && /\.svg$/i.test(entry.name)) {
            files.push(relative);
        }
    }
    return files.sort();
}

async function createFixture(run: (projectRoot: string, registry: Registry, mappingBefore: Buffer) => Promise<void>) {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'private-asset-migration-'));
    const registry = JSON.parse(
        await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-registry.json'), 'utf8')
    ) as Registry;
    const scriptsRoot = path.join(projectRoot, 'scripts');
    const publicRoot = path.join(projectRoot, 'public', 'assets');
    const privateRoot = path.join(projectRoot, 'private', 'assets');
    await mkdir(scriptsRoot, { recursive: true });
    await mkdir(publicRoot, { recursive: true });
    await mkdir(privateRoot, { recursive: true });
    await writeFile(
        path.join(scriptsRoot, 'asset-registry.json'),
        `${JSON.stringify(registry, null, 2)}\n`
    );
    const currentMapping = await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'asset-roots.mjs'), 'utf8');
    const mappingBefore = Buffer.from(currentMapping.replace(
        "    {\n        physical: path.join(PROJECT_ROOT, 'public', 'minimap'),",
        `    {
        physical: path.join(PROJECT_ROOT, 'public', 'assets', 'Components'),
        logical: 'assets/Components',
        urlPrefix: '/assets',
        recursive: true
    },
    {
        physical: path.join(PROJECT_ROOT, 'public', 'assets', 'Turrets-Platforms'),
        logical: 'assets/Turrets-Platforms',
        urlPrefix: '/assets',
        recursive: true
    },
    {
        physical: path.join(PROJECT_ROOT, 'public', 'minimap'),`
    ));
    await writeFile(path.join(scriptsRoot, 'asset-roots.mjs'), mappingBefore);

    for (const asset of registry.assets) {
        const bytes = fixtureSvg(asset.assetId);
        const publicPath = path.join(publicRoot, nativePath(asset.logicalPath.slice('assets/'.length)));
        await mkdir(path.dirname(publicPath), { recursive: true });
        await writeFile(publicPath, bytes);

        if (asset.logicalPath.startsWith('assets/Ships/')) {
            const privatePath = path.join(privateRoot, nativePath(asset.logicalPath.slice('assets/'.length)));
            await mkdir(path.dirname(privatePath), { recursive: true });
            await writeFile(privatePath, bytes);
        }
    }

    try {
        await run(projectRoot, registry, mappingBefore);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
}

async function readAllPrivateHashes(projectRoot: string, registry: Registry) {
    const result = new Map<string, string>();
    for (const asset of registry.assets) {
        const filePath = path.join(
            projectRoot,
            'private',
            nativePath(asset.logicalPath)
        );
        result.set(asset.logicalPath, hash(await readFile(filePath)));
    }
    return result;
}

test('dry-run reports the exact 21-file migration without changing sources or mapping', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        const report = await migrateAssetsPrivate({ projectRoot });
        const mappingAfter = await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs'));
        const privateSvgPaths = await listSvgFiles(path.join(projectRoot, 'private', 'assets'));
        const expectedCopyBytes = registry.assets
            .filter((asset) => !asset.logicalPath.startsWith('assets/Ships/'))
            .reduce((total, asset) => total + fixtureSvg(asset.assetId).length, 0);

        assert.equal(report.mode, 'dry-run');
        assert.equal(report.registryAssetCount, 31);
        assert.equal(report.existingPrivateCount, 10);
        assert.equal(report.filesToCopy, 21);
        assert.equal(report.copyBytes, expectedCopyBytes);
        assert.equal(report.mappingChangeRequired, true);
        assert.equal(report.assets.length, 31);
        assert.deepEqual(privateSvgPaths, registry.assets
            .filter((asset) => asset.logicalPath.startsWith('assets/Ships/'))
            .map((asset) => asset.logicalPath.slice('assets/'.length))
            .sort());
        assert.deepEqual(mappingAfter, mappingBefore);
        assert.equal((await readdir(path.join(projectRoot, 'private'))).some((name) => name.startsWith('.asset-migration-')), false);
    });
});

test('apply copies all registered sources, updates roots only after verification, and preserves public files', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        const publicHashes = new Map<string, string>();
        for (const asset of registry.assets) {
            const publicPath = path.join(
                projectRoot,
                'public',
                nativePath(asset.logicalPath)
            );
            publicHashes.set(asset.logicalPath, hash(await readFile(publicPath)));
        }

        const report = await migrateAssetsPrivate({
            projectRoot,
            apply: true,
            runPreparationCommand: async (root) => {
                assert.equal(root, projectRoot);
                const mapping = await readFile(path.join(root, 'scripts', 'asset-roots.mjs'), 'utf8');
                assert.doesNotMatch(mapping, /public', 'assets', '(?:Components|Turrets-Platforms)'/);
                assert.match(mapping, /private', 'assets'/);
                assert.equal((await listSvgFiles(path.join(root, 'private', 'assets'))).length, 31);
            }
        });

        const hashes = await readAllPrivateHashes(projectRoot, registry);
        const expectedCopyBytes = registry.assets
            .filter((asset) => !asset.logicalPath.startsWith('assets/Ships/'))
            .reduce((total, asset) => total + fixtureSvg(asset.assetId).length, 0);
        assert.equal(report.mode, 'migrated');
        assert.equal(report.filesToCopy, 21);
        assert.equal(report.copyBytes, expectedCopyBytes);
        assert.equal(hashes.size, 31);
        for (const asset of registry.assets) {
            assert.equal(hashes.get(asset.logicalPath), publicHashes.get(asset.logicalPath));
            const publicPath = path.join(projectRoot, 'public', nativePath(asset.logicalPath));
            assert.equal(hash(await readFile(publicPath)), publicHashes.get(asset.logicalPath));
        }

        const mappingAfter = await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs'), 'utf8');
        assert.notDeepEqual(Buffer.from(mappingAfter), mappingBefore);
        assert.equal((await readdir(path.join(projectRoot, 'private'))).some((name) => name.startsWith('.asset-migration-')), false);
    });
});

test('identical pre-existing private copies are accepted without overwriting', async () => {
    await createFixture(async (projectRoot, registry) => {
        const asset = registry.assets.find((entry) => entry.assetId === 'rt.component.aistiaria.hex-cockpit');
        const publicPath = path.join(projectRoot, 'public', nativePath(asset.logicalPath));
        const privatePath = path.join(projectRoot, 'private', nativePath(asset.logicalPath));
        const sourceBytes = await readFile(publicPath);
        await mkdir(path.dirname(privatePath), { recursive: true });
        await writeFile(privatePath, sourceBytes);
        const priorStats = await readFile(privatePath);

        const report = await migrateAssetsPrivate({
            projectRoot,
            apply: true,
            runPreparationCommand: async () => {}
        });

        assert.equal(report.filesToCopy, 20);
        assert.deepEqual(await readFile(privatePath), priorStats);
        assert.equal((await listSvgFiles(path.join(projectRoot, 'private', 'assets'))).length, 31);
    });
});

test('a different existing destination fails without overwriting or changing the mapping', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        const asset = registry.assets.find((entry) => entry.assetId === 'rt.component.aistiaria.hex-cockpit');
        const privatePath = path.join(projectRoot, 'private', nativePath(asset.logicalPath));
        const conflict = Buffer.from('user-owned private content');
        await mkdir(path.dirname(privatePath), { recursive: true });
        await writeFile(privatePath, conflict);

        await assert.rejects(migrateAssetsPrivate({ projectRoot, apply: true }), /will not be overwritten/);
        assert.deepEqual(await readFile(privatePath), conflict);
        assert.deepEqual(await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs')), mappingBefore);
    });
});

test('a missing public source fails before copies or source-root changes', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        const asset = registry.assets.find((entry) => entry.assetId === 'rt.component.aistiaria.hex-cockpit');
        await rm(path.join(projectRoot, 'public', nativePath(asset.logicalPath)));

        await assert.rejects(migrateAssetsPrivate({ projectRoot, apply: true }), /public\/assets SVG inventory is missing/);
        assert.equal((await listSvgFiles(path.join(projectRoot, 'private', 'assets'))).length, 10);
        assert.deepEqual(await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs')), mappingBefore);
    });
});

test('a case-mismatched private destination is reported instead of overwritten', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        const privatePath = path.join(
            projectRoot,
            'private',
            'assets',
            'Components',
            'Aistiaria',
            '02_HEX_COCKPIT.svg'
        );
        await mkdir(path.dirname(privatePath), { recursive: true });
        await writeFile(privatePath, '<svg/>');

        await assert.rejects(migrateAssetsPrivate({ projectRoot, apply: true }), /private asset path casing differs/);
        assert.deepEqual(await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs')), mappingBefore);
    });
});

test('a preparation failure rolls back only the source-root mapping and preserves verified copies', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        await assert.rejects(migrateAssetsPrivate({
            projectRoot,
            apply: true,
            runPreparationCommand: async () => {
                throw new Error('injected preparation failure');
            }
        }), /injected preparation failure/);

        assert.deepEqual(await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs')), mappingBefore);
        assert.equal((await listSvgFiles(path.join(projectRoot, 'private', 'assets'))).length, 31);
        assert.equal((await listSvgFiles(path.join(projectRoot, 'public', 'assets'))).length, 31);
        assert.equal((await readdir(path.join(projectRoot, 'private'))).some((name) => name.endsWith('.bak')), false);
        assert.equal((await readdir(path.join(projectRoot, 'private'))).some((name) => name.startsWith('.asset-migration-')), false);
    });
});

test('a partial install failure removes only files installed by the current migration', async () => {
    await createFixture(async (projectRoot, registry, mappingBefore) => {
        let links = 0;
        await assert.rejects(migrateAssetsPrivate({
            projectRoot,
            apply: true,
            publishLink: async (source: string, destination: string) => {
                links += 1;
                if (links === 2) {
                    throw new Error('injected link failure');
                }
                const { link } = await import('node:fs/promises');
                await link(source, destination);
            },
            runPreparationCommand: async () => {}
        }), /injected link failure/);

        assert.equal((await listSvgFiles(path.join(projectRoot, 'private', 'assets'))).length, 10);
        assert.deepEqual(await readFile(path.join(projectRoot, 'scripts', 'asset-roots.mjs')), mappingBefore);
        assert.equal(links, 2);
    });
});
