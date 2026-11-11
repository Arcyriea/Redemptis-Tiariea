import { buildRuntimeContract, renderRuntimeContract } from './scripts/asset-contract.mjs';
import * as fs from 'fs';

const manifest = JSON.parse(fs.readFileSync('public/assets/asset-manifest.json', 'utf8'));

const contract = buildRuntimeContract(manifest, new Map(), manifest.activePlanetPlacements);
const rendered = renderRuntimeContract(contract);

// Read the current contract source file
const currentContractSrc = fs.readFileSync('src/generated/runtimeAssetContract.ts', 'utf8');

console.log('Current contract generationId:', manifest.generationId);
console.log('Contract generationId:', contract.generationId);
console.log('Match:', contract.generationId === manifest.generationId);
console.log('\\nCurrent contract source (first 500):', currentContractSrc.substring(0, 500));
console.log('\nRendered contract (first 500):', rendered.substring(0, 500));
console.log('\nMatch:', currentContractSrc === rendered);