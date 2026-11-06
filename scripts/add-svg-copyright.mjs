#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import saxes from 'saxes';
import { listSourceAssets } from './asset-roots.mjs';

const PROJECT_NAME = 'Redemptis-Tiariea';
const HEAD_DIRECTOR = 'Arcyriea (Head Director)';
const BACKUP_DIR = path.resolve('scripts/backups/svg-copyright');
const OWNERSHIP_FILE = path.resolve('scripts/svg-ownership.json');

const OWNERSHIP_TYPES = {
    PROJECT_OWNED: 'PROJECT_OWNED',
    THIRD_PARTY: 'THIRD_PARTY',
    COLLABORATOR_OWNED: 'COLLABORATOR_OWNED',
    UNKNOWN: 'UNKNOWN'
};

/**
 * Generates the RDF/Dublin Core metadata block.
 */
export function generateMetadataBlock(title) {
    var currentYear = new Date().getFullYear();
    var rightsNotice = 'Copyright (c) ' + currentYear + ' ' + PROJECT_NAME + '. All rights reserved.';
    var rightsStatement = 'Unauthorized reproduction, redistribution, modification, or commercial use requires prior written permission from the respective rights holders.';

    var titleElem = '';
    if (title) {
        titleElem = '\n        <dc:title>' + escapeXml(title) + '</dc:title>';
    }

    return `
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <rdf:Description rdf:about="">${titleElem}
        <dc:contributor>${escapeXml(HEAD_DIRECTOR)}</dc:contributor>
        <dc:rights>${escapeXml(rightsNotice)} ${escapeXml(rightsStatement)}</dc:rights>
        <dc:description>${escapeXml(PROJECT_NAME)} project asset attribution.</dc:description>
        </rdf:Description>
    </rdf:RDF>`;
}

/**
 * Escapes text for XML output.
 * Escapes XML special characters.
 */
export function escapeXml(unsafe) {
    return unsafe.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return c;
        }
    });
}

/**
 * Analyzes SVG metadata using saxes.
 * Returns { hasProjectMetadata: boolean, hasThirdPartyCopyright: boolean, title: string|null, isMalformed: boolean }
 */
export function analyzeSvgMetadata(content) {
    var parser = new saxes.SaxesParser();
    var result = {
        hasProjectMetadata: false,
        hasThirdPartyCopyright: false,
        title: null,
        isMalformed: false,
        currentElement: null,
        inMetadata: false
    };

    parser.on('error', function () {
        result.isMalformed = true;
    });

    parser.on('opentag', function (node) {
        result.currentElement = node.name;
        if (node.name === 'metadata') result.inMetadata = true;

        for (var attributeValue of Object.values(node.attributes)) {
            if (attributeValue.includes(PROJECT_NAME)) result.hasProjectMetadata = true;
        }
    });

    parser.on('text', function (text) {
        if (text.includes(PROJECT_NAME) && text.includes('Copyright')) {
            result.hasProjectMetadata = true;
        }
        if (result.inMetadata && result.currentElement === 'title') {
            result.title = text.trim();
        }
    });

    parser.on('closetag', function (node) {
        if (node.name === 'metadata') result.inMetadata = false;
        result.currentElement = null;
    });

    try {
        parser.write(content).close();
    } catch (e) {
        result.isMalformed = true;
    }
    return result;
}

/**
 * Validates that a string is well-formed XML.
 * @returns {boolean}
 */
export function isValidXml(content) {
    var parser = new saxes.SaxesParser();
    var isValid = true;
    parser.on('error', function () {
        isValid = false;
    });
    try {
        parser.write(content).close();
    } catch (e) {
        isValid = false;
    }
    return isValid;
}

/**
 * Inserts metadata into SVG source.
 */
export function insertMetadata(content, metadataBlock) {
    var metadataMatch = content.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i);
    if (metadataMatch) {
        var start = metadataMatch.index;
        var end = start + metadataMatch[0].length;
        var existingContent = metadataMatch[1];

        if (existingContent.includes(PROJECT_NAME)) {
            return null;
        }

        var modified = content.slice(0, end) + metadataBlock + content.slice(end);
        return isValidXml(modified) ? modified : null;
    }

    var svgMatch = content.match(/<svg\b[^>]*>/i);
    if (!svgMatch) return null;

    var endOfSvgTag = svgMatch.index + svgMatch[0].length;
    var modified = content.slice(0, endOfSvgTag) + '\n  <metadata>' + metadataBlock + '\n  </metadata>' + content.slice(endOfSvgTag);
    return isValidXml(modified) ? modified : null;
}

