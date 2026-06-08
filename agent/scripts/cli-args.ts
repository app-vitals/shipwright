export function getArg(name: string, argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
    if (arg === name) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("-") ? next : undefined;
    }
  }
  return undefined;
}

export function hasFlag(name: string, argv: string[]): boolean {
  return argv.includes(name);
}
