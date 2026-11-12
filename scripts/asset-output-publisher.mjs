import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
    link,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    unlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { validateCommittedAssetOutputs } from './package-assets.mjs';
import { inspectPrivateAssetsRoot } from './asset-registry.mjs';

const LOCK_NAME = '.asset-package.lock';
const JOURNAL_NAME = '.asset-package-transaction.jsonl';
const MANIFEST_RELATIVE = 'public/assets/asset-manifest.json';

function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function relativePath(projectRoot, absolutePath) {
    return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

async function assertSafeDestination(projectRoot, destination, allowGeneratedSource) {
    const root = path.resolve(projectRoot);
    const absolute = path.resolve(destination);
    const publicRoot = path.join(root, 'public', 'assets');
    const generatedRoot = path.join(root, 'src', 'generated');
    const underPublic = absolute.startsWith(`${publicRoot}${path.sep}`);
    const underGenerated = allowGeneratedSource && absolute.startsWith(`${generatedRoot}${path.sep}`);
    if (!underPublic && !underGenerated) {
        throw new Error(`Asset publication destination is outside generated output roots: ${absolute}`);
    }

    const relativeParent = path.relative(root, path.dirname(absolute));
    let current = root;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) {
                throw new Error(`Asset publication parent is not a real directory: ${current}`);
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                break;
            }
            throw error;
        }
    }
}

function resolveJournalPath(projectRoot, value, label) {
    if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/')) {
        throw new Error(`Asset publication journal has an unsafe ${label} path`);
    }
    const resolved = path.resolve(projectRoot, ...value.split('/'));
    if (!resolved.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
        throw new Error(`Asset publication journal ${label} escapes the project root`);
    }
    return resolved;
}

async function fileState(filePath) {
    let info;
    try {
        info = await lstat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false, sha256: null };
        }
        throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Asset publication path is not a regular file: ${filePath}`);
    }
    const bytes = await readFile(filePath);
    if (bytes.length !== info.size) {
        throw new Error(`Asset publication file changed while being read: ${filePath}`);
    }
    return { exists: true, sha256: hash(bytes) };
}

async function syncFile(filePath) {
    const handle = await open(filePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function readLock(lockPath) {
    const info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Asset packaging lock is not a regular file: ${lockPath}`);
    }
    const bytes = await readFile(lockPath);
    let owner;
    try {
        owner = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`Asset packaging lock is malformed; inspect it manually: ${error.message}`);
    }
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0
        || typeof owner.hostname !== 'string' || typeof owner.token !== 'string' || owner.token.length === 0) {
        throw new Error('Asset packaging lock has invalid ownership metadata; inspect it manually');
    }
    return { bytes, owner };
}

async function getProcessStartIdentity() {
    const estimatedStart = Date.now() - Math.round(process.uptime() * 1000);
    try {
        const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
        const processFields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const startTicks = processFields[19];
        if (startTicks && /^\d+$/.test(startTicks)) {
            return `linux-proc-start-ticks:${startTicks}`;
        }
    } catch (error) {
        if (!['ENOENT', 'EACCES', 'EINVAL'].includes(error.code)) {
            throw error;
        }
    }
    return `estimated-unix-ms:${estimatedStart}`;
}