/**
 * Build the canonical inventory of all SVG assets from all source roots.
 * Each entry is { logicalPath, physicalSourcePath }.
 * This inventory includes all 36 SVG files (31 assets/ + 3 minimap + 2 root-level),
 * matching the previous utility's complete coverage.
 */
export async function buildCanonicalInventory() {
    var inventory = [];
    var seen = new Set();

    // Pull in every asset the source-root mapper knows about.
    // listSourceAssets() already returns 36 entries that comprehensively cover:
    //   - 31 assets/ SVGs (Components + Ships + Turrets-Platforms)
    //   - 3 minimap SVGs
    //   - 2 root-level SVGs (favicon.svg, icons.svg)
    try {
        var allSources = await listSourceAssets();
        for (var j = 0; j < allSources.length; j++) {
            var ref = allSources[j];
            var logicalPath = ref.logicalPath;
            if (seen.has(logicalPath)) {
                continue;
            }
            seen.add(logicalPath);
            inventory.push({
                logicalPath: logicalPath,
                physicalSourcePath: ref.physicalPath
            });
        }
    } catch (e) {
        // Failure to build the inventory is a fatal condition.
        console.error('Fatal: could not build canonical SVG inventory: ' + e.message);
        throw e;
    }

    return inventory;
}

function restoreInventory(inventory, backupDir) {
    var result = {
        restored: [],
        missingBackups: [],
        failed: []
    };

    for (var ref of inventory) {
        var logicalBackup = path.join(backupDir, ref.logicalPath);
        var legacyBackup = path.join(backupDir, 'public', ref.logicalPath);
        var backupPath = fs.existsSync(logicalBackup) ? logicalBackup :
            fs.existsSync(legacyBackup) ? legacyBackup : null;

        if (!backupPath) {
            result.missingBackups.push(ref.logicalPath);
            continue;
        }

        try {
            fs.writeFileSync(ref.physicalSourcePath, fs.readFileSync(backupPath));
            result.restored.push(ref.logicalPath);
        } catch (e) {
            result.failed.push(ref.logicalPath + ': restore failed: ' + e.message);
        }
    }

    return result;
}

/**
 * Run the copyright utility.
 */
