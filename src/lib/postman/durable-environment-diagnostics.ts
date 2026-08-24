const MAX_DIAGNOSTIC_LENGTH = 320;

export class DurableEnvironmentBoundaryError extends Error {
  public readonly code = 'DURABLE_ENVIRONMENT_OPERATION_FAILED';

  public constructor(category: string) {
    const withoutControls = Array.from(category, (character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ? ' ' : character;
    }).join('');
    const normalizedCategory = withoutControls
      .replace(/[\u2028\u2029]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, MAX_DIAGNOSTIC_LENGTH);
    super(
      `DURABLE_ENVIRONMENT_OPERATION_FAILED: ${normalizedCategory || 'durable environment processing failed'}. ` +
      'Review the value-free result and preceding sanitized phase logs.'
    );
    this.name = 'DurableEnvironmentBoundaryError';
  }
}

function diagnosticCategory(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'DURABLE_ENVIRONMENT_PARTIAL_APPLY_FAILED') {
    return 'cloud apply was only partially completed';
  }
  if (code === 'CONTRACT_STATE_UNREADABLE') {
    return 'repository state or resource ownership validation failed';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/authoriz|pull-request|state-ref|publish|push|credential|token|provider/iu.test(message)) {
    return 'authorization or repository publication preflight failed';
  }
  if (/converge|binding|workspace observations|exact-name|multiple/iu.test(message)) {
    return 'environment identity or convergence validation failed';
  }
  return 'durable environment input or lifecycle validation failed';
}

/** Identify durable input failures before the normalized operation is available. */
export function isDurableEnvironmentFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code.startsWith('DURABLE_ENVIRONMENT_')) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /durable[- ]environments?|durable-project-key|durable-state-ref/iu.test(message);
}

/** Project arbitrary provider/input failures into one capped, single-line message. */
export function toDurableEnvironmentBoundaryError(
  error: unknown
): DurableEnvironmentBoundaryError {
  return error instanceof DurableEnvironmentBoundaryError
    ? error
    : new DurableEnvironmentBoundaryError(diagnosticCategory(error));
}