async function acquireLock(projectRoot) {
    const privateRoots = await inspectPrivateAssetsRoot(projectRoot);
    if (!privateRoots) throw new Error(`Private source root is missing: ${path.join(projectRoot, 'private')}`);
    const privateRoot = privateRoots.privateRoot;
    const lockPath = path.join(privateRoot, LOCK_NAME);
    const owner = {
        pid: process.pid,
        hostname: hostname(),
        token: randomUUID(),
        startedAt: new Date().toISOString(),
        processStartIdentity: await getProcessStartIdentity()
    };
    const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`);

    try {
        const handle = await open(lockPath, 'wx');
        try {
            await handle.writeFile(ownerBytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
        return { lockPath, ownerBytes, owner };
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }

    const existing = await readLock(lockPath);
    throw new Error(
        `Asset packaging lock already exists; refusing recovery or publication. ` +
        `Lock metadata: ${JSON.stringify(existing.owner)}. Verify the owner and process state, then remove ` +
        `${lockPath} manually only if it is stale.`
    );
}

async function releaseLock({ lockPath, ownerBytes }) {
    const current = await readFile(lockPath);
    if (!current.equals(ownerBytes)) {
        throw new Error('Asset packaging lock ownership changed; refusing to remove it');
    }
    await unlink(lockPath);
}

async function scanTransactionArtifacts(directory, artifacts = []) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return artifacts;
        }
        throw error;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const info = await lstat(entryPath);
        if (info.isSymbolicLink()) {
            throw new Error(`Asset output tree contains a symbolic link: ${entryPath}`);
        }
        if (info.isDirectory()) {
            await scanTransactionArtifacts(entryPath, artifacts);
        } else if (info.isFile() && /\.rtab-[0-9a-f-]+\.(?:tmp|bak)$/.test(entry.name)) {
            artifacts.push(entryPath);
        } else if (!info.isFile()) {
            throw new Error(`Asset output tree contains a non-regular entry: ${entryPath}`);
        }
    }
    return artifacts;
}

async function readJournal(projectRoot) {
    const journalPath = path.join(projectRoot, 'private', JOURNAL_NAME);
    let bytes;
    try {
        bytes = await readFile(journalPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    const info = await lstat(journalPath);
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Asset publication journal is not a regular file: ${journalPath}`);
    }
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n')) {
        throw new Error(`Asset publication journal is truncated; preserve it and inspect manually: ${journalPath}`);
    }
    const lines = text.slice(0, -1).split('\n');
    const records = [];
    let activeTransactionId = null;
    let currentState = null;
    let pendingOperation = null;
    const operationIds = new Set();
    for (const [index, line] of lines.entries()) {
        let record;
        try {
            record = JSON.parse(line);
        } catch (error) {
            throw new Error(`Asset publication journal record ${index + 1} is invalid; preserve it and inspect manually: ${error.message}`);
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error(`Asset publication journal record ${index + 1} is not an object`);
        }
        if (!Number.isSafeInteger(record.sequence) || record.sequence !== index) {
            throw new Error(`Asset publication journal record ${index + 1} has a missing, duplicate, or reordered sequence number`);
        }
        const { checksum, ...unsigned } = record;
        if (typeof checksum !== 'string' || checksum !== journalChecksum(unsigned)) {
            throw new Error(`Asset publication journal record ${index + 1} has an invalid checksum`);
        }
        if (typeof record.transactionId !== 'string' || !record.transactionId) {
            throw new Error(`Asset publication journal record ${index + 1} has no transaction ID`);
        }
        if (index === 0) {
            if (record.type !== 'begin' || !Array.isArray(record.outputs) || !Array.isArray(record.staleOutputs)
                || record.state !== 'preparing') {
                throw new Error('Asset publication journal has no valid begin record');
            }
            activeTransactionId = record.transactionId;
            currentState = 'preparing';
        } else if (record.transactionId !== activeTransactionId) {
            throw new Error(`Asset publication journal record ${index + 1} belongs to an unknown transaction`);
        } else if (record.type === 'state') {
            if (pendingOperation) {
                throw new Error(`Asset publication journal state transition occurred before operation ${pendingOperation.operationId} completed`);
            }
            if (record.from !== currentState || !isAllowedStateTransition(currentState, record.to)) {
                throw new Error(`Asset publication journal has an invalid state transition at record ${index + 1}`);
            }
            if ((record.to === 'committed') !== (record.manifestCommitted === true)) {
                throw new Error(`Asset publication journal has an invalid manifest commit marker at record ${index + 1}`);
            }
            currentState = record.to;
        } else if (record.type === 'operation-intent') {
            if (pendingOperation) {
                throw new Error(`Asset publication journal has duplicate operation intent before completion at record ${index + 1}`);
            }
            if (!isAllowedOperation(record.operation, currentState)
                || typeof record.operationId !== 'string' || !record.operationId
                || operationIds.has(record.operationId)
                || typeof record.target !== 'string'
                || !isFileStateShape(record.before) || !isFileStateShape(record.after)
                || sameFileState(record.before, record.after)) {
                throw new Error(`Asset publication journal has an invalid operation intent at record ${index + 1}`);
            }
            operationIds.add(record.operationId);
            pendingOperation = record;
        } else if (record.type === 'operation-complete') {
            if (!pendingOperation || record.operationId !== pendingOperation.operationId
                || record.operation !== pendingOperation.operation
                || record.target !== pendingOperation.target
                || !['applied', 'not-applied'].includes(record.result)) {
                throw new Error(`Asset publication journal has completion without a matching intent at record ${index + 1}`);
            }
            pendingOperation = null;
        } else {
            throw new Error(`Asset publication journal has an unknown record type at record ${index + 1}`);
        }
        records.push(record);
    }
    const begin = records[0];
    return {
        journalPath,
        removeJournal: () => unlink(journalPath),
        records,
        begin,
        transactionId: begin.transactionId,
        state: currentState,
        pendingOperation,
        nextSequence: records.length
    };
}

