import type {
  DraftImprovementPlan,
  InitialSquadOptions,
  Player,
} from "./domain";

type PendingRequest = {
  resolve: (value: Player[] | DraftImprovementPlan | null) => void;
  reject: (reason: Error) => void;
};

type OptimizerResponse =
  | { id: number; ok: true; result: Player[] | DraftImprovementPlan | null }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function rejectPending(message: string) {
  for (const request of pending.values()) request.reject(new Error(message));
  pending.clear();
}

function getOptimizerWorker() {
  if (worker) return worker;
  worker = new Worker("/assets/optimizer-worker.js", { type: "module" });
  worker.onmessage = (event: MessageEvent<OptimizerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error));
  };
  worker.onerror = () => {
    rejectPending("The background squad optimiser could not start");
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function requestOptimization(
  payload: Record<string, unknown>,
): Promise<Player[] | DraftImprovementPlan | null> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getOptimizerWorker().postMessage({ id, ...payload });
  });
}

export async function optimizeInitialSquadAsync(
  pool: Player[],
  options: InitialSquadOptions = {},
): Promise<Player[]> {
  const result = await requestOptimization({ operation: "optimize", pool, options });
  return Array.isArray(result) ? result : [];
}

export async function buildDraftImprovementPlanAsync(
  current: Player[],
  pool: Player[],
  options: InitialSquadOptions = {},
): Promise<DraftImprovementPlan | null> {
  const result = await requestOptimization({
    operation: "draft-plan",
    current,
    pool,
    options,
  });
  return Array.isArray(result) ? null : result;
}
