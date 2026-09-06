import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface CliArgs {
  target: string;
  port: number;
  open: boolean;
  watch: boolean;
  includeHidden: boolean;
  help: boolean;
  version: boolean;
  path: string; // alias of target
  noOpen: boolean;
  noWatch: boolean;
}

function getVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function parseArgs(argv: string[]): CliArgs {
  const defaults: CliArgs = {
    target: process.cwd(),
    port: 4840,
    open: true,
    watch: true, // default ON per product decision
    includeHidden: false,
    help: false,
    version: false,
    path: '',
    noOpen: false,
    noWatch: false,
  };

  let target = defaults.target;
  let port = defaults.port;
  const flags = { open: defaults.open, watch: defaults.watch, includeHidden: defaults.includeHidden };
  let help = false;
  let version = false;
  let noOpen = false;
  let noWatch = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        console.error(`codivizer: invalid --port value "${raw}" (must be integer 0-65535).`);
        process.exit(1);
      }
      port = n;
    } else if (a === '--no-open') {
      flags.open = false;
      noOpen = true;
    } else if (a === '--no-watch') {
      flags.watch = false;
      noWatch = true;
    } else if (a === '--watch') {
      flags.watch = true;
    } else if (a === '--open') {
      flags.open = true;
    } else if (a === '--include-hidden' || a === '--all') {
      flags.includeHidden = true;
    } else if (a === '--version' || a === '-v') {
      version = true;
    } else if (a === '-h' || a === '--help') {
      help = true;
    } else if (a === '--path' || a === '--target') {
      target = expandHome(argv[++i] ?? '');
    } else if (!a.startsWith('-')) {
      target = expandHome(a);
    }
    // unknown flags are silently ignored (forward-compat)
  }

  return {
    ...defaults,
    target: path.resolve(target || process.cwd()),
    port,
    ...flags,
    help,
    version,
    noOpen,
    noWatch,
    path: target,
  };
}

export function printHelp(): void {
  const v = getVersion();
  console.log(`codivizer v${v} - local-first code architecture explorer

USAGE
  codivizer [path] [flags]

FLAGS
  --port, -p <N>      port to bind (default 4840; auto-fallback if busy)
  --no-open           do not auto-open browser on start
  --no-watch          do not watch filesystem for changes (watch is ON by default)
  --watch             enable filesystem watching (default)
  --include-hidden    walk dotfiles (default: skip)
  --path, --target    alias for the positional path argument
  --version, -v       print version and exit
  --help, -h          print this help

EXAMPLES
  codivizer
  codivizer .
  codivizer /path/to/project --port 5000 --no-open
  codivizer ~/code/my-app --include-hidden

Run a server, browse the indexed graph at http://127.0.0.1:<port>.
`);
}

export function printVersion(): void {
  console.log(`codivizer v${getVersion()}`);
}