function validateJournalEntry(projectRoot, entry, transactionId, stale = false) {
    if (!entry || typeof entry.destination !== 'string'
        || typeof entry.priorExists !== 'boolean'
        || (entry.priorExists && !/^[a-f0-9]{64}$/.test(entry.priorSha256))
        || (!entry.priorExists && entry.priorSha256 !== null)
        || !/^[a-f0-9]{64}$/.test(entry.newSha256 ?? entry.priorSha256 ?? '')) {
        if (!(stale && entry && typeof entry.destination === 'string'
            && typeof entry.priorExists === 'boolean'
            && (entry.priorExists ? /^[a-f0-9]{64}$/.test(entry.priorSha256) : entry.priorSha256 === null))) {
            throw new Error('Asset publication journal contains an invalid output entry');
        }
    }
    const destination = resolveJournalPath(projectRoot, entry.destination, 'destination');
    const isPublic = destination.startsWith(`${path.join(projectRoot, 'public', 'assets')}${path.sep}`);
    const isGenerated = destination.startsWith(`${path.join(projectRoot, 'src', 'generated')}${path.sep}`);
    if (!isPublic && (!isGenerated || stale)) {
        throw new Error(`Asset publication journal destination is outside generated output roots: ${destination}`);
    }
    let temporary = null;
    let backup = null;
    if (!stale) {
        if (entry.unchanged) {
            if (entry.temporary !== null || entry.backup !== null
                || !entry.priorExists || entry.priorSha256 !== entry.newSha256) {
                throw new Error(`Asset publication journal has inconsistent unchanged output metadata for ${destination}`);
            }
            return { ...entry, destination, temporary: null, backup: null };
        }
        temporary = resolveJournalPath(projectRoot, entry.temporary, 'temporary');
        backup = entry.backup === null
            ? null
            : resolveJournalPath(projectRoot, entry.backup, 'backup');
        const expectedPrefix = `${destination}.rtab-${transactionId}.`;
        if (!temporary.startsWith(expectedPrefix) || !temporary.endsWith('.tmp')
            || (entry.priorExists
                ? (!backup || !backup.startsWith(expectedPrefix) || !backup.endsWith('.bak'))
                : backup !== null)
            || !/^[a-f0-9]{64}$/.test(entry.newSha256)) {
            throw new Error(`Asset publication journal has unsafe temporary or backup paths for ${destination}`);
        }
    }
    return { ...entry, destination, temporary, backup };
}

function sortJson(value) {
    if (Array.isArray(value)) {
        return value.map(sortJson);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
    }
    return value;
}

function journalChecksum(record) {
    return hash(Buffer.from(JSON.stringify(sortJson(record))));
}

function signedJournalRecord(fields) {
    return { ...fields, checksum: journalChecksum(fields) };
}

function isFileStateShape(value) {
    return value && typeof value === 'object' && typeof value.exists === 'boolean'
        && (value.exists ? /^[a-f0-9]{64}$/.test(value.sha256) : value.sha256 === null);
}

function sameFileState(left, right) {
    return left.exists === right.exists && left.sha256 === right.sha256;
}

const STATE_TRANSITIONS = Object.freeze({
    preparing: ['staging', 'rolling-back'],
    staging: ['publishing', 'rolling-back'],
    publishing: ['validating', 'rolling-back'],
    validating: ['committed', 'rolling-back'],
    committed: ['retiring'],
    retiring: ['complete'],
    'rolling-back': ['rolled-back'],
    complete: [],
    'rolled-back': []
});

const OPERATION_STATES = Object.freeze({
    'stage-temp': ['staging'],
    'backup-prior': ['publishing'],
    'remove-destination': ['publishing'],
    'publish-output': ['publishing'],
    'retire-stale': ['retiring'],
    'remove-backup': ['retiring', 'rolling-back'],
    'remove-temp': ['retiring', 'rolling-back'],
    'restore-prior': ['rolling-back'],
    'remove-new-output': ['rolling-back']
});

