"use client";

import { Building, Check, ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROUTES } from "@/config/navigation";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useSwitchOrganisation } from "@/hooks/use-auth";
import type { CurrentUser } from "@/hooks/use-current-user";
import { getStatusMeta } from "@/components/status/statusMeta";

/** Organisation switcher; renders only when the manager belongs to more than one organisation. */
export function OrgSwitcher({ me }: { me: CurrentUser }) {
  const switchOrganisation = useSwitchOrganisation();
  const toastError = useApiErrorToast();
  if (me.organisations.length < 2) return null;

  const current = me.organisations.find((o) => o.id === me.currentOrganisationId) ?? me.organisations[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-48 justify-between gap-2"
          disabled={switchOrganisation.isPending}
          aria-label={`Switch organisation. Current: ${current?.name ?? "none"}`}
        >
          <Building aria-hidden="true" />
          <span className="truncate">{current?.name ?? "Select organisation"}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Organisations</DropdownMenuLabel>
        {me.organisations.map((org) => {
          const isCurrent = org.id === current?.id;
          return (
            <DropdownMenuItem
              key={org.id}
              disabled={switchOrganisation.isPending}
              onSelect={() => {
                if (isCurrent) return;
                switchOrganisation.mutate(org.id, {
                  onError: (error) => toastError(error, { title: "Couldn't switch organisation" }),
                });
              }}
              aria-current={isCurrent ? "true" : undefined}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{org.name}</span>
                <span className="text-muted-foreground text-xs">{getStatusMeta("role", org.role).label}</span>
              </span>
              {isCurrent ? <Check className="text-foreground" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={ROUTES.createOrganisation}>
            <Plus aria-hidden="true" />
            Create organisation
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
