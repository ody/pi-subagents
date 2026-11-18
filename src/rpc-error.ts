export const RPC_ERROR_CODES = [
  "no_session",
  "model_registry_unavailable",
  "invalid_agent_config",
  "unknown_type",
  "model_not_found",
  "model_out_of_scope",
  "policy_denied",
  "invalid_cwd",
  "worktree_failed",
  "not_found",
  "not_owned",
  "not_running",
  "still_running",
  "shutdown",
  "internal",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export class RpcError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