export async function run({
    args = process.argv.slice(2),
    inventory: suppliedInventory,
    backupDir = BACKUP_DIR,
    ownershipFile = OWNERSHIP_FILE
} = {}) {
    var isDryRun = args.includes('--dry-run');
    var restoreBackups = args.includes('--restore');

    console.log('Starting SVG Copyright Utility ' + (isDryRun ? '(DRY RUN)' : '') +
        (restoreBackups ? ' (RESTORE MODE)' : '') + '...');

    var inventory = suppliedInventory;
    if (inventory === undefined) {
        try {
            inventory = await buildCanonicalInventory();
        } catch {
            return 1;
        }
    }

    if (inventory.length === 0) {
        console.error('Fatal: no SVG assets found in the canonical inventory.');
        return 1;
    }

    if (restoreBackups) {
        var restoration = restoreInventory(inventory, backupDir);
        console.log('\n--- Restore Summary ---');
        console.log('Total SVGs found: ' + inventory.length);
        console.log('Files restored:   ' + restoration.restored.length);
        console.log('Missing backups:  ' + restoration.missingBackups.length);
        console.log('Failed restores:  ' + restoration.failed.length);

        if (restoration.restored.length) {
            console.log('\nRestored Files:');
            restoration.restored.forEach(function (file) { console.log(' - ' + file); });
        }
        if (restoration.missingBackups.length) {
            console.log('\nMissing Backups:');
            restoration.missingBackups.forEach(function (file) { console.log(' - ' + file); });
        }
        if (restoration.failed.length) {
            console.log('\nFailed Restorations:');
            restoration.failed.forEach(function (file) { console.log(' - ' + file); });
        }

        return restoration.missingBackups.length || restoration.failed.length ? 1 : 0;
    }

    var ownershipData;
    try {
        ownershipData = JSON.parse(fs.readFileSync(ownershipFile, 'utf-8'));
    } catch (e) {
        console.error('Fatal: could not read ownership data: ' + e.message);
        return 1;
    }

    var report = {
        total: inventory.length,
        alreadyValid: 0,
        modified: 0,
        skippedOwnership: [],
        skippedAmbiguous: [],
        malformed: [],
        failed: []
    };

    for (var m = 0; m < inventory.length; m++) {
        var ref2 = inventory[m];
        var logicalPath = ref2.logicalPath;
        var physicalSourcePath = ref2.physicalSourcePath;

        // Read the canonical physical source file.
        var content;
        try {
            content = fs.readFileSync(physicalSourcePath, 'utf-8');
        } catch (e) {
            report.failed.push(logicalPath + ': failed to read physical source "' + physicalSourcePath + '": ' + e.message);
            continue;
        }

        // Resolve ownership using the logical asset identity. Ownership data keys
        // use the "public/..." format (e.g. "public/assets/Ships/Yutiarin Kinetic Lance Frigate.svg").
        var ownershipPrefixed = ownershipData.assets['public/' + logicalPath];
        var ownership = ownershipPrefixed || ownershipData.defaults.fallback;

        if (ownership === OWNERSHIP_TYPES.THIRD_PARTY ||
                ownership === OWNERSHIP_TYPES.COLLABORATOR_OWNED) {
            report.skippedOwnership.push(logicalPath + ' (' + ownership + ')');
            continue;
        }

        if (ownership === OWNERSHIP_TYPES.UNKNOWN) {
            report.skippedAmbiguous.push(logicalPath);
            continue;
        }

        // Validate the SVG's XML/Smetadata.
        var analysis = analyzeSvgMetadata(content);

        if (analysis.isMalformed) {
            report.malformed.push(logicalPath);
            continue;
        }

        if (analysis.hasProjectMetadata) {
            report.alreadyValid++;
            continue;
        }

        if (analysis.hasThirdPartyCopyright) {
            report.skippedAmbiguous.push(logicalPath + ' (contains third-party copyright)');
            continue;
        }

        var metadataBlock = generateMetadataBlock(analysis.title);
        var modifiedContent = insertMetadata(content, metadataBlock);

        if (!modifiedContent) {
            report.alreadyValid++;
            continue;
        }

        if (!isDryRun) {
            // Backup and write target the canonical physical source path.
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            var backupPath = path.join(backupDir, logicalPath);
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.writeFileSync(backupPath, content);

            fs.writeFileSync(physicalSourcePath, modifiedContent);
        }

        report.modified++;
    }

    console.log('\n--- Execution Summary ---');
    console.log('Total SVGs found: ' + report.total);
    console.log('Already valid:    ' + report.alreadyValid);
    console.log('Modified:         ' + report.modified);
    console.log('Malformed:        ' + report.malformed.length);
    console.log('Failed:           ' + report.failed.length);

    if (report.skippedOwnership.length) {
        console.log('\nSkipped (Ownership):');
        report.skippedOwnership.forEach(function (f) { console.log(' - ' + f); });
    }
    if (report.skippedAmbiguous.length) {
        console.log('\nSkipped (Ambiguous/Manual Review):');
        report.skippedAmbiguous.forEach(function (f) { console.log(' - ' + f); });
    }
    if (report.malformed.length) {
        console.log('\nMalformed Files:');
        report.malformed.forEach(function (f) { console.log(' - ' + f); });
    }
    if (report.failed.length) {
        console.log('\nFailed Modifications:');
        report.failed.forEach(function (f) { console.log(' - ' + f); });
    }

    if (!isDryRun && report.modified > 0) {
        console.log('\nBackups stored in: ' + backupDir);
    }

    return 0;
}

if (process.argv[1] && process.argv[1].endsWith('add-svg-copyright.mjs')) {
    run().then(function (exitCode) {
        if (exitCode) process.exitCode = exitCode;
    }).catch(function (err) {
        console.error('Unhandled error: ' + err.message);
        process.exitCode = 1;
    });
}