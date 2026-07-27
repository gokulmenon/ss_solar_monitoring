import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

type OAuthProvider = "google" | "github";

const PENDING_INVITE_COOKIE = "pending_invite_code";

function normalizeInviteCode(value: string) {
  return value.trim().toUpperCase();
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { provider?: string; inviteCode?: string }
    | null;

  const provider = body?.provider;
  const inviteCode = typeof body?.inviteCode === "string" ? normalizeInviteCode(body.inviteCode) : "";

  if (provider !== "google" && provider !== "github") {
    return NextResponse.json({ error: "Unsupported OAuth provider." }, { status: 400 });
  }

  const supabase = await createClient();
  const cookieStore = await cookies();

  if (inviteCode) {
    cookieStore.set(PENDING_INVITE_COOKIE, inviteCode, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    });
  }

  const origin = new URL(request.url).origin;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as OAuthProvider,
    options: {
      redirectTo: `${origin}/auth/callback`,
      queryParams: {
        prompt: "select_account",
      },
    },
  });

  if (error || !data.url) {
    cookieStore.delete(PENDING_INVITE_COOKIE);
    return NextResponse.json(
      { error: error?.message ?? "Failed to start OAuth." },
      { status: 400 },
    );
  }

  return NextResponse.json({ url: data.url });
}