function isAllowedStateTransition(from, to) {
    return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

function isAllowedOperation(operation, state) {
    return OPERATION_STATES[operation]?.includes(state) ?? false;
}

async function appendJournal(journal, fields) {
    const payload = {
        ...fields,
        transactionId: journal.transactionId,
        sequence: journal.nextSequence
    };
    const record = signedJournalRecord(payload);
    const handle = await open(journal.journalPath, 'a');
    try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
    journal.records.push(record);
    journal.nextSequence += 1;
    if (record.type === 'state') {
        journal.state = record.to;
    }
    return record;
}

async function appendJournalState(journal, to) {
    if (journal.state === to) {
        return;
    }
    if (!isAllowedStateTransition(journal.state, to)) {
        throw new Error(`Invalid asset transaction state transition ${journal.state} -> ${to}`);
    }
    await appendJournal(journal, {
        type: 'state',
        from: journal.state,
        to,
        ...(to === 'committed' ? { manifestCommitted: true } : {})
    });
}

async function runJournaledOperation(journal, operation, target, expectedBefore, after, mutate) {
    if (!isAllowedOperation(operation, journal.state)) {
        throw new Error(`Asset operation "${operation}" is not allowed in transaction state "${journal.state}"`);
    }
    const before = await fileState(target);
    if (!sameFileState(before, expectedBefore)) {
        throw new Error(`Asset operation "${operation}" found an unexpected before-state; preserving it: ${target}`);
    }
    const operationId = randomUUID();
    const intent = {
        type: 'operation-intent',
        operationId,
        operation,
        target: relativePath(path.dirname(path.dirname(journal.journalPath)), target),
        before: expectedBefore,
        after
    };
    await appendJournal(journal, intent);
    await mutate();
    const actual = await fileState(target);
    if (!sameFileState(actual, after)) {
        throw new Error(`Asset operation "${operation}" did not produce its journaled after-state: ${target}`);
    }
    await appendJournal(journal, {
        type: 'operation-complete',
        operationId,
        operation,
        target: intent.target,
        result: 'applied'
    });
}

async function removeExact(filePath, expectedHash, label) {
    const state = await fileState(filePath);
    if (!state.exists) {
        return;
    }
    if (expectedHash && state.sha256 !== expectedHash) {
        throw new Error(`${label} has unexpected contents; preserving it: ${filePath}`);
    }
    await unlink(filePath);
}

async function createPublicationLink(source, destination, linkFile) {
    try {
        await linkFile(source, destination);
    } catch (error) {
        if (['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) {
            throw new Error(
                `Asset publication requires hard-link support on the same filesystem (${error.code}): ${destination}`,
                { cause: error }
            );
        }
        throw error;
    }
}

async function rollbackTransaction(projectRoot, journal, { preserveRecoveryArtifacts = false } = {}) {
    const { begin } = journal;
    const outputs = begin.outputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId));
    const stale = begin.staleOutputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId, true));
    const states = [];

    for (const entry of outputs) {
        if (entry.unchanged) {
            const unchangedState = await fileState(entry.destination);
            const temporaryState = entry.temporary
                ? await fileState(entry.temporary)
                : { exists: false, sha256: null };
            const backupState = entry.backup
                ? await fileState(entry.backup)
                : { exists: false, sha256: null };
            if (!unchangedState.exists || unchangedState.sha256 !== entry.newSha256
                || temporaryState.exists || backupState.exists) {
                throw new Error(`Unchanged asset output no longer matches the transaction: ${entry.destination}`);
            }
            continue;
        }
        const destinationState = await fileState(entry.destination);
        const backupState = entry.backup ? await fileState(entry.backup) : { exists: false, sha256: null };
        const temporaryState = await fileState(entry.temporary);

        if (backupState.exists && (!entry.priorExists || backupState.sha256 !== entry.priorSha256)) {
            throw new Error(`Asset output backup has unexpected contents; preserving it: ${entry.backup}`);
        }
        if (temporaryState.exists && temporaryState.sha256 !== entry.newSha256) {
            throw new Error(`Asset output temporary file is incomplete or unexpected; preserving it: ${entry.temporary}`);
        }
        const destinationIsPrior = destinationState.exists && entry.priorExists
            && destinationState.sha256 === entry.priorSha256;
        const destinationIsNew = destinationState.exists && destinationState.sha256 === entry.newSha256;
        if (destinationState.exists && !destinationIsPrior && !destinationIsNew) {
            throw new Error(`Asset output has unexpected contents during rollback; preserving it: ${entry.destination}`);
        }
        if (!destinationState.exists && entry.priorExists && !backupState.exists) {
            throw new Error(`Prior asset output and verified backup are both missing: ${entry.destination}`);
        }
        if (destinationIsNew && entry.priorExists && !backupState.exists) {
            throw new Error(`Cannot restore prior asset output because its verified backup is missing: ${entry.destination}`);
        }
        states.push({ entry, destinationState, backupState, temporaryState, destinationIsPrior });
    }

    for (const entry of stale) {
        const state = await fileState(entry.destination);
        if (state.exists !== entry.priorExists || (state.exists && state.sha256 !== entry.priorSha256)) {
            throw new Error(`Pending stale asset output changed during rollback; preserving it: ${entry.destination}`);
        }
    }

    if (journal.state === 'rolled-back') {
        await verifyRolledBackTransaction(projectRoot, journal);
        await journal.removeJournal();
        return;
    }
    if (journal.state !== 'rolling-back') {
        await appendJournalState(journal, 'rolling-back');
    }

    for (const state of [...states].reverse()) {
        const { entry, destinationState, backupState, temporaryState, destinationIsPrior } = state;
        if (entry.priorExists && !destinationIsPrior) {
            if (destinationState.exists) {
                await runJournaledOperation(
                    journal,
                    'remove-new-output',
                    entry.destination,
                    destinationState,
                    { exists: false, sha256: null },
                    () => unlink(entry.destination)
                );
            }
            await runJournaledOperation(
                journal,
                'restore-prior',
                entry.destination,
                { exists: false, sha256: null },
                { exists: true, sha256: entry.priorSha256 },
                () => createPublicationLink(entry.backup, entry.destination, link)
            );
        } else if (!entry.priorExists && destinationState.exists) {
            await runJournaledOperation(
                journal,
                'remove-new-output',
                entry.destination,
                destinationState,
                { exists: false, sha256: null },
                () => unlink(entry.destination)
            );
        }
        const restoredState = await fileState(entry.destination);
        if (entry.priorExists && (!restoredState.exists || restoredState.sha256 !== entry.priorSha256)) {
            throw new Error(`Prior asset output could not be restored exactly: ${entry.destination}`);
        }
        if (!entry.priorExists && restoredState.exists) {
            throw new Error(`New asset output remains after rollback: ${entry.destination}`);
        }
        if (backupState.exists && !preserveRecoveryArtifacts) {
            await runJournaledOperation(
                journal,
                'remove-backup',
                entry.backup,
                backupState,
                { exists: false, sha256: null },
                () => removeExact(entry.backup, entry.priorSha256, 'Asset output backup')
            );
        }
        if (temporaryState.exists && !preserveRecoveryArtifacts) {
            await runJournaledOperation(
                journal,
                'remove-temp',
                entry.temporary,
                temporaryState,
                { exists: false, sha256: null },
                () => removeExact(entry.temporary, entry.newSha256, 'Asset output temporary file')
            );
        }
    }
    if (!preserveRecoveryArtifacts) {
        await appendJournalState(journal, 'rolled-back');
        await journal.removeJournal();
    }
}

