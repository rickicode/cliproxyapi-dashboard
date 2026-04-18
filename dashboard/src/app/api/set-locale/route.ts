import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { supportedLocales, type Locale } from "@/i18n/config";
import { validateOrigin } from "@/lib/auth/origin";
import { verifySession } from "@/lib/auth/session";
import { Errors } from "@/lib/errors";

export async function POST(request: NextRequest) {
  const session = await verifySession();
  if (!session) {
    return Errors.unauthorized();
  }

  const originError = validateOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Errors.validation("Invalid JSON body");
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Errors.validation("Invalid request body");
    }

    const { locale } = body as { locale?: unknown };

    // Validate locale
    if (typeof locale !== "string" || !supportedLocales.includes(locale as Locale)) {
      return NextResponse.json(
        { error: "Invalid locale" },
        { status: 400 }
      );
    }

    // Set cookie
    const store = await cookies();
    store.set("locale", locale, {
      maxAge: 60 * 60 * 24 * 365, // 1 year
      httpOnly: false, // Allow client-side access for next-intl
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to set locale:", error);
    return NextResponse.json(
      { error: "Failed to set locale" },
      { status: 500 }
    );
  }
}
