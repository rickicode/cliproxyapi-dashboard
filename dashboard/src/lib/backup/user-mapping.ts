import "server-only";
import { prisma } from "@/lib/db";

export async function getUserIdMapByUsername(usernames: string[]): Promise<Map<string, string>> {
  const uniqueUsernames = [...new Set(usernames)];
  if (uniqueUsernames.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { username: { in: uniqueUsernames } },
    select: { id: true, username: true },
  });

  return new Map(users.map((user) => [user.username, user.id]));
}

export function findMissingUsernames(
  usernames: string[],
  userIdMap: Map<string, string>
): string[] {
  return [...new Set(usernames)].filter((username) => !userIdMap.has(username));
}
