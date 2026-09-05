import { NextResponse } from "next/server";

import { isCurrentUserAdmin } from "@/lib/supabase/roles";
import { PLOT_EDITOR_REQUIRE_ADMIN, readSitePlot, updateSitePlot, validatePlotInput } from "@/lib/site-plot";

async function requirePlotEditor() {
  const { user, isAdmin } = await isCurrentUserAdmin();
  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  if (PLOT_EDITOR_REQUIRE_ADMIN && !isAdmin) {
    return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return {};
}

export async function GET() {
  const auth = await requirePlotEditor();
  if ("error" in auth) return auth.error;
  try {
    return NextResponse.json({ plot: await readSitePlot() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requirePlotEditor();
  if ("error" in auth) return auth.error;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const { plot, error } = validatePlotInput(body);
  if (!plot) {
    return NextResponse.json({ error: error ?? "Invalid plot." }, { status: 400 });
  }
  try {
    return NextResponse.json({ plot: await updateSitePlot(plot) });
  } catch (updateError) {
    return NextResponse.json({ error: (updateError as Error).message }, { status: 500 });
  }
}
