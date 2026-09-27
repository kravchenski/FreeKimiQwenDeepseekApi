import readline from 'readline';

export function prompt(question: string) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}
