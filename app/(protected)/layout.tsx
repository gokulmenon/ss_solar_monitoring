import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { ProtectedTopNav } from "@/components/app-shell/protected-top-nav";
import { createClient } from "@/lib/supabase/server";

export default async function ProtectedLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-[100svh]">
      <main className="mx-auto flex min-h-[100svh] w-full max-w-[430px] flex-col px-4 pb-8 pt-4 sm:max-w-[720px] sm:px-6 md:max-w-[960px] lg:max-w-[1180px] lg:px-8">
        <ProtectedTopNav />
        <div className="flex-1">{children}</div>
      </main>
    </div>
  );
}
