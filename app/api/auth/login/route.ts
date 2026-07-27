import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

type OAuthProvider = "google" | "github";

const PENDING_INVITE_COOKIE = "pending_invite_code";

function normalizeInviteCode(value: string) {
  return value.trim().toUpperCase();
}

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
      return jsonError("Missing Supabase environment variables.");
    }

    const body = (await request.json().catch(() => null)) as
      | { provider?: string; inviteCode?: string }
      | null;

    const provider = body?.provider;
    const inviteCode = typeof body?.inviteCode === "string" ? normalizeInviteCode(body.inviteCode) : "";

    if (provider !== "google" && provider !== "github") {
      return jsonError("Unsupported OAuth provider.", 400);
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
      return jsonError(error?.message ?? "Failed to start OAuth.", 400);
    }

    return NextResponse.json({ url: data.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected login error.";
    return jsonError(message);
  }
}
