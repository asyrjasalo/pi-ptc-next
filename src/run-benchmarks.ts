import { runBenchmarkCli } from "./benchmark-runner";

void runBenchmarkCli().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
