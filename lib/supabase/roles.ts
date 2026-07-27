import { createClient } from "@/lib/supabase/server";

export type CurrentProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
};

export async function getCurrentUserProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { user: null, profile: null };
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id,email,full_name,avatar_url,is_admin")
    .eq("id", user.id)
    .maybeSingle<CurrentProfile>();

  if (error) {
    throw error;
  }

  return {
    user,
    profile: profile ?? null,
  };
}

export async function isCurrentUserAdmin() {
  const { user, profile } = await getCurrentUserProfile();
  return {
    user,
    profile,
    isAdmin: profile?.is_admin ?? false,
  };
}
