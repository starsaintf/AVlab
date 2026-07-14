export class AvlabError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "AvlabError";
  }
}

export function asAvlabError(error: unknown, code = "AVLAB_UNEXPECTED"): AvlabError {
  if (error instanceof AvlabError) return error;
  return new AvlabError(code, error instanceof Error ? error.message : String(error), error);
}
