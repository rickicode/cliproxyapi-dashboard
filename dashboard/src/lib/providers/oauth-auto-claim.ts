export interface OAuthAutoClaimCandidate {
  accountName: string;
  accountEmail?: string | null;
  ownerUserId?: string | null;
  ownerUsername?: string | null;
}

export interface OAuthAutoClaimFailure {
  code: string;
  message: string;
}

export type OAuthAutoClaimClassification =
  | {
    kind: "claimable";
    candidate: OAuthAutoClaimCandidate;
  }
  | {
    kind: "already_owned_by_current_user";
    candidate: OAuthAutoClaimCandidate;
  }
  | {
    kind: "claimed_by_other_user";
    candidate: OAuthAutoClaimCandidate;
  }
  | {
    kind: "ambiguous";
    candidates: OAuthAutoClaimCandidate[];
  }
  | {
    kind: "no_match";
  }
  | {
    kind: "error";
    failure: OAuthAutoClaimFailure;
  };

export interface ClassifyOAuthAutoClaimInput {
  currentUserId: string;
  candidates: OAuthAutoClaimCandidate[];
  failure?: OAuthAutoClaimFailure | null;
}

export function classifyOAuthAutoClaim({
  currentUserId,
  candidates,
  failure,
}: ClassifyOAuthAutoClaimInput): OAuthAutoClaimClassification {
  if (failure) {
    return {
      kind: "error",
      failure,
    };
  }

  if (candidates.length === 0) {
    return { kind: "no_match" };
  }

  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      candidates,
    };
  }

  const [candidate] = candidates;

  if (candidate.ownerUserId != null) {
    return {
      kind:
        candidate.ownerUserId === currentUserId
          ? "already_owned_by_current_user"
          : "claimed_by_other_user",
      candidate,
    };
  }

  return {
    kind: "claimable",
    candidate,
  };
}
