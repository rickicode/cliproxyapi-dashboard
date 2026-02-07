import { NextRequest, NextResponse } from "next/server";

export function validateOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  
  if (!origin) {
    return null;
  }
  
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    
    if (
      originUrl.protocol !== requestUrl.protocol ||
      originUrl.host !== requestUrl.host
    ) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 }
    );
  }
  
  return null;
}
