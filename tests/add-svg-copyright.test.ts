import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAssetRegistry, resolveAssetSource } from '../scripts/asset-registry.mjs';
import {
    analyzeSvgMetadata,
    buildCanonicalInventory,
    escapeXml,
    generateMetadataBlock,
    insertMetadata,
    isValidXml,
    run
} from '../scripts/add-svg-copyright.mjs';
import { listSourceAssets } from '../scripts/asset-roots.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

async function withTemporaryDirectory(runTest: (root: string) => Promise<void>) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'svg-copyright-'));
    try {
        await runTest(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function writeFixture(filePath: string, content: string) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
}

async function createPrivateRegistryFixture(root: string) {
    const registry = await readAssetRegistry(PROJECT_ROOT);
    await writeFixture(path.join(root, 'scripts', 'asset-registry.json'), JSON.stringify(registry));
    for (const asset of registry.assets.filter((entry) => entry.contentType === 'SVG')) {
        const source = resolveAssetSource(asset.logicalPath, PROJECT_ROOT);
        const destination = resolveAssetSource(asset.logicalPath, root);
        await writeFixture(destination, await readFile(source, 'utf8'));
    }
    return registry.assets.filter((entry) => entry.contentType === 'SVG');
}

test('detects project metadata in Saxes attribute values', () => {
    const result = analyzeSvgMetadata('<svg data-owner="Redemptis-Tiariea"></svg>');

    assert.equal(result.hasProjectMetadata, true);
    assert.equal(result.isMalformed, false);
});

test('detects project metadata in text nodes', () => {
    const result = analyzeSvgMetadata(
        '<svg><metadata><description>Copyright Redemptis-Tiariea</description></metadata></svg>'
    );

    assert.equal(result.hasProjectMetadata, true);
});

test('extracts and preserves an existing XML title when inserting metadata', () => {
    const source = '<svg><metadata><title>Asset &amp; Name</title></metadata></svg>';
    const result = analyzeSvgMetadata(source);

    assert.equal(result.title, 'Asset & Name');
    const updated = insertMetadata(source, '<copyright>New metadata</copyright>');
    assert.ok(updated);
    assert.ok(updated.includes('<title>Asset &amp; Name</title>'));
    assert.ok(updated.includes('<copyright>New metadata</copyright>'));
});

test('escapes all five XML special characters to their exact entities', () => {
    assert.equal(escapeXml('<>&"\''), '&lt;&gt;&amp;&quot;&apos;');
});

test('reports malformed XML', () => {
    const result = analyzeSvgMetadata('<svg><g></svg>');

    assert.equal(result.isMalformed, true);
});

test('validates well-formed and malformed XML directly', () => {
    assert.equal(isValidXml('<svg><g /></svg>'), true);
    assert.equal(isValidXml('<svg><g></svg>'), false);
});

test('inserts generated metadata into a valid SVG and preserves well-formed XML', () => {
    const source = '<svg><title>Regression fixture</title></svg>';
    const updated = insertMetadata(source, generateMetadataBlock('Regression fixture'));

    assert.ok(updated);
    assert.ok(updated.includes('<dc:title>Regression fixture</dc:title>'));
    assert.ok(updated.includes('Redemptis-Tiariea'));
    assert.equal(isValidXml(updated), true);
});

test('copyright inventory contains exactly the 31 registered private game SVGs', async () => {
    const [inventory, sourceAssets] = await Promise.all([
        buildCanonicalInventory(),
        listSourceAssets()
    ]);
    assert.equal(inventory.length, 31);
    assert.equal(sourceAssets.length, 36);
    assert.ok(inventory.every((asset) => asset.logicalPath.startsWith('assets/')));
    assert.ok(inventory.every((asset) =>
        asset.physicalSourcePath.includes(path.join('private', 'assets'))
    ));
    assert.equal(inventory.some((asset) => asset.logicalPath.startsWith('minimap/')), false);
    assert.equal(inventory.some((asset) => ['favicon.svg', 'icons.svg'].includes(asset.logicalPath)), false);
});

test('missing private SVG sources fail without falling back to public copies', async () => {
    await withTemporaryDirectory(async (root) => {
        const assets = await createPrivateRegistryFixture(root);
        const first = assets[0];
        const privateSource = resolveAssetSource(first.logicalPath, root);
        await rm(privateSource);
        await writeFixture(path.join(root, 'public', first.logicalPath), '<svg />');
        await assert.rejects(buildCanonicalInventory(root), /Missing canonical private SVG source/);
    });
});

test('SVG metadata inspection rejects a well-formed non-SVG XML root', () => {
    assert.equal(analyzeSvgMetadata('<html><body /></html>').isMalformed, true);
});

test('dry-run processes all 31 registered SVGs and reports no malformed sources', async () => {
    const output: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    console.error = (...values: unknown[]) => output.push(values.join(' '));
    try {
        assert.equal(await run({ args: ['--dry-run'] }), 0);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    assert.ok(output.some((line) => line.includes('Total SVGs found: 31')));
    assert.ok(output.some((line) => line.includes('Malformed:        0')));
});

test('restores preferred and legacy backups without processing metadata first', async () => {
    await withTemporaryDirectory(async (root) => {
        const backupDir = path.join(root, 'scripts', 'backups', 'svg-copyright');
        const ownershipFile = path.join(root, 'scripts', 'svg-ownership.json');
        const svgAssets = await createPrivateRegistryFixture(root);
        const preferred = svgAssets[0];
        const legacy = svgAssets[1];
        const preferredSource = resolveAssetSource(preferred.logicalPath, root);
        const legacySource = resolveAssetSource(legacy.logicalPath, root);
        const preferredBackup = '<svg><title>Preferred original</title></svg>';
        const legacyBackup = '<svg><title>Legacy original</title></svg>';
        const logicalPath = preferred.logicalPath;
        const legacyLogicalPath = legacy.logicalPath;

        await writeFixture(preferredSource, '<svg><title>Current, not restored</title></svg>');
        await writeFixture(legacySource, '<svg><title>Current, not restored</title></svg>');
        await writeFixture(path.join(backupDir, logicalPath), preferredBackup);
        await writeFixture(path.join(backupDir, 'public', logicalPath), '<svg>Legacy duplicate</svg>');
        await writeFixture(path.join(backupDir, 'public', legacyLogicalPath), legacyBackup);
        await writeFixture(ownershipFile, JSON.stringify({
            assets: {},
            defaults: { fallback: 'PROJECT_OWNED' }
        }));

        const output: string[] = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...values: unknown[]) => output.push(values.join(' '));
        console.error = (...values: unknown[]) => output.push(values.join(' '));
        let exitCode: number | undefined;
        try {
            exitCode = await run({
                projectRoot: root,
                args: ['--restore'],
                backupDir,
                ownershipFile
            });
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        assert.equal(exitCode, 1);
        assert.equal(await readFile(preferredSource, 'utf8'), preferredBackup);
        assert.equal(await readFile(legacySource, 'utf8'), legacyBackup);
        assert.equal(await readFile(path.join(backupDir, logicalPath), 'utf8'), preferredBackup);
        assert.equal(
            await readFile(path.join(backupDir, 'public', logicalPath), 'utf8'),
            '<svg>Legacy duplicate</svg>'
        );
        assert.equal(
            await readFile(path.join(backupDir, 'public', legacyLogicalPath), 'utf8'),
            legacyBackup
        );
        assert.ok(output.some((line) => line.includes('Files restored:   2')));
        assert.ok(output.some((line) => line.includes(logicalPath)));
        assert.ok(output.some((line) => line.includes(legacyLogicalPath)));
        assert.ok(output.some((line) => line.includes(svgAssets[2].logicalPath)));
    });
});