async function verifyRolledBackTransaction(projectRoot, journal) {
    const { begin } = journal;
    const outputs = begin.outputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId));
    const stale = begin.staleOutputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId, true));

    for (const entry of outputs) {
        const destination = await fileState(entry.destination);
        if (destination.exists !== entry.priorExists
            || (destination.exists && destination.sha256 !== entry.priorSha256)) {
            throw new Error(`Rolled-back asset output no longer matches its prior state; preserving journal: ${entry.destination}`);
        }
        for (const artifact of [entry.temporary, entry.backup]) {
            if (!artifact) {
                continue;
            }
            const state = await fileState(artifact);
            if (state.exists) {
                throw new Error(`Rolled-back asset transaction artifact remains; preserving it and the journal: ${artifact}`);
            }
        }
    }

    for (const entry of stale) {
        const state = await fileState(entry.destination);
        if (state.exists !== entry.priorExists || (state.exists && state.sha256 !== entry.priorSha256)) {
            throw new Error(`Rolled-back stale output no longer matches its prior state; preserving journal: ${entry.destination}`);
        }
    }
}

async function validateCommittedTransaction(projectRoot, journal) {
    const { begin } = journal;
    const outputs = begin.outputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId));
    const manifest = outputs.find((entry) => (
        entry.destination === path.resolve(projectRoot, ...MANIFEST_RELATIVE.split('/'))
    ));
    if (!manifest) {
        throw new Error('Asset publication journal does not include the new manifest');
    }
    const manifestState = await fileState(manifest.destination);
    if (!manifestState.exists || manifestState.sha256 !== manifest.newSha256) {
        return false;
    }
    for (const entry of outputs) {
        const state = await fileState(entry.destination);
        if (!state.exists || state.sha256 !== entry.newSha256) {
            if (journal.state !== 'committed' && journal.state !== 'retiring' && journal.state !== 'complete') {
                return false;
            }
            throw new Error(`Committed asset output does not match its journal hash: ${entry.destination}`);
        }
    }
    await validateCommittedAssetOutputs({ projectRoot });
    return true;
}

async function completeCommittedTransaction(projectRoot, journal) {
    if (!await validateCommittedTransaction(projectRoot, journal)) {
        throw new Error('Committed asset outputs are no longer valid; preserving transaction artifacts');
    }
    const { begin } = journal;
    if (journal.state === 'committed') {
        await appendJournalState(journal, 'retiring');
    }
    const outputs = begin.outputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId));
    const stale = begin.staleOutputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId, true));
    const staleStates = [];
    for (const entry of stale) {
        const state = await fileState(entry.destination);
        if (state.exists && (!entry.priorExists || state.sha256 !== entry.priorSha256)) {
            throw new Error(`Pending stale output is ambiguous; preserving transaction artifacts: ${entry.destination}`);
        }
        staleStates.push({ entry, state });
    }
    for (const entry of outputs) {
        if (entry.backup) {
            const state = await fileState(entry.backup);
            if (state.exists && (!entry.priorExists || state.sha256 !== entry.priorSha256)) {
                throw new Error(`Asset output backup is ambiguous; preserving it: ${entry.backup}`);
            }
        }
        if (entry.temporary) {
            const state = await fileState(entry.temporary);
            if (state.exists && state.sha256 !== entry.newSha256) {
                throw new Error(`Asset output temporary file is ambiguous; preserving it: ${entry.temporary}`);
            }
        }
    }
    for (const { entry, state } of staleStates) {
        if (state.exists) {
            await runJournaledOperation(
                journal,
                'retire-stale',
                entry.destination,
                state,
                { exists: false, sha256: null },
                () => unlink(entry.destination)
            );
        }
    }
    for (const entry of outputs) {
        if (entry.backup) {
            const state = await fileState(entry.backup);
            if (state.exists) {
                await runJournaledOperation(
                    journal,
                    'remove-backup',
                    entry.backup,
                    state,
                    { exists: false, sha256: null },
                    () => removeExact(entry.backup, entry.priorExists ? entry.priorSha256 : null, 'Asset output backup')
                );
            }
        }
        if (entry.temporary) {
            const state = await fileState(entry.temporary);
            if (state.exists) {
                await runJournaledOperation(
                    journal,
                    'remove-temp',
                    entry.temporary,
                    state,
                    { exists: false, sha256: null },
                    () => removeExact(entry.temporary, entry.newSha256, 'Asset output temporary file')
                );
            }
        }
    }
    await appendJournalState(journal, 'complete');
    await unlink(journal.journalPath);
}

async function findTransactionArtifacts(projectRoot) {
    const roots = [
        path.join(projectRoot, 'private'),
        path.join(projectRoot, 'public', 'assets'),
        path.join(projectRoot, 'src', 'generated')
    ];
    const artifacts = [];
    for (const root of roots) {
        await scanTransactionArtifacts(root, artifacts);
    }
    return artifacts;
}

