/** Permission decision result. */
export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  message?: string;
}

/** Permission checker interface. */
export interface PermissionChecker {
  check(toolName: string, params: Record<string, unknown>): Promise<PermissionDecision> | PermissionDecision;
}