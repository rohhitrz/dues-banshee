// Offline draft eval CLI (guardrails-evals, Req 4.4, 4.5, 4.7).
//
//   pnpm --filter @dues-banshee/agent eval
//
// Loads every fixture in <repo>/evals/draft-step/, runs the Draft_Guard on each recorded model
// output and prints one PASS|FAIL line per fixture plus `<passed>/<total> passed`. Exit code 1 when
// any fixture fails, the count is outside 15 to 20, or a fixture file (or the folder) cannot be used. No network, no LLM call.
import { FixtureError, loadFixtures } from "../src/evals/fixture";
import { fixtureCountProblem, formatReport, runEvals } from "../src/evals/run";

function main(): void {
  try {
    const results = runEvals(loadFixtures());
    console.log(formatReport(results));
    if (results.some((result) => !result.pass)) process.exitCode = 1;
    const countProblem = fixtureCountProblem(results.length);
    if (countProblem !== null) {
      console.error(`eval: ${countProblem}`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof FixtureError) {
      console.error(`eval: cannot use fixtures in ${error.file}`);
      for (const issue of error.issues) console.error(`  - ${issue}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main();
