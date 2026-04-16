import { describe, expect, it } from "vitest";

import { classifyOAuthAutoClaim } from "@/lib/providers/oauth-auto-claim";

describe("classifyOAuthAutoClaim", () => {
  it("returns claimable for a single unowned candidate", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-1",
        candidates: [
          {
            accountName: "cursor_user@example.com.json",
            accountEmail: "user@example.com",
            ownerUserId: null,
          },
        ],
      })
    ).toEqual({
      kind: "claimable",
      candidate: {
        accountName: "cursor_user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: null,
      },
    });
  });

  it("returns already_owned_by_current_user when the single candidate belongs to the current user", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-2",
        candidates: [
          {
            accountName: "cursor_user@example.com.json",
            accountEmail: "user@example.com",
            ownerUserId: "user-2",
            ownerUsername: "teammate",
          },
        ],
      })
    ).toEqual({
      kind: "already_owned_by_current_user",
      candidate: {
        accountName: "cursor_user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-2",
        ownerUsername: "teammate",
      },
    });
  });

  it("returns claimed_by_other_user when the single candidate belongs to another user", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-1",
        candidates: [
          {
            accountName: "cursor_user@example.com.json",
            accountEmail: "user@example.com",
            ownerUserId: "user-2",
            ownerUsername: "teammate",
          },
        ],
      })
    ).toEqual({
      kind: "claimed_by_other_user",
      candidate: {
        accountName: "cursor_user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "user-2",
        ownerUsername: "teammate",
      },
    });
  });

  it("treats an empty-string owner id as already owned by another user via explicit null checks", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-1",
        candidates: [
          {
            accountName: "cursor_user@example.com.json",
            accountEmail: "user@example.com",
            ownerUserId: "",
            ownerUsername: "unknown-owner",
          },
        ],
      })
    ).toEqual({
      kind: "claimed_by_other_user",
      candidate: {
        accountName: "cursor_user@example.com.json",
        accountEmail: "user@example.com",
        ownerUserId: "",
        ownerUsername: "unknown-owner",
      },
    });
  });

  it("returns ambiguous for multiple plausible candidates", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-1",
        candidates: [
          {
            accountName: "cursor_a@example.com.json",
            ownerUserId: null,
          },
          {
            accountName: "cursor_b@example.com.json",
            ownerUserId: null,
          },
        ],
      })
    ).toEqual({
      kind: "ambiguous",
      candidates: [
        {
          accountName: "cursor_a@example.com.json",
          ownerUserId: null,
        },
        {
          accountName: "cursor_b@example.com.json",
          ownerUserId: null,
        },
      ],
    });
  });

  it("returns no_match when there are no candidates", () => {
    expect(
      classifyOAuthAutoClaim({ currentUserId: "user-1", candidates: [] })
    ).toEqual({ kind: "no_match" });
  });

  it("returns error when given an explicit failure state", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-1",
        candidates: [
          {
            accountName: "cursor_user@example.com.json",
            ownerUserId: null,
          },
        ],
        failure: {
          code: "ownership_lookup_failed",
          message: "Database query failed",
        },
      })
    ).toEqual({
      kind: "error",
      failure: {
        code: "ownership_lookup_failed",
        message: "Database query failed",
      },
    });
  });

  it("prioritizes explicit failure over candidate-derived states", () => {
    expect(
      classifyOAuthAutoClaim({
        currentUserId: "user-2",
        candidates: [
          {
            accountName: "cursor_user@example.com.json",
            accountEmail: "user@example.com",
            ownerUserId: "user-2",
            ownerUsername: "current-user",
          },
        ],
        failure: {
          code: "ownership_lookup_failed",
          message: "Database query failed",
        },
      })
    ).toEqual({
      kind: "error",
      failure: {
        code: "ownership_lookup_failed",
        message: "Database query failed",
      },
    });
  });
});
