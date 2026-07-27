import type { ReactNode } from "react";

export default function AuthLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <div className="mx-auto flex min-h-[100svh] w-full max-w-[560px] items-center px-4 py-8 sm:px-6 lg:px-8">
      <main className="w-full">{children}</main>
    </div>
  );
}
