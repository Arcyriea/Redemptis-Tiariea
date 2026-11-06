import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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

test('keeps the canonical 36-source inventory across private and public roots', async () => {
    const [inventory, sourceAssets] = await Promise.all([
        buildCanonicalInventory(),
        listSourceAssets()
    ]);
    const gameAssets = inventory.filter((asset) => asset.logicalPath.startsWith('assets/'));
    const minimapAssets = inventory.filter((asset) => asset.logicalPath.startsWith('minimap/'));
    const rootAssets = inventory.filter((asset) => !asset.logicalPath.includes('/'));

    assert.equal(inventory.length, 36);
    assert.equal(sourceAssets.length, 36);
    assert.equal(gameAssets.length, 31);
    assert.ok(gameAssets.every((asset) =>
        asset.physicalSourcePath.includes(path.join('private', 'assets'))
    ));
    assert.equal(minimapAssets.length, 3);
    assert.ok(minimapAssets.every((asset) =>
        asset.physicalSourcePath.includes(path.join('public', 'minimap'))
    ));
    assert.equal(rootAssets.length, 2);
    assert.ok(rootAssets.every((asset) =>
        asset.physicalSourcePath.includes('public')
    ));
});

test('restores preferred and legacy backups without processing metadata first', async () => {
    await withTemporaryDirectory(async (root) => {
        const backupDir = path.join(root, 'scripts', 'backups', 'svg-copyright');
        const ownershipFile = path.join(root, 'scripts', 'svg-ownership.json');
        const preferredSource = path.join(root, 'private', 'ships', 'preferred.svg');
        const legacySource = path.join(root, 'public', 'components', 'legacy.svg');
        const missingSource = path.join(root, 'public', 'missing.svg');
        const failedSource = path.join(root, 'absent', 'directory', 'failed.svg');
        const preferredBackup = '<svg><title>Preferred original</title></svg>';
        const legacyBackup = '<svg><title>Legacy original</title></svg>';
        const logicalPath = 'assets/Ships/preferred.svg';
        const legacyLogicalPath = 'assets/Components/legacy.svg';
        const missingLogicalPath = 'assets/missing.svg';
        const failedLogicalPath = 'assets/failed.svg';

        await writeFixture(preferredSource, '<svg><title>Current, not restored</title></svg>');
        await writeFixture(legacySource, '<svg><title>Current, not restored</title></svg>');
        await writeFixture(missingSource, '<svg><title>Missing backup</title></svg>');
        await writeFixture(path.join(backupDir, logicalPath), preferredBackup);
        await writeFixture(path.join(backupDir, 'public', logicalPath), '<svg>Legacy duplicate</svg>');
        await writeFixture(path.join(backupDir, 'public', legacyLogicalPath), legacyBackup);
        await writeFixture(path.join(backupDir, failedLogicalPath), '<svg>Will fail</svg>');
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
                args: ['--restore'],
                inventory: [
                    { logicalPath, physicalSourcePath: preferredSource },
                    { logicalPath: legacyLogicalPath, physicalSourcePath: legacySource },
                    { logicalPath: missingLogicalPath, physicalSourcePath: missingSource },
                    { logicalPath: failedLogicalPath, physicalSourcePath: failedSource }
                ],
                backupDir,
                ownershipFile
            } as Parameters<typeof run>[0]);
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
        assert.ok(output.some((line) => line.includes(missingLogicalPath)));
        assert.ok(output.some((line) => line.includes(failedLogicalPath)));
    });
});
