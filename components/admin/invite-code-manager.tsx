"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type InviteCode = {
  id: string;
  code: string;
  is_used: boolean;
  is_revoked: boolean;
  used_by_user_id: string | null;
  used_at: string | null;
  created_at: string;
};

function formatDateTime(value: string | null) {
  if (!value) return "—";

  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function statusLabel(code: InviteCode) {
  if (code.is_revoked) return "Revoked";
  if (code.is_used) return "Used";
  return "Active";
}

function statusVariant(code: InviteCode): "success" | "danger" | "warning" | "secondary" {
  if (code.is_revoked) return "danger";
  if (code.is_used) return "secondary";
  return "success";
}

export function InviteCodeManager() {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRotating, setIsRotating] = useState(false);
  const [busyCodeId, setBusyCodeId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [rotationMsg, setRotationMsg] = useState("");
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);

  const activeCodes = useMemo(
    () => codes.filter((code) => !code.is_used && !code.is_revoked),
    [codes],
  );

  const loadCodes = async () => {
    setIsLoading(true);
    setErrorMsg("");

    try {
      const response = await fetch("/api/admin/invite-codes", {
        cache: "no-store",
      });

      const payload = (await response.json()) as { codes?: InviteCode[]; error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load invite codes.");
      }

      setCodes(payload.codes ?? []);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "Failed to load invite codes.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadCodes();
  }, []);

  const rotateCodes = async () => {
    setIsRotating(true);
    setErrorMsg("");
    setRotationMsg("");

    try {
      const response = await fetch("/api/admin/invite-codes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const payload = (await response.json()) as { codes?: InviteCode[]; error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to rotate invite codes.");
      }

      const newCodes = payload.codes ?? [];
      setRotationMsg(
        newCodes.length === 5
          ? `Revoked unused active codes and created ${newCodes[0]?.code} through ${newCodes[4]?.code}.`
          : "Revoked unused active codes and created a new invite-code batch.",
      );
      await loadCodes();
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "Failed to rotate invite codes.");
    } finally {
      setIsRotating(false);
    }
  };

  const revokeCode = async (id: string) => {
    setBusyCodeId(id);
    setErrorMsg("");

    try {
      const response = await fetch(`/api/admin/invite-codes/${id}`, {
        method: "PATCH",
      });

      const payload = (await response.json()) as { code?: InviteCode; error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to revoke invite code.");
      }

      if (payload.code) {
        setCodes((previous) => previous.map((code) => (code.id === id ? payload.code! : code)));
      } else {
        await loadCodes();
      }
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "Failed to revoke invite code.");
    } finally {
      setBusyCodeId(null);
    }
  };

  const copyCode = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCodeId(id);
      window.setTimeout(() => setCopiedCodeId((current) => (current === id ? null : current)), 1500);
    } catch {
      setErrorMsg("Copy failed. You can select the code manually.");
    }
  };

  return (
    <Card className="border-sky-400/15 bg-slate-950/75">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-base">Admin key area</CardTitle>
            <CardDescription>
              Rotate five sequential invite codes for new OAuth sign-ups. Rotation revokes all unused active codes.
            </CardDescription>
          </div>

          <Button type="button" className="w-full sm:w-auto" onClick={rotateCodes} disabled={isRotating}>
            {isRotating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Rotate 5 invite codes
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {errorMsg ? (
          <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {errorMsg}
          </div>
        ) : null}

        {rotationMsg ? (
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
            {rotationMsg}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Active codes</p>
            <p className="mt-2 text-2xl font-semibold text-slate-50">{activeCodes.length}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Total codes</p>
            <p className="mt-2 text-2xl font-semibold text-slate-50">{codes.length}</p>
          </div>
        </div>

        {isLoading ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-slate-400">
            Loading invite codes...
          </div>
        ) : codes.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl border border-dashed border-sky-400/20 bg-sky-400/5 px-4 py-4 text-sm text-slate-300">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
            <p>No invite codes yet. Generate the first one to start onboarding new users.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {codes.map((code) => (
              <div
                key={code.id}
                className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-mono text-sm font-semibold tracking-[0.18em] text-slate-50">
                        {code.code}
                      </p>
                      <Badge variant={statusVariant(code)}>{statusLabel(code)}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                      Created {formatDateTime(code.created_at)}
                      {code.used_at ? ` · Used ${formatDateTime(code.used_at)}` : ""}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => copyCode(code.id, code.code)}
                    >
                      <Copy className="h-4 w-4" />
                      {copiedCodeId === code.id ? "Copied" : "Copy"}
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={code.is_used || code.is_revoked || busyCodeId === code.id}
                      onClick={() => revokeCode(code.id)}
                      className={cn(code.is_used || code.is_revoked ? "opacity-50" : "")}
                    >
                      {busyCodeId === code.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      Revoke
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
