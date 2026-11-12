import { createHash } from 'node:crypto';
import { unlink, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function markerPath(projectRoot) {
    const key = createHash('sha256').update(path.resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), `redemptis-predev-${key}.json`);
}

export async function writeDevPrepareMarker(projectRoot, generationId) {
    const filePath = markerPath(projectRoot);
    await writeFile(filePath, JSON.stringify({
        generationId,
        createdAt: Date.now()
    }), { encoding: 'utf8', flag: 'w' });
}

/** Consume a short-lived marker written only after a successful npm predev reconciliation. */
export async function consumeDevPrepareMarker(projectRoot) {
    const filePath = markerPath(projectRoot);
    let source;
    try {
        source = await readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    } finally {
        await unlink(filePath).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
    let marker;
    try {
        marker = JSON.parse(source);
    } catch {
        return null;
    }
    if (!marker || !/^[a-f0-9]{64}$/.test(marker.generationId)
        || !Number.isSafeInteger(marker.createdAt)
        || Date.now() - marker.createdAt < 0 || Date.now() - marker.createdAt > 120_000) {
        return null;
    }
    return marker.generationId;
}
