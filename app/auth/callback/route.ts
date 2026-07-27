import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const PENDING_INVITE_COOKIE = "pending_invite_code";

function redirectToLogin(origin: string, message: string) {
  const url = new URL("/login", origin);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

function normalizeInviteCode(value: string) {
  return value.trim().toUpperCase();
}

async function signOutAndDeleteUser(userId: string) {
  const supabase = await createClient();
  const supabaseAdmin = createAdminClient();
  await supabase.auth.signOut();
  await supabaseAdmin.auth.admin.deleteUser(userId);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const cookieStore = await cookies();
  const authError = searchParams.get("error");
  const authErrorDescription = searchParams.get("error_description");

  if (authError) {
    cookieStore.delete(PENDING_INVITE_COOKIE);
    return redirectToLogin(origin, authErrorDescription ?? authError);
  }

  const code = searchParams.get("code");

  if (!code) {
    cookieStore.delete(PENDING_INVITE_COOKIE);
    return redirectToLogin(origin, "Invalid OAuth response.");
  }

  const supabase = await createClient();
  const supabaseAdmin = createAdminClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    cookieStore.delete(PENDING_INVITE_COOKIE);
    return redirectToLogin(origin, error?.message ?? "Unable to complete sign in.");
  }

  const user = data.user;
  const pendingInviteCode = normalizeInviteCode(cookieStore.get(PENDING_INVITE_COOKIE)?.value ?? "");

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    cookieStore.delete(PENDING_INVITE_COOKIE);
    await signOutAndDeleteUser(user.id);
    return redirectToLogin(origin, "We could not verify your account. Please try again.");
  }

  const profilePayload = {
    id: user.id,
    email: user.email ?? null,
    full_name:
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      null,
    avatar_url: (user.user_metadata?.avatar_url as string | undefined) ?? null,
  };

  if (!profile) {
    if (!pendingInviteCode) {
      cookieStore.delete(PENDING_INVITE_COOKIE);
      await signOutAndDeleteUser(user.id);
      return redirectToLogin(origin, "An invite code is required to create a new account.");
    }

    const { error: claimError } = await supabaseAdmin.rpc("claim_invite_code", {
      p_code: pendingInviteCode,
      p_user_id: user.id,
      p_email: profilePayload.email,
      p_full_name: profilePayload.full_name,
      p_avatar_url: profilePayload.avatar_url,
    });

    if (claimError) {
      cookieStore.delete(PENDING_INVITE_COOKIE);
      await signOutAndDeleteUser(user.id);
      return redirectToLogin(origin, "Invalid or already used invite code.");
    }
  } else {
    const { error: updateError } = await supabaseAdmin
      .from("profiles")
      .upsert(profilePayload, { onConflict: "id" });

    if (updateError) {
      cookieStore.delete(PENDING_INVITE_COOKIE);
      await signOutAndDeleteUser(user.id);
      return redirectToLogin(origin, "We could not save your profile.");
    }
  }

  cookieStore.delete(PENDING_INVITE_COOKIE);
  return NextResponse.redirect(new URL("/home", origin));
}
