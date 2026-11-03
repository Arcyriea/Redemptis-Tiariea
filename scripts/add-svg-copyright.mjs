import fs from 'node:fs';
import path from 'node:path';
import saxes from 'saxes';

const PROJECT_NAME = 'Redemptis-Tiariea';
const HEAD_DIRECTOR = 'Arcyriea (Head Director)';
const PUBLIC_DIR = path.resolve('public');
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
function generateMetadataBlock(title = null) {
    const currentYear = new Date().getFullYear();
    const rightsNotice = `Copyright (c) ${currentYear} ${PROJECT_NAME}. All rights reserved.`;
    const rightsStatement = 'Unauthorized reproduction, redistribution, modification, or commercial use requires prior written permission from the respective rights holders.';

    let titleElem = '';
    if (title) {
        titleElem = `\n        <dc:title>${escapeXml(title)}</dc:title>`;
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

function escapeXml(unsafe) {
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
    const parser = new saxes.SaxesParser();
    let result = {
        hasProjectMetadata: false,
        hasThirdPartyCopyright: false,
        title: null,
        isMalformed: false,
        currentElement: null,
        inMetadata: false
    };

    parser.onerror = (e) => {
        // SVG files often have non-standard tags or attributes that saxes might flag as errors.
        // For the purpose of metadata inspection, we can be lenient.
        parser.resume();
    };

    parser.onopentag = (node) => {
        result.currentElement = node.name;
        if (node.name === 'metadata') result.inMetadata = true;
        
        // Check for project identification in attributes if any
        for (const [key, val] of Object.entries(node.attributes)) {
            if (val.includes(PROJECT_NAME)) result.hasProjectMetadata = true;
        }
    };

    parser.ontext = (text) => {
        if (text.includes(PROJECT_NAME) && text.includes('Copyright')) {
            result.hasProjectMetadata = true;
        }
        // REMOVED: Global "Copyright" check that flagged everything as third-party
        if (result.inMetadata && result.currentElement === 'title') {
            result.title = text.trim();
        }
    };

    parser.onclosetag = (name) => {
        if (name === 'metadata') result.inMetadata = false;
        result.currentElement = null;
    };

    try {
        parser.write(content).close();
    } catch (e) {
        // Swallow parsing errors during analysis to allow metadata insertion 
        // if we can find the tags via regex.
    }
    return result;
}

/**
 * Validates that a string is well-formed XML.
 * @returns {boolean}
 */
function isValidXml(content) {
    const parser = new saxes.SaxesParser();
    try {
        parser.write(content).close();
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Inserts metadata into SVG source.
 */
export function insertMetadata(content, metadataBlock) {
    // 1. Look for existing <metadata> tag
    const metadataMatch = content.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i);
    if (metadataMatch) {
        const start = metadataMatch.index;
        const end = start + metadataMatch[0].length;
        const existingContent = metadataMatch[1];

        // Avoid duplication
        if (existingContent.includes(PROJECT_NAME)) {
            return null;
        }

        const modified = content.slice(0, end) + metadataBlock + content.slice(end);
        return isValidXml(modified) ? modified : null;
    }

    // 2. Insert after opening <svg> tag
    const svgMatch = content.match(/<svg\b[^>]*>/i);
    if (!svgMatch) return null;

    const endOfSvgTag = svgMatch.index + svgMatch[0].length;
    const modified = content.slice(0, endOfSvgTag) + '\n  <metadata>' + metadataBlock + '\n  </metadata>' + content.slice(endOfSvgTag);
    return isValidXml(modified) ? modified : null;
}

async function run() {
    const args = process.argv.slice(2);
    const isDryRun = args.includes('--dry-run');
    const restoreBackups = args.includes('--restore');

    console.log(`Starting SVG Copyright Utility ${isDryRun ? '(DRY RUN)' : ''}${restoreBackups ? ' (RESTORE MODE)' : ''}...`);

    const ownershipData = JSON.parse(fs.readFileSync(OWNERSHIP_FILE, 'utf-8'));
    const files = [];

    // Recursive search
    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const res = path.resolve(dir, entry.name);
            if (entry.isDirectory()) {
                walk(res);
            } else if (entry.name.toLowerCase().endsWith('.svg')) {
                files.push(res);
            }
        }
    }
    walk(PUBLIC_DIR);

    const report = {
        total: files.length,
        alreadyValid: 0,
        modified: 0,
        restored: 0,
        skippedOwnership: [],
        skippedAmbiguous: [],
        malformed: [],
        failed: []
    };

    for (const filePath of files) {
        const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
        
        if (restoreBackups) {
            const backupPath = path.join(BACKUP_DIR, relativePath);
            if (fs.existsSync(backupPath)) {
                fs.writeFileSync(filePath, fs.readFileSync(backupPath));
                report.restored++;
            }
            continue;
        }

        const ownership = ownershipData.assets[relativePath] || ownershipData.defaults.fallback;

        if (ownership === OWNERSHIP_TYPES.THIRD_PARTY || ownership === OWNERSHIP_TYPES.COLLABORATOR_OWNED) {
            report.skippedOwnership.push(`${relativePath} (${ownership})`);
            continue;
        }

        if (ownership === OWNERSHIP_TYPES.UNKNOWN) {
            report.skippedAmbiguous.push(relativePath);
            continue;
        }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const analysis = analyzeSvgMetadata(content);

            if (analysis.isMalformed) {
                report.malformed.push(relativePath);
                continue;
            }

            if (analysis.hasProjectMetadata) {
                report.alreadyValid++;
                continue;
            }

            if (analysis.hasThirdPartyCopyright) {
                report.skippedAmbiguous.push(`${relativePath} (contains third-party copyright)`);
                continue;
            }

            const metadataBlock = generateMetadataBlock(analysis.title);
            const modifiedContent = insertMetadata(content, metadataBlock);

            if (!modifiedContent) {
                report.alreadyValid++;
                continue;
            }

            if (!isDryRun) {
                // Backup
                if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
                const backupPath = path.join(BACKUP_DIR, relativePath);
                fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                fs.writeFileSync(backupPath, content);

                // Write
                fs.writeFileSync(filePath, modifiedContent);
            }

            report.modified++;
        } catch (e) {
            report.failed.push(`${relativePath}: ${e.message}`);
        }
    }

    console.log('\n--- Execution Summary ---');
    console.log(`Total SVGs found: ${report.total}`);
    if (restoreBackups) {
        console.log(`Files restored:   ${report.restored}`);
    } else {
        console.log(`Already valid:   ${report.alreadyValid}`);
        console.log(`Modified:        ${report.modified}`);
        console.log(`Malformed:       ${report.malformed.length}`);
        console.log(`Failed:          ${report.failed.length}`);
    }

    if (report.skippedOwnership.length) {
        console.log('\nSkipped (Ownership):');
        report.skippedOwnership.forEach(f => console.log(` - ${f}`));
    }
    if (report.skippedAmbiguous.length) {
        console.log('\nSkipped (Ambiguous/Manual Review):');
        report.skippedAmbiguous.forEach(f => console.log(` - ${f}`));
    }
    if (report.malformed.length) {
        console.log('\nMalformed Files:');
        report.malformed.forEach(f => console.log(` - ${f}`));
    }
    if (report.failed.length) {
        console.log('\nFailed Modifications:');
        report.failed.forEach(f => console.log(` - ${f}`));
    }

    if (!isDryRun && !restoreBackups && report.modified > 0) {
        console.log(`\nBackups stored in: ${BACKUP_DIR}`);
    }
}

if (process.argv[1].endsWith('add-svg-copyright.mjs')) {
    run().catch(console.error);
}
