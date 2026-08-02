import { LiveDashboard } from "@/components/live/live-dashboard";
import { getCurrentUserProfile } from "@/lib/supabase/roles";

export default async function LivePage() {
  const { profile } = await getCurrentUserProfile();

  return <LiveDashboard isAdmin={profile?.is_admin ?? false} />;
}
