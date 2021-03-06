import { Observable, Observer, merge, zip } from 'rxjs';
import { flatMap, map, tap, toArray } from 'rxjs/operators';
import { Config } from 'stryker-api/config';
import { File } from 'stryker-api/core';
import { MutantResult, MutantStatus } from 'stryker-api/report';
import { TestFramework } from 'stryker-api/test_framework';
import { RunResult, RunStatus, TestStatus } from 'stryker-api/test_runner';
import Sandbox from '../Sandbox';
import SandboxPool from '../SandboxPool';
import TestableMutant from '../TestableMutant';
import TranspiledMutant from '../TranspiledMutant';
import StrictReporter from '../reporters/StrictReporter';
import MutantTranspiler from '../transpiler/MutantTranspiler';

export default class MutationTestExecutor {

  constructor(
    private config: Config,
    private inputFiles: ReadonlyArray<File>,
    private testFramework: TestFramework | null,
    private reporter: StrictReporter,
    private overheadTimeMS: number) {
  }

  async run(allMutants: TestableMutant[]): Promise<MutantResult[]> {
    const mutantTranspiler = new MutantTranspiler(this.config);
    const transpiledFiles = await mutantTranspiler.initialize(this.inputFiles);
    const sandboxPool = new SandboxPool(this.config, this.testFramework, transpiledFiles, this.overheadTimeMS);
    const result = await this.runInsideSandboxes(
      sandboxPool.streamSandboxes(),
      mutantTranspiler.transpileMutants(allMutants));
    await sandboxPool.disposeAll();
    mutantTranspiler.dispose();
    return result;
  }

  private runInsideSandboxes(sandboxes: Observable<Sandbox>, transpiledMutants: Observable<TranspiledMutant>): Promise<MutantResult[]> {
    let recycleObserver: Observer<Sandbox>;
    const recycled = new Observable<Sandbox>(observer => {
      recycleObserver = observer;
    });
    function recycle(sandbox: { sandbox: Sandbox, result: MutantResult }) {
      return recycleObserver.next(sandbox.sandbox);
    }

    function completeRecycle() {
      if (recycleObserver) {
        recycleObserver.complete();
      }
    }

    return zip(transpiledMutants, merge(recycled, sandboxes), createTuple)
      .pipe(
        map(earlyResult),
        flatMap(runInSandbox),
        tap(recycle),
        map(({ result }) => result),
        tap(reportResult(this.reporter)),
        toArray(),
        tap(completeRecycle),
        tap(reportAll(this.reporter)))
      .toPromise(Promise);
  }
}

function earlyResult([transpiledMutant, sandbox]: [TranspiledMutant, Sandbox]): [TranspiledMutant, Sandbox, MutantResult | null] {
  if (transpiledMutant.transpileResult.error) {
    const result = transpiledMutant.mutant.result(MutantStatus.TranspileError, []);
    return [transpiledMutant, sandbox, result];
  } else if (!transpiledMutant.mutant.selectedTests.length) {
    const result = transpiledMutant.mutant.result(MutantStatus.NoCoverage, []);
    return [transpiledMutant, sandbox, result];
  } else if (!transpiledMutant.changedAnyTranspiledFiles) {
    const result = transpiledMutant.mutant.result(MutantStatus.Survived, []);
    return [transpiledMutant, sandbox, result];
  } else {
    // No early result possible, need to run in the sandbox later
    return [transpiledMutant, sandbox, null];
  }
}

function runInSandbox([transpiledMutant, sandbox, earlyResult]: [TranspiledMutant, Sandbox, MutantResult | null]): Promise<{ sandbox: Sandbox, result: MutantResult }> {
  if (earlyResult) {
    return Promise.resolve({ sandbox, result: earlyResult });
  } else {
    return sandbox.runMutant(transpiledMutant)
      .then(runResult => ({ sandbox, result: collectMutantResult(transpiledMutant.mutant, runResult) }));
  }
}

function createTuple<T1, T2>(a: T1, b: T2): [T1, T2] {
  return [a, b];
}

function collectMutantResult(mutant: TestableMutant, runResult: RunResult) {
  let status: MutantStatus = MutantStatus.NoCoverage;
  let testNames: string[];
  if (runResult) {
    switch (runResult.status) {
      case RunStatus.Timeout:
        status = MutantStatus.TimedOut;
        break;
      case RunStatus.Error:
        status = MutantStatus.RuntimeError;
        break;
      case RunStatus.Complete:
        if (runResult.tests.some(t => t.status === TestStatus.Failed)) {
          status = MutantStatus.Killed;
        } else {
          status = MutantStatus.Survived;
        }
        break;
    }
    testNames = runResult.tests
      .filter(t => t.status !== TestStatus.Skipped)
      .map(t => t.name);
  } else {
    testNames = [];
  }
  return mutant.result(status, testNames);
}

function reportResult(reporter: StrictReporter) {
  return (mutantResult: MutantResult) => {
    reporter.onMutantTested(mutantResult);
  };
}

function reportAll(reporter: StrictReporter) {
  return (mutantResults: MutantResult[]) => {
    reporter.onAllMutantsTested(mutantResults);
  };
}