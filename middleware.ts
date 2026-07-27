import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.next();
  }

  const cookiesToSet: Array<{
    name: string;
    value: string;
    options?: any;
  }> = [];

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSetFromSupabase) {
        cookiesToSet.push(...cookiesToSetFromSupabase);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth");
  const isProtectedRoute =
    pathname === "/" ||
    pathname.startsWith("/home") ||
    pathname.startsWith("/live") ||
    pathname.startsWith("/history") ||
    pathname.startsWith("/settings");

  let response = NextResponse.next();

  if (!user && isProtectedRoute) {
    response = NextResponse.redirect(new URL("/login", request.url));
  } else if (user && isAuthRoute) {
    response = NextResponse.redirect(new URL("/home", request.url));
  } else if (pathname === "/") {
    response = NextResponse.redirect(new URL(user ? "/home" : "/login", request.url));
  }

  cookiesToSet.forEach(({ name, value, options }) => {
    response.cookies.set(name, value, options);
  });

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api).*)"],
};
