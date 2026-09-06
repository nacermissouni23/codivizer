import { describe, it, expect } from 'vitest';
import { parseArgs, printHelp, printVersion } from '../src/cli';
import * as os from 'node:os';

describe('parseArgs', () => {
  it('returns defaults with no args', () => {
    const args = parseArgs([]);
    expect(args.port).toBe(4840);
    expect(args.open).toBe(true);
    expect(args.watch).toBe(true); // default ON
    expect(args.help).toBe(false);
    expect(args.version).toBe(false);
    expect(args.noOpen).toBe(false);
  });

  it('accepts positional target', () => {
    const args = parseArgs(['/tmp/foo']);
    expect(args.target).toContain('foo');
  });

  it('expands ~ in target', () => {
    const args = parseArgs(['~/projects/myapp']);
    expect(args.target).toContain(os.homedir());
    expect(args.target).not.toContain('~');
  });

  it('handles --port', () => {
    expect(parseArgs(['--port', '5000']).port).toBe(5000);
    expect(parseArgs(['-p', '3000']).port).toBe(3000);
  });

  it('rejects invalid --port', () => {
    // Spy on process.exit
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = 0;
    process.exit = ((code: number) => { exitCode = code ?? 0; throw new Error('exit'); }) as any;
    console.error = () => {};
    try {
      try { parseArgs(['--port', 'abc']); } catch { /* expected */ }
      expect(exitCode).toBe(1);
      try { parseArgs(['--port', '99999']); } catch { /* expected */ }
      expect(exitCode).toBe(1);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });

  it('handles --no-open / --no-watch / --include-hidden', () => {
    expect(parseArgs(['--no-open']).open).toBe(false);
    expect(parseArgs(['--no-open']).noOpen).toBe(true);
    expect(parseArgs(['--no-watch']).watch).toBe(false);
    expect(parseArgs(['--no-watch']).noWatch).toBe(true);
    expect(parseArgs(['--include-hidden']).includeHidden).toBe(true);
    expect(parseArgs(['--all']).includeHidden).toBe(true);
  });

  it('handles --watch flag (overrides default-off after --no-watch)', () => {
    expect(parseArgs(['--no-watch', '--watch']).watch).toBe(true);
  });

  it('handles --path / --target aliases', () => {
    expect(parseArgs(['--path', '/x/y']).path).toBe('/x/y');
    expect(parseArgs(['--target', '/a/b']).path).toBe('/a/b');
  });

  it('handles --version and --help flags', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('printHelp / printVersion', () => {
  it('printHelp does not throw', () => {
    expect(() => printHelp()).not.toThrow();
  });
  it('printVersion does not throw', () => {
    expect(() => printVersion()).not.toThrow();
  });
});
