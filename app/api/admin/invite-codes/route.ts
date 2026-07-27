import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { isCurrentUserAdmin } from "@/lib/supabase/roles";

function generateInviteCode() {
  const segmentA = randomBytes(3).toString("hex").toUpperCase();
  const segmentB = randomBytes(3).toString("hex").toUpperCase();
  return `SOLAR-${segmentA}-${segmentB}`;
}

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

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const supabaseAdmin = createAdminClient();
  const { data, error } = await supabaseAdmin
    .from("invite_codes")
    .select("id,code,is_used,is_revoked,used_by_user_id,used_at,created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ codes: data ?? [] });
}

export async function POST() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const supabaseAdmin = createAdminClient();
  const code = generateInviteCode();

  const { data, error } = await supabaseAdmin
    .from("invite_codes")
    .insert({ code })
    .select("id,code,is_used,is_revoked,used_by_user_id,used_at,created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ code: data });
}
