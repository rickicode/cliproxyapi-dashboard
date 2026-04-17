function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForComparison(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((normalized, key) => {
      normalized[key] = normalizeForComparison(value[key]);
      return normalized;
    }, {});
}

function hasConflictingWrappers(files: unknown[], authFiles: unknown[]): boolean {
  return JSON.stringify(normalizeForComparison(files)) !== JSON.stringify(normalizeForComparison(authFiles));
}

export function parseAuthFilesResponse<T extends Record<string, unknown>>(value: unknown): T[] | null {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (!isRecord(value)) {
    return [];
  }

  const hasFilesWrapper = "files" in value;
  const hasAuthFilesWrapper = "auth_files" in value;

  if (hasFilesWrapper && hasAuthFilesWrapper) {
    if (!Array.isArray(value.files) || !Array.isArray(value.auth_files)) {
      return null;
    }

    if (hasConflictingWrappers(value.files, value.auth_files)) {
      return null;
    }

    return value.files as T[];
  }

  if (Array.isArray(value.files)) {
    return value.files as T[];
  }

  if (Array.isArray(value.auth_files)) {
    return value.auth_files as T[];
  }

  if (hasFilesWrapper || hasAuthFilesWrapper) {
    return null;
  }

  return [];
}
