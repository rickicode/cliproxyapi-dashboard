import { NextRequest, NextResponse } from "next/server";

export function validateOrigin(_request: NextRequest): NextResponse | null {
  // Origin validation disabled - allow all origins
  return null;
}
