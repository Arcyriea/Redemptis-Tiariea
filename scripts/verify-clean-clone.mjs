#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT } from './asset-registry.mjs';

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function runNpm(args, cwd, timeout = 120_000) {
    const result = spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        shell: process.platform === 'win32'
    });
    if (result.error) throw result.error;
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function assertNpmSuccess(args, cwd) {
    const result = runNpm(args, cwd);
    if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status}):\n${result.output}`);
    return result.output;
}

async function runDevServer(cwd) {
    const child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '0'], {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    try {
        const deadline = Date.now() + 20_000;
        let response = null;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`npm run dev exited early:\n${output}`);
            const matches = [...output.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\//g)];
            const port = matches.length ? Number(matches[matches.length - 1][1]) : null;
            if (port) {
                try {
                    response = await fetch(`http://127.0.0.1:${port}/`);
                    if (response.ok) break;
                } catch { /* Vite has not bound the socket yet. */ }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!response?.ok) throw new Error(`npm run dev did not become ready:\n${output}`);
        if (!output.includes('skipped duplicate publication')) {
            throw new Error(`Vite did not consume the successful predev marker:\n${output}`);
        }
    } finally {
        if (child.pid && child.exitCode === null) {
            if (process.platform === 'win32') {
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } else {
                child.kill('SIGTERM');
            }
            await Promise.race([
                new Promise((resolve) => child.once('exit', resolve)),
                new Promise((resolve) => setTimeout(resolve, 3000))
            ]);
        }
    }
    return output;
}

async function copyProjectWithoutPrivate(destination) {
    await cp(PROJECT_ROOT, destination, {
        recursive: true,
        filter(source) {
            const relative = path.relative(PROJECT_ROOT, source).split(path.sep).join('/').toLowerCase();
            return !(relative === 'private' || relative.startsWith('private/')
                || relative === '.git' || relative.startsWith('.git/')
                || relative === 'node_modules' || relative.startsWith('node_modules/')
                || relative === 'dist' || relative.startsWith('dist/'));
        }
    });
    await import('node:fs/promises').then(({ symlink }) => symlink(
        path.join(PROJECT_ROOT, 'node_modules'),
        path.join(destination, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
    ));
}

async function assertDistHasNoLooseGameAssets(cloneRoot, manifest) {
    const dist = path.join(cloneRoot, 'dist');
    for (const asset of manifest.assets) {
        const loosePath = path.join(dist, ...asset.logicalPath.split('/'));
        try {
            await lstat(loosePath);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        throw new Error(`Production output contains a loose migrated game asset: ${path.relative(dist, loosePath)}`);
    }
    for (const relative of ['assets/asset-manifest.json', 'assets/asset-manifest-schema.json']) {
        const content = await readFile(path.join(dist, relative), 'utf8');
        if (/private[\\/]assets|private%2fassets/i.test(content)) {
            throw new Error(`Generated public output leaks a private source path: ${relative}`);
        }
    }
}

export async function verifyCleanClone({ projectRoot = PROJECT_ROOT } = {}) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'redemptis-clean-clone-'));
    const cloneRoot = path.join(tempRoot, 'project');
    const publicPlanets = path.join(projectRoot, 'public', 'assets', 'Planets');
    const preservedPlanets = new Map();
    for (const fileName of ['Map-111-2.png', 'Map-122-2.png']) {
        preservedPlanets.set(fileName, sha256(await readFile(path.join(publicPlanets, fileName))));
    }
    try {
        await copyProjectWithoutPrivate(cloneRoot);
        assert.equal((await lstat(path.join(cloneRoot, 'private')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))), null);
        const manifestPath = path.join(cloneRoot, 'public', 'assets', 'asset-manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const bundlePath = path.join(cloneRoot, 'public', manifest.bundles[0].bundleFile.slice(1));
        const originalBundle = await readFile(bundlePath);

        await rm(bundlePath);
        const missing = runNpm(['run', 'predev'], cloneRoot);
        if (missing.status === 0 || !/unavailable|could not read|bundle/i.test(missing.output)) {
            throw new Error(`Missing committed bundle was not rejected clearly:\n${missing.output}`);
        }
        await writeFile(bundlePath, originalBundle);

        const corrupted = Buffer.from(originalBundle);
        corrupted[corrupted.length - 1] ^= 0xff;
        await writeFile(bundlePath, corrupted);
        const corrupt = runNpm(['run', 'predev'], cloneRoot);
        if (corrupt.status === 0 || !/hash|digest|fingerprint/i.test(corrupt.output)) {
            throw new Error(`Corrupt committed bundle was not rejected clearly:\n${corrupt.output}`);
        }
        await writeFile(bundlePath, originalBundle);

        assertNpmSuccess(['run', 'predev'], cloneRoot);
        await runDevServer(cloneRoot);
        assertNpmSuccess(['run', 'prebuild'], cloneRoot);
        assertNpmSuccess(['run', 'build'], cloneRoot);
        await assertDistHasNoLooseGameAssets(cloneRoot, manifest);
        for (const [fileName, expectedHash] of preservedPlanets) {
            assert.equal(sha256(await readFile(path.join(publicPlanets, fileName))), expectedHash, `${fileName} changed during verification`);
        }
        const gitIgnore = spawnSync('git', ['check-ignore', '--quiet', '--', 'private/assets/Ships/human-dreadnought.svg'], {
            cwd: projectRoot,
            encoding: 'utf8'
        });
        if (gitIgnore.status !== 0) throw new Error('git check-ignore did not ignore the canonical private source path.');
        return { cloneRoot, verifiedBundles: manifest.bundles.map((bundle) => bundle.bundleId), manifestSchemaVersion: manifest.manifestSchemaVersion };
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    verifyCleanClone().then((result) => {
        console.log(`Clean-clone verification passed: manifest ${result.manifestSchemaVersion}, bundles ${result.verifiedBundles.join(', ')}.`);
    }).catch((error) => {
        console.error(`Clean-clone verification failed: ${error.message}`);
        process.exitCode = 1;
    });
}
