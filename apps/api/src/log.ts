/** One JSON object per line on stdout: greppable, and safe to ship to a log sink. */
export function createLogger(scope: string) {
  return (event: Record<string, unknown>): void => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      scope,
      ...event,
    });
    process.stdout.write(`${line}\n`);
  };
}

export type Logger = ReturnType<typeof createLogger>;
