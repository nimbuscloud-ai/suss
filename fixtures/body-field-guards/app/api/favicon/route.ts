// Only the 200 sends `exists` with a value that can be true. The 400
// sends no `exists`, and the 500 sends it as false.

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const domain = new URL(request.url).searchParams.get("domain");

  if (!domain) {
    return NextResponse.json(
      { error: "Domain parameter is required" },
      { status: 400 },
    );
  }

  try {
    const icon = await fetch(`https://icons.example.com/${domain}`, {
      method: "HEAD",
    });
    return NextResponse.json({
      exists: icon.ok,
      status: icon.status,
      url: icon.url,
    });
  } catch {
    return NextResponse.json(
      { exists: false, error: "Failed to check favicon" },
      { status: 500 },
    );
  }
}