export async function assertNoPendingAssetOutputTransaction(projectRoot) {
    const privateRoot = path.join(projectRoot, 'private');
    const lockPath = path.join(privateRoot, LOCK_NAME);
    const journalPath = path.join(privateRoot, JOURNAL_NAME);
    for (const [filePath, label] of [[lockPath, 'lock'], [journalPath, 'journal']]) {
        try {
            const info = await lstat(filePath);
            if (info.isSymbolicLink() || !info.isFile()) {
                throw new Error(`Clean-clone validation found a non-regular asset publication ${label}: ${filePath}`);
            }
            throw new Error(`Clean-clone validation found an asset publication ${label}; preserving it without recovery: ${filePath}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    const artifacts = await findTransactionArtifacts(projectRoot);
    if (artifacts.length > 0) {
        throw new Error(`Clean-clone validation found an asset publication artifact; preserving it without recovery: ${artifacts[0]}`);
    }
}

export async function recoverAssetOutputTransaction(projectRoot, { removeJournal = unlink } = {}) {
    const journal = await readJournal(projectRoot);
    const artifacts = await findTransactionArtifacts(projectRoot);
    if (!journal) {
        if (artifacts.length > 0) {
            throw new Error(`Orphan asset publication temporary or backup file found; inspect manually: ${artifacts[0]}`);
        }
        return { recovered: false };
    }
    journal.removeJournal = () => removeJournal(journal.journalPath);

    const { begin } = journal;
    const outputs = begin.outputs.map((entry) => validateJournalEntry(projectRoot, entry, begin.transactionId));
    const destinations = new Set();
    const expectedArtifacts = new Set();
    const expectedOperationTargets = new Set();
    for (const entry of outputs) {
        if (destinations.has(entry.destination)) {
            throw new Error(`Asset publication journal repeats an output destination: ${entry.destination}`);
        }
        destinations.add(entry.destination);
        expectedOperationTargets.add(entry.destination);
        for (const artifact of [entry.temporary, entry.backup]) {
            if (artifact) {
                expectedOperationTargets.add(artifact);
                if (expectedArtifacts.has(artifact)) {
                    throw new Error(`Asset publication journal repeats a temporary or backup path: ${artifact}`);
                }
                expectedArtifacts.add(artifact);
            }
        }
    }
    const staleDestinations = new Set();
    for (const entry of begin.staleOutputs.map((item) => validateJournalEntry(projectRoot, item, begin.transactionId, true))) {
        if (destinations.has(entry.destination) || staleDestinations.has(entry.destination)) {
            throw new Error(`Asset publication journal has conflicting stale-output ownership: ${entry.destination}`);
        }
        staleDestinations.add(entry.destination);
        expectedOperationTargets.add(entry.destination);
    }
    for (const record of journal.records) {
        if (record.type === 'operation-intent') {
            const target = resolveJournalPath(projectRoot, record.target, 'operation target');
            if (!expectedOperationTargets.has(target)) {
                throw new Error(`Asset publication journal operation targets an unowned path; preserving it: ${target}`);
            }
        }
    }
    for (const artifact of artifacts) {
        if (!expectedArtifacts.has(artifact)) {
            throw new Error(`Unreferenced asset publication artifact is ambiguous; preserving it: ${artifact}`);
        }
    }

    if (journal.pendingOperation) {
        const operation = journal.pendingOperation;
        const target = resolveJournalPath(projectRoot, operation.target, 'operation target');
        const actual = await fileState(target);
        let result;
        if (sameFileState(actual, operation.after)) {
            result = 'applied';
        } else if (sameFileState(actual, operation.before)) {
            result = 'not-applied';
        } else {
            throw new Error(`Interrupted asset operation has an unexpected filesystem state; preserving journal and artifacts: ${target}`);
        }
        await appendJournal(journal, {
            type: 'operation-complete',
            operationId: operation.operationId,
            operation: operation.operation,
            target: operation.target,
            result
        });
        journal.pendingOperation = null;
    }

    if (journal.state === 'rolled-back') {
        await verifyRolledBackTransaction(projectRoot, journal);
        await journal.removeJournal();
        return { recovered: true, mode: 'finalized-rollback' };
    }

    const committedOutputsValid = await validateCommittedTransaction(projectRoot, journal);
    if (['committed', 'retiring', 'complete'].includes(journal.state) && !committedOutputsValid) {
        throw new Error('Committed asset transaction outputs are invalid; preserving journal, backups, and uncertain artifacts');
    }
    if (committedOutputsValid && ['preparing', 'staging', 'publishing', 'validating'].includes(journal.state)) {
        while (journal.state !== 'validating') {
            const nextState = {
                preparing: 'staging',
                staging: 'publishing',
                publishing: 'validating'
            }[journal.state];
            if (!nextState) {
                throw new Error(`Cannot validate recovered transaction from state "${journal.state}"`);
            }
            await appendJournalState(journal, nextState);
        }
        await appendJournalState(journal, 'committed');
    }
    if (committedOutputsValid && ['committed', 'retiring', 'complete'].includes(journal.state)) {
        await completeCommittedTransaction(projectRoot, journal);
        return { recovered: true, mode: 'completed-commit' };
    }
    await rollbackTransaction(projectRoot, journal);
    return { recovered: true, mode: 'rolled-back' };
}

export async function withAssetOutputLock(projectRoot, action, recoveryOptions) {
    const lock = await acquireLock(projectRoot);
    try {
        await recoverAssetOutputTransaction(projectRoot, recoveryOptions);
        return await action();
    } finally {
        await releaseLock(lock);
    }
}

function toOutputBytes(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function outputOrder([leftPath], [rightPath]) {
    const leftManifest = path.basename(leftPath) === 'asset-manifest.json';
    const rightManifest = path.basename(rightPath) === 'asset-manifest.json';
    if (leftManifest !== rightManifest) {
        return leftManifest ? 1 : -1;
    }
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

async function stageOutput(entry, bytes) {
    await mkdir(path.dirname(entry.temporary), { recursive: true });
    await writeFile(entry.temporary, bytes, { flag: 'wx' });
    await syncFile(entry.temporary);
    const state = await fileState(entry.temporary);
    if (!state.exists || state.sha256 !== entry.newSha256) {
        throw new Error(`Staged asset output failed SHA-256 verification: ${entry.temporary}`);
    }
}

export async function publishAssetOutputs({
    projectRoot,
    outputs,
    stalePaths = [],
    linkFile = link,
    onOutputPublished = async () => {},
    validatePublishedOutputs
}) {
    if (typeof validatePublishedOutputs !== 'function') {
        throw new TypeError('publishAssetOutputs requires an explicit validatePublishedOutputs callback');
    }

    const transactionId = randomUUID();
    const outputEntries = [];
    const staleEntries = [];
    for (const [destination, contents] of [...outputs].sort(outputOrder)) {
        const absoluteDestination = path.resolve(destination);
        await assertSafeDestination(projectRoot, absoluteDestination, true);
        const newBytes = toOutputBytes(contents);
        const prior = await fileState(absoluteDestination);
        const relative = relativePath(projectRoot, absoluteDestination);
        const addressed = /^public\/assets\/bundles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-f0-9]{64})\.bin$/.exec(relative);
        if (addressed) {
            const expectedHash = addressed[2];
            const newHash = hash(newBytes);
            if (newHash !== expectedHash || (prior.exists && prior.sha256 !== expectedHash)) {
                throw new Error(`Immutable content-addressed bundle does not match its path and cannot be replaced: ${absoluteDestination}`);
            }
        }
        const unchanged = prior.exists && prior.sha256 === hash(newBytes);
        const prefix = `${absoluteDestination}.rtab-${transactionId}`;
        outputEntries.push({
            destination: absoluteDestination,
            priorExists: prior.exists,
            priorSha256: prior.sha256,
            temporary: unchanged ? null : `${prefix}.tmp`,
            backup: unchanged || !prior.exists ? null : `${prefix}.bak`,
            newSha256: hash(newBytes),
            bytes: newBytes,
            unchanged
        });
    }

    const outputPaths = new Set(outputEntries.map((entry) => entry.destination));
    for (const stalePath of stalePaths) {
        const destination = path.resolve(stalePath);
        await assertSafeDestination(projectRoot, destination, false);
        if (outputPaths.has(destination)) {
            continue;
        }
        const prior = await fileState(destination);
        staleEntries.push({
            destination: relativePath(projectRoot, destination),
            priorExists: prior.exists,
            priorSha256: prior.sha256
        });
    }

    const journalPath = path.join(projectRoot, 'private', JOURNAL_NAME);
    const begin = signedJournalRecord({
        type: 'begin',
        transactionId,
        sequence: 0,
        state: 'preparing',
        outputs: outputEntries.map((entry) => ({
            destination: relativePath(projectRoot, entry.destination),
            priorExists: entry.priorExists,
            priorSha256: entry.priorSha256,
            temporary: entry.temporary ? relativePath(projectRoot, entry.temporary) : null,
            backup: entry.backup ? relativePath(projectRoot, entry.backup) : null,
            newSha256: entry.newSha256,
            unchanged: entry.unchanged
        })),
        staleOutputs: staleEntries
    });
    const handle = await open(journalPath, 'wx');
    try {
        await handle.writeFile(`${JSON.stringify(begin)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
    const journal = {
        journalPath,
        transactionId,
        begin,
        removeJournal: () => unlink(journalPath),
        records: [begin],
        state: 'preparing',
        pendingOperation: null,
        nextSequence: 1
    };

    let postPublicationValidationFailed = false;
    try {
        await appendJournalState(journal, 'staging');
        for (const entry of outputEntries) {
            if (entry.unchanged) {
                continue;
            }
            await runJournaledOperation(
                journal,
                'stage-temp',
                entry.temporary,
                { exists: false, sha256: null },
                { exists: true, sha256: entry.newSha256 },
                () => stageOutput(entry, entry.bytes)
            );
        }

        await appendJournalState(journal, 'publishing');
        for (const entry of outputEntries) {
            if (entry.unchanged) {
                await onOutputPublished(entry.destination);
                continue;
            }
            const prior = await fileState(entry.destination);
            if (entry.priorExists) {
                if (!prior.exists || prior.sha256 !== entry.priorSha256) {
                    throw new Error(`Asset output changed after publication preflight: ${entry.destination}`);
                }
                await runJournaledOperation(
                    journal,
                    'backup-prior',
                    entry.backup,
                    { exists: false, sha256: null },
                    { exists: true, sha256: entry.priorSha256 },
                    () => createPublicationLink(entry.destination, entry.backup, linkFile)
                );
                const stillPrior = await fileState(entry.destination);
                if (!stillPrior.exists || stillPrior.sha256 !== entry.priorSha256) {
                    throw new Error(`Asset output changed while its backup was being created: ${entry.destination}`);
                }
                await runJournaledOperation(
                    journal,
                    'remove-destination',
                    entry.destination,
                    { exists: true, sha256: entry.priorSha256 },
                    { exists: false, sha256: null },
                    () => unlink(entry.destination)
                );
            } else if (prior.exists) {
                throw new Error(`Asset output appeared after publication preflight: ${entry.destination}`);
            }
            await runJournaledOperation(
                journal,
                'publish-output',
                entry.destination,
                { exists: false, sha256: null },
                { exists: true, sha256: entry.newSha256 },
                () => createPublicationLink(entry.temporary, entry.destination, linkFile)
            );
            await onOutputPublished(entry.destination);
        }

        await appendJournalState(journal, 'validating');
        try {
            await validatePublishedOutputs();
        } catch (error) {
            postPublicationValidationFailed = true;
            throw error;
        }
        if (!await validateCommittedTransaction(projectRoot, journal)) {
            throw new Error('New asset manifest was not committed as the validated output set');
        }
        await appendJournalState(journal, 'committed');
        await appendJournalState(journal, 'retiring');
        for (const stale of staleEntries) {
            const destination = path.resolve(projectRoot, ...stale.destination.split('/'));
            const current = await fileState(destination);
            if (current.exists !== stale.priorExists
                || (current.exists && current.sha256 !== stale.priorSha256)) {
                throw new Error(`Pending stale output changed before retirement: ${destination}`);
            }
            if (current.exists) {
                await runJournaledOperation(
                    journal,
                    'retire-stale',
                    destination,
                    current,
                    { exists: false, sha256: null },
                    () => unlink(destination)
                );
            }
        }
        for (const entry of outputEntries) {
            if (entry.backup) {
                const backupState = await fileState(entry.backup);
                if (backupState.exists) {
                    await runJournaledOperation(
                        journal,
                        'remove-backup',
                        entry.backup,
                        backupState,
                        { exists: false, sha256: null },
                        () => removeExact(entry.backup, entry.priorSha256, 'Asset output backup')
                    );
                }
            }
            if (entry.temporary) {
                const temporaryState = await fileState(entry.temporary);
                if (temporaryState.exists) {
                    await runJournaledOperation(
                        journal,
                        'remove-temp',
                        entry.temporary,
                        temporaryState,
                        { exists: false, sha256: null },
                        () => removeExact(entry.temporary, entry.newSha256, 'Asset output temporary file')
                    );
                }
            }
        }
        await appendJournalState(journal, 'complete');
        await unlink(journalPath);
        return { transactionId, outputFiles: outputEntries.length, staleFiles: staleEntries.length };
    } catch (error) {
        const pendingJournal = await readJournal(projectRoot);
        if (pendingJournal) {
            try {
                if (['committed', 'retiring', 'complete'].includes(pendingJournal.state)) {
                    throw new Error(
                        `Asset outputs are committed; preserving the journal for locked completion recovery: ${error.message}`,
                        { cause: error }
                    );
                }
                if (pendingJournal.pendingOperation) {
                    const operation = pendingJournal.pendingOperation;
                    const target = resolveJournalPath(projectRoot, operation.target, 'operation target');
                    const actual = await fileState(target);
                    let result;
                    if (sameFileState(actual, operation.after)) {
                        result = 'applied';
                    } else if (sameFileState(actual, operation.before)) {
                        result = 'not-applied';
                    } else {
                        throw new Error(`Interrupted asset operation has unexpected contents: ${target}`);
                    }
                    await appendJournal(pendingJournal, {
                        type: 'operation-complete',
                        operationId: operation.operationId,
                        operation: operation.operation,
                        target: operation.target,
                        result
                    });
                    pendingJournal.pendingOperation = null;
                }
                await rollbackTransaction(projectRoot, pendingJournal, {
                    preserveRecoveryArtifacts: postPublicationValidationFailed
                });
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    `Asset output publication failed and rollback was incomplete: ${rollbackError.message}`
                );
            }
        }
        if (postPublicationValidationFailed) {
            throw new Error(
                `Post-publication validation failed; prior outputs were restored and recovery artifacts were preserved: ${error.message}`,
                { cause: error }
            );
        }
        throw error;
    }
}
