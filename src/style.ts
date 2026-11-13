import { styleText } from 'node:util';

// How ship colours its output. Commands only say what a piece of text is; the terminal decides
// whether colour is shown (styleText drops it when output is piped or NO_COLOR is set).
export type Style = {
  ok: (text: string) => string;
  warn: (text: string) => string;
  bad: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  sha: (text: string) => string;
  env: (text: string) => string;
  link: (text: string) => string;
};

const same = (text: string) => text;

export const plain: Style = { ok: same, warn: same, bad: same, dim: same, bold: same, sha: same, env: same, link: same };

type Format = Parameters<typeof styleText>[0];

export function terminalStyle(stream: NodeJS.WriteStream): Style {
  const paint = (format: Format) => (text: string) => styleText(format, text, { stream });
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
