export function isDeepSeekUrl(value: string) {
    try {
        const { protocol, hostname } = new URL(value);
        return protocol === 'https:' && (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com'));
    } catch {
        return false;
    }
}
