import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/supabase/roles";

async function requireAdmin() {
  const { user, profile, isAdmin } = await isCurrentUserAdmin();

  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  }

  if (!profile || !isAdmin) {
    return { error: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }

  return { user };
}

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const supabaseAdmin = createAdminClient();

  const { data, error } = await supabaseAdmin
    .from("invite_codes")
    .update({
      is_revoked: true,
      revoked_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id,code,is_used,is_revoked,used_by_user_id,used_at,created_at,revoked_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ code: data });
}
