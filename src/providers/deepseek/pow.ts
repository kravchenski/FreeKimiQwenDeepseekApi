import fs from 'fs';

import wasmPath from './sha3_wasm_bg.wasm' with { type: 'file' };
let instancePromise: Promise<WebAssembly.Instance> | null = null;

function getInstance() {
    instancePromise ??= WebAssembly.instantiate(fs.readFileSync(wasmPath), {}).then(result => result.instance);
    return instancePromise;
}

export async function validateDeepSeekPowSolver() {
    const instance = await getInstance();
    const exports = instance.exports as Record<string, unknown>;
    return Boolean(exports.memory && exports.wasm_solve && exports.__wbindgen_export_0);
}

export async function solveDeepSeekPow(challenge: Record<string, unknown>) {
    const instance = await getInstance();
    const exports = instance.exports as Record<string, any>;
    const memory = exports.memory as WebAssembly.Memory;
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;

    const writeString = (value: string) => {
        const encoded = Buffer.from(value, 'utf8');
        const pointer = exports.__wbindgen_export_0(encoded.length, 1);
        new Uint8Array(memory.buffer).set(encoded, pointer);
        return { pointer, length: encoded.length };
    };

    const resultPointer = exports.__wbindgen_add_to_stack_pointer(-16);
    try {
        const challengeString = writeString(String(challenge.challenge));
        const prefixString = writeString(prefix);
        exports.wasm_solve(
            resultPointer,
            challengeString.pointer,
            challengeString.length,
            prefixString.pointer,
            prefixString.length,
            Number(challenge.difficulty)
        );
        const status = new Int32Array(memory.buffer)[resultPointer / 4];
        if (status === 0) throw new Error('DeepSeek PoW solver did not find an answer');
        const answer = Math.floor(new Float64Array(memory.buffer)[(resultPointer + 8) / 8]);
        return Buffer.from(JSON.stringify({
            algorithm: challenge.algorithm,
            challenge: challenge.challenge,
            salt: challenge.salt,
            answer,
            signature: challenge.signature,
            target_path: challenge.target_path
        })).toString('base64');
    } finally {
        exports.__wbindgen_add_to_stack_pointer(16);
    }
}
