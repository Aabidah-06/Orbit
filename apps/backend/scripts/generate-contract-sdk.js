#!/usr/bin/env node
// Generates the strongly-typed Orbit Soroban TypeScript SDK (#159) from the
// contract ABI captured by `inspect-contract.js`.
//
//   node scripts/generate-contract-sdk.js [--abi path/to/orbit_soroban.abi.json]
//
// The generated module is written to the shared internal client package
// (packages/contract-sdk) so the backend, dashboard and checkout widget all
// assemble Soroban ScVals through one typed surface instead of hand-rolling them.
const fs = require('fs');
const path = require('path');

const DEFAULT_ABI = path.resolve(__dirname, '../abi/orbit_soroban.abi.json');
const OUTPUT_DIR = path.resolve(__dirname, '../../../packages/contract-sdk/src/generated');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'orbit-contract.ts');
const ABI_MIRROR = path.resolve(__dirname, '../../../packages/contract-sdk/abi/orbit_soroban.abi.json');

const readArgs = () => {
    const index = process.argv.indexOf('--abi');
    return { abiPath: index >= 0 ? path.resolve(process.argv[index + 1]) : DEFAULT_ABI };
};

const toCamel = (name) => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const toPascal = (name) => name.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const isStruct = (abi, type) => Object.prototype.hasOwnProperty.call(abi.structs, type);

const tsType = (abi, type, mode) => {
    if (type.startsWith('vec<')) return `${tsType(abi, type.slice(4, -1), mode)}[]`;
    if (type.startsWith('option<')) return `${tsType(abi, type.slice(7, -1), mode)} | null`;
    switch (type) {
        case 'address':
        case 'string':
            return 'string';
        case 'i128':
        case 'u64':
            return mode === 'decode' ? 'bigint' : 'Numeric';
        case 'u32':
            return 'number';
        case 'bool':
            return 'boolean';
        default:
            if (isStruct(abi, type)) return mode === 'decode' ? type : `${type}Input`;
            throw new Error(`Unknown ABI type: ${type}`);
    }
};

const encodeExpr = (abi, type, expr) => {
    if (type.startsWith('vec<')) {
        const inner = type.slice(4, -1);
        return `vecToScVal(${expr}.map((item) => ${encodeExpr(abi, inner, 'item')}))`;
    }
    switch (type) {
        case 'address': return `addressToScVal(${expr})`;
        case 'i128': return `i128ToScVal(${expr})`;
        case 'u64': return `u64ToScVal(${expr})`;
        case 'u32': return `u32ToScVal(${expr})`;
        case 'bool': return `boolToScVal(${expr})`;
        case 'string': return `stringToScVal(${expr})`;
        default:
            if (isStruct(abi, type)) return `encode${type}(${expr})`;
            throw new Error(`Unknown ABI type: ${type}`);
    }
};

const fieldDecoder = (abi, type) => {
    if (type.startsWith('vec<')) {
        const inner = type.slice(4, -1);
        const innerDecoder = isStruct(abi, inner)
            ? `(item: any) => decode${inner}(item as xdr.ScVal)`
            : fieldDecoder(abi, inner);
        return `decodeVec<any>(${innerDecoder})`;
    }
    switch (type) {
        case 'address': return 'decodeAddress';
        case 'i128': return 'decodeI128';
        case 'u64': return 'decodeU64';
        case 'u32': return 'decodeU32';
        case 'bool': return 'decodeBool';
        case 'string': return 'decodeString';
        default:
            if (isStruct(abi, type)) return `(value: any) => decode${type}(value as xdr.ScVal)`;
            throw new Error(`Unknown ABI type: ${type}`);
    }
};

const generateStruct = (abi, name, fields) => {
    const lines = [];
    lines.push(`export interface ${name} {`);
    for (const field of fields) lines.push(`  ${field.name}: ${tsType(abi, field.type, 'decode')};`);
    lines.push('}');
    lines.push('');
    lines.push(`export interface ${name}Input {`);
    for (const field of fields) lines.push(`  ${field.name}: ${tsType(abi, field.type, 'encode')};`);
    lines.push('}');
    lines.push('');
    lines.push(`const ${name.toUpperCase()}_ENCODERS: StructFieldEncoders<${name}Input> = {`);
    for (const field of fields) {
        lines.push(`  ${field.name}: (value: any) => ${encodeExpr(abi, field.type, 'value')},`);
    }
    lines.push('};');
    lines.push('');
    lines.push(`const ${name.toUpperCase()}_DECODERS: StructFieldDecoders<${name}> = {`);
    for (const field of fields) lines.push(`  ${field.name}: ${fieldDecoder(abi, field.type)},`);
    lines.push('};');
    lines.push('');
    lines.push(`export const encode${name} = (value: ${name}Input): xdr.ScVal => encodeStruct(${name.toUpperCase()}_ENCODERS, value);`);
    lines.push(`export const decode${name} = (value: xdr.ScVal | unknown): ${name} => decodeStruct(${name.toUpperCase()}_DECODERS, value);`);
    lines.push('');
    return lines;
};

const decodeReturnLines = (abi, output) => {
    if (!output) return null;
    const type = output.type;
    if (type.startsWith('option<')) {
        const inner = type.slice(7, -1);
        if (isStruct(abi, inner)) {
            return [
                '    const value = decodeNative<any>(retval);',
                `    return value === null ? null : decode${inner}(value);`,
            ];
        }
        return [`    return decodeNative<any>(retval);`];
    }
    if (type.startsWith('vec<')) {
        const inner = type.slice(4, -1);
        if (isStruct(abi, inner)) {
            return [`    return (decodeNative<any[]>(retval) ?? []).map((item) => decode${inner}(item));`];
        }
        return [`    return decodeNative<any[]>(retval) ?? [];`];
    }
    if (isStruct(abi, type)) {
        return [`    return decode${type}(decodeNative<any>(retval));`];
    }
    return [`    return decodeNative<any>(retval);`];
};

