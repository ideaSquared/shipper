import { styleText } from 'node:util';
const same = (text) => text;
export const plain = { ok: same, warn: same, bad: same, dim: same, bold: same, sha: same, env: same, link: same };
export function terminalStyle(stream) {
    const paint = (format) => (text) => styleText(format, text, { stream });
    return {
        ok: paint(['bold', 'green']),
        warn: paint('yellow'),
        bad: paint(['bold', 'red']),
        dim: paint('gray'),
        bold: paint('bold'),
        sha: paint('yellow'),
        env: paint(['bold', 'cyan']),
        link: paint(['underline', 'blue']),
    };
}
