import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { verifyToken, type SessionPayload } from "./jwt";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "session";

function allowDevAuthBypass(): boolean {
  return process.env.SKIP_AUTH === "1" && process.env.NODE_ENV === "test";
}

export interface VerifiedSession extends SessionPayload {
  isDevBypass?: boolean;
}

function parseExpiry(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return DEFAULT_EXPIRY_MS;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_EXPIRY_MS;
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return DEFAULT_EXPIRY_MS;
  }
}

export const verifySession = cache(async (): Promise<VerifiedSession | null> => {
  if (allowDevAuthBypass()) {
    return {
      userId: "dev-user-id",
      username: "dev",
      sessionVersion: 0,
      isDevBypass: true,
    };
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      username: true,
      sessionVersion: true,
    },
  });

  if (!user) {
    return null;
  }

  if (user.sessionVersion !== payload.sessionVersion) {
    return null;
  }

  return {
    userId: user.id,
    username: user.username,
    sessionVersion: user.sessionVersion,
  };
});

export async function createSession(_payload: SessionPayload, token: string): Promise<void> {
  const expiresAt = new Date(Date.now() + parseExpiry(env.JWT_EXPIRES_IN));
  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    sameSite: "lax",
    path: "/",
  });
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