const generateInputInterface = (abi, fn) => {
    if (fn.inputs.length === 0) return [];
    const lines = [];
    const pascal = toPascal(fn.name);
    lines.push(`export interface ${pascal}Input {`);
    for (const input of fn.inputs) lines.push(`  ${input.name}: ${tsType(abi, input.type, 'encode')};`);
    lines.push('}');
    lines.push('');
    return lines;
};

const generateMethod = (abi, fn) => {
    const lines = [];
    const pascal = toPascal(fn.name);
    const method = toCamel(fn.name);
    const hasInput = fn.inputs.length > 0;

    const args = fn.inputs.map((input) => encodeExpr(abi, input.type, `input.${input.name}`)).join(', ');
    const signature = hasInput
        ? `${method}(input: ${pascal}Input, options: OrbitContractInvokeOptions = {})`
        : `${method}(options: OrbitContractInvokeOptions = {})`;
    const returnType = fn.output ? tsType(abi, fn.output.type, 'decode') : 'void';
    const readOnly = fn.mutating ? 'false' : 'true';

    lines.push(`  async ${signature}: Promise<${returnType}> {`);
    if (fn.output) {
        lines.push(`    const retval = await this.invoker.invoke('${fn.name}', [${args}], { readOnly: ${readOnly}, ...options });`);
        for (const line of decodeReturnLines(abi, fn.output)) lines.push(line);
    } else {
        lines.push(`    await this.invoker.invoke('${fn.name}', [${args}], { readOnly: ${readOnly}, ...options });`);
    }
    lines.push('  }');
    lines.push('');
    return lines;
};

const generate = (abi) => {
    const lines = [];
    lines.push('// AUTO-GENERATED by apps/backend/scripts/generate-contract-sdk.js — do not edit by hand.');
    lines.push('// Source ABI: apps/backend/abi/orbit_soroban.abi.json');
    lines.push('// Regenerate with: npm run generate:contract-sdk (from apps/backend)');
    lines.push("import { xdr } from '@stellar/stellar-sdk';");
    lines.push('import {');
    lines.push('  Numeric, StructFieldDecoders, StructFieldEncoders, addressToScVal, boolToScVal,');
    lines.push('  decodeAddress, decodeBool, decodeI128, decodeNative, decodeString, decodeStruct,');
    lines.push('  decodeU32, decodeU64, decodeVec, encodeStruct, i128ToScVal, stringToScVal,');
    lines.push('  u32ToScVal, u64ToScVal, vecToScVal,');
    lines.push("} from '../scval';");
    lines.push('');
    lines.push(`export const ORBIT_CONTRACT_WASM = '${abi.wasm}';`);
    lines.push(`export const ORBIT_CONTRACT_SOROBAN_SDK = '${abi.sorobanSdk}';`);
    lines.push(`export const ORBIT_CONTRACT_FUNCTION_NAMES = [${abi.functions.map((f) => `'${f.name}'`).join(', ')}] as const;`);
    lines.push('');
    lines.push('export const ORBIT_CONTRACT_STRUCT_NAMES = [' + Object.keys(abi.structs).map((n) => `'${n}'`).join(', ') + '] as const;');
    lines.push('');

    for (const [name, struct] of Object.entries(abi.structs)) {
        for (const line of generateStruct(abi, name, struct.fields)) lines.push(line);
    }

    for (const fn of abi.functions) {
        for (const line of generateInputInterface(abi, fn)) lines.push(line);
    }

    lines.push('export interface OrbitContractInvokeOptions {');
    lines.push('  /** Read-only calls simulate without submitting; mutating calls require a signer. */');
    lines.push('  readOnly?: boolean;');
    lines.push('  /** Opaque signer passed through to the invoker (wallet, keypair, relayer...). */');
    lines.push('  signer?: unknown;');
    lines.push('}');
    lines.push('');
    lines.push('export interface OrbitContractInvoker {');
    lines.push('  /** Invokes a contract function and returns the decoded return ScVal (undefined for void). */');
    lines.push('  invoke(functionName: string, args: xdr.ScVal[], options: OrbitContractInvokeOptions): Promise<xdr.ScVal | undefined>;');
    lines.push('}');
    lines.push('');
    lines.push('export class OrbitContractClient {');
    lines.push('  constructor(private readonly invoker: OrbitContractInvoker) {}');
    lines.push('');
    for (const fn of abi.functions) {
        for (const line of generateMethod(abi, fn)) lines.push(line);
    }
    lines.push('}');
    lines.push('');
    lines.push('export const createOrbitContractClient = (invoker: OrbitContractInvoker): OrbitContractClient =>');
    lines.push('  new OrbitContractClient(invoker);');
    lines.push('');
    return lines.join('\n');
};

const main = () => {
    const { abiPath } = readArgs();
    if (!fs.existsSync(abiPath)) {
        console.error(`ABI not found at ${abiPath}. Run inspect-contract.js first.`);
        process.exitCode = 1;
        return;
    }
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    const output = generate(abi);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, output);
    fs.mkdirSync(path.dirname(ABI_MIRROR), { recursive: true });
    fs.writeFileSync(ABI_MIRROR, JSON.stringify(abi, null, 2) + '\n');
    console.log(`Generated ${path.relative(process.cwd(), OUTPUT_FILE)} (${abi.functions.length} functions, ${Object.keys(abi.structs).length} structs)`);
};

if (require.main === module) main();

module.exports = { generate, tsType, encodeExpr, DEFAULT_ABI, OUTPUT_FILE };
