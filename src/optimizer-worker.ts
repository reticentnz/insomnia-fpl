import {
  buildDraftImprovementPlan,
  optimizeInitialSquad,
  type DraftImprovementPlan,
  type InitialSquadOptions,
  type Player,
} from "./domain";

type OptimizerRequest =
  | {
      id: number;
      operation: "optimize";
      pool: Player[];
      options: InitialSquadOptions;
    }
  | {
      id: number;
      operation: "draft-plan";
      current: Player[];
      pool: Player[];
      options: InitialSquadOptions;
    };

type OptimizerResponse =
  | { id: number; ok: true; result: Player[] | DraftImprovementPlan | null }
  | { id: number; ok: false; error: string };

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<OptimizerRequest>) => void) | null;
  postMessage: (message: OptimizerResponse) => void;
};

workerScope.onmessage = (event) => {
  const request = event.data;
  try {
    const result =
      request.operation === "optimize"
        ? optimizeInitialSquad(request.pool, request.options)
        : buildDraftImprovementPlan(
            request.current,
            request.pool,
            request.options,
          );
    workerScope.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Squad optimisation failed",
    });
  }
};
