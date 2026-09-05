import { HomeDashboard } from "@/components/home/home-dashboard";
import { getCurrentUserProfile } from "@/lib/supabase/roles";

export default async function HomePage() {
  const { profile } = await getCurrentUserProfile();

  return <HomeDashboard isAdmin={profile?.is_admin ?? false} />;
}
